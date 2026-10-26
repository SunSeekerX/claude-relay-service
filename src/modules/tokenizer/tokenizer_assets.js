import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Worker } from 'node:worker_threads'
import axios from 'axios'
import { tokenizerConfig } from '../../../config/tokenizers.js'
import { timedUpstreamRequest } from '../../common/request_timing.js'
import { runLocalTokenizer } from './tokenizer_count_pool.js'
import { LIMITS } from '../../infra/redis_key.js'

const MAX_FILE_BYTES = 64 * 1024 * 1024
const verifiedFiles = new Map()
export const localTokenizerFormats = ['ctok', 'tiktoken', 'huggingface', 'sentencepiece']

export const getAppliedTokenizerAssets = async () =>
  readTokenizerJson(path.join(tokenizerConfig.dataRoot, 'applied.json'), { schemaVersion: 1, bundles: [] })

const writeTokenizerManifest = async (name, document, assertOwnership) => {
  const target = path.join(tokenizerConfig.dataRoot, name)
  const staged = path.join(tokenizerConfig.dataRoot, `.${crypto.randomUUID()}.${name}`)
  await fs.writeFile(staged, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' })
  try {
    try {
      await fs.copyFile(target, path.join(tokenizerConfig.dataRoot, `.previous-${name}`))
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
    await assertOwnership()
    await fs.rename(staged, target)
  } finally {
    await fs.rm(staged, { force: true })
  }
}

export const containedAssetPath = (root, relative) => {
  const result = path.resolve(root, relative)
  const remaining = path.relative(path.resolve(root), result)
  if (remaining.startsWith('..') || path.isAbsolute(remaining)) {
    throw new Error('词表文件路径越过资源目录')
  }
  return result
}

export const readTokenizerJson = async (filename, fallback = undefined) => {
  try {
    const stat = await fs.stat(filename)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
      throw new Error('词表清单类型或大小无效')
    }
    return JSON.parse(await fs.readFile(filename, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) {
      return fallback
    }
    throw error
  }
}

export const loadTokenizerAssets = async () => {
  const plan = await readTokenizerJson(path.join(tokenizerConfig.resourceRoot, 'sources.json'))
  const baseline = await readTokenizerJson(path.join(tokenizerConfig.resourceRoot, 'manifest.json'))
  const installed = await readTokenizerJson(path.join(tokenizerConfig.dataRoot, 'manifest.json'), {
    schemaVersion: 1,
    bundles: [],
  })
  for (const document of [plan, baseline, installed]) {
    if (document.schemaVersion !== 1 || !Array.isArray(document.bundles) || document.bundles.length > 64) {
      throw new Error('词表清单版本或资源数量无效')
    }
    if (
      document.bundles.some(
        (bundle) =>
          !bundle ||
          typeof bundle.id !== 'string' ||
          (bundle.files !== undefined && (!Array.isArray(bundle.files) || bundle.files.length > 128)),
      )
    ) {
      throw new Error('词表资源条目或文件数量无效')
    }
  }
  return { plan, baseline, installed }
}

export const hashTokenizerFile = async (filename) => {
  const stat = await fs.lstat(filename)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) {
    throw new Error('词表文件类型或大小无效')
  }
  const signature = `${stat.mtimeMs}:${stat.size}`
  const cached = verifiedFiles.get(filename)
  if (cached?.signature === signature) {
    return cached.hashes
  }
  const sha256 = crypto.createHash('sha256')
  const gitBlob = crypto.createHash('sha1').update(`blob ${stat.size}\0`)
  let sizeBytes = 0
  for await (const chunk of createReadStream(filename)) {
    sha256.update(chunk)
    gitBlob.update(chunk)
    sizeBytes += chunk.length
  }
  if (sizeBytes !== stat.size) {
    throw new Error('词表文件在校验时发生变化')
  }
  const hashes = { sha256: sha256.digest('hex'), gitBlobSha1: gitBlob.digest('hex'), sizeBytes }
  if (verifiedFiles.size >= 256) {
    verifiedFiles.clear()
  }
  verifiedFiles.set(filename, { signature, hashes })
  return hashes
}

const remoteJson = async (url, signal) =>
  (
    await timedUpstreamRequest(null, () =>
      axios.get(url, {
        signal,
        timeout: 30000,
        maxContentLength: 4 * 1024 * 1024,
        headers: { 'User-Agent': 'claude-relay-tokenizer-assets/1' },
      }),
    )
  ).data

const checkedRevision = (value) => {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new Error('来源版本信息无效')
  }
  return value
}

export const latestTokenizerRevision = async (bundle, signal) => {
  if (bundle.releaseAsset) {
    return checkedRevision(
      (await remoteJson(`https://api.github.com/repos/${bundle.repository}/releases/latest`, signal)).tag_name,
    )
  }
  if (bundle.files) {
    return checkedRevision(
      (await remoteJson(`https://api.github.com/repos/${bundle.repository}/commits?per_page=1`, signal))[0]?.sha,
    )
  }
  return checkedRevision((await remoteJson(`https://huggingface.co/api/models/${bundle.repository}`, signal)).sha)
}

export const getTokenizerResourceCatalog = async () => {
  const { plan, installed } = await loadTokenizerAssets()
  return await Promise.all(
    plan.bundles.map(async (bundle) => {
      const local = installed.bundles.find((item) => item.id === bundle.id)
      const files = []
      for (const asset of local?.files ?? []) {
        try {
          const hashes = await hashTokenizerFile(containedAssetPath(tokenizerConfig.dataRoot, asset.path))
          files.push({
            name: asset.name,
            sha256: hashes.sha256,
            expectedSha256: asset.sha256,
            sizeBytes: hashes.sizeBytes,
            status: hashes.sha256 === asset.sha256 ? 'available' : 'failed',
          })
        } catch (error) {
          files.push({
            name: asset.name,
            expectedSha256: asset.sha256,
            status: error.code === 'ENOENT' ? 'missing' : 'failed',
            message: error.message,
          })
        }
      }
      return {
        id: bundle.id,
        name: bundle.repository,
        family: bundle.family,
        format: bundle.format,
        models: bundle.models,
        precision: bundle.precision,
        notes: bundle.notes ?? '',
        sourceUrl: `${bundle.files || bundle.releaseAsset ? 'https://github.com/' : 'https://huggingface.co/'}${bundle.repository}`,
        recommendedRevision: bundle.revision,
        currentRevision: local?.revision ?? '',
        updatedAt: local?.downloadedAt ?? null,
        files,
        status:
          !local || files.length === 0
            ? 'missing'
            : files.every((asset) => asset.status === 'available')
              ? 'available'
              : 'failed',
        engine: localTokenizerFormats.includes(bundle.format) ? 'local' : 'reference',
      }
    }),
  )
}

const inspectDownloadedAsset = async (filename, name, signal) => {
  if (!name.endsWith('.json') && !name.endsWith('.tiktoken')) {
    return
  }
  await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./tokenizer_asset_inspect_worker.js', import.meta.url), {
      workerData: { filename, name },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
    const cancel = () => {
      worker.terminate().catch(reject)
      reject(new Error('词表任务已取消'))
    }
    const timer = setTimeout(() => {
      worker.terminate().catch(reject)
      reject(new Error('词表结构校验超时'))
    }, 30000)
    signal?.addEventListener('abort', cancel, { once: true })
    worker.once('message', (message) => (message.ok ? resolve() : reject(new Error(message.error))))
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error('词表结构校验进程异常退出'))
      }
    })
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
    worker.once('exit', finish)
  })
}

const downloadTokenizerFile = async (asset, temporary, signal) => {
  if (asset.sha256 !== undefined && asset.sha256 !== null && !/^[0-9a-f]{64}$/.test(asset.sha256)) {
    throw new Error('来源 SHA256 无效')
  }
  if (asset.gitBlobSha1 !== undefined && asset.gitBlobSha1 !== null && !/^[0-9a-f]{40}$/.test(asset.gitBlobSha1)) {
    throw new Error('来源 Git blob SHA1 无效')
  }
  const url = new URL(asset.url)
  if (url.protocol !== 'https:') {
    throw new Error('词表来源必须使用 HTTPS')
  }
  const suffix = path.extname(asset.name) || '.txt'
  if (asset.sha256) {
    const existing = containedAssetPath(tokenizerConfig.dataRoot, `blobs/${asset.sha256}${suffix}`)
    try {
      const hashes = await hashTokenizerFile(existing)
      if (hashes.sha256 === asset.sha256) {
        return { path: `blobs/${asset.sha256}${suffix}`, ...hashes }
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !error.message.includes('大小')) {
        throw error
      }
    }
  }
  const staged = path.join(temporary, `${crypto.randomUUID()}.download`)
  try {
    const response = await timedUpstreamRequest(null, () =>
      axios.get(asset.url, {
        responseType: 'stream',
        signal,
        timeout: 45000,
        headers: { 'User-Agent': 'claude-relay-tokenizer-assets/1' },
      }),
    )
    let bytes = 0
    if (
      String(response.headers?.['content-type'] ?? '')
        .toLowerCase()
        .includes('text/html')
    ) {
      response.data.destroy()
      throw new Error('词表来源返回 HTML 页面而非资源')
    }
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        callback(bytes > MAX_FILE_BYTES ? new Error('单个词表资源不能超过 64 MiB') : null, chunk)
      },
    })
    await pipeline(response.data, limiter, createWriteStream(staged, { flags: 'wx' }), { signal })
    const hashes = await hashTokenizerFile(staged)
    if (asset.sha256 && hashes.sha256 !== asset.sha256) {
      throw new Error('来源 SHA256 不匹配')
    }
    if (asset.gitBlobSha1 && hashes.gitBlobSha1 !== asset.gitBlobSha1) {
      throw new Error('来源 Git blob 不匹配')
    }
    await inspectDownloadedAsset(staged, asset.name, signal)
    const relative = `blobs/${hashes.sha256}${suffix}`
    await fs.rename(staged, containedAssetPath(tokenizerConfig.dataRoot, relative))
    return { path: relative, ...hashes }
  } finally {
    await fs.rm(staged, { force: true })
  }
}

const resolveTokenizerFiles = async (bundle, previous, plan, signal) => {
  if (previous?.status === 'complete' && previous.revision === bundle.revision) {
    return {
      files: previous.files.map((asset) => ({
        name: asset.name,
        url: asset.sourceURL,
        sha256: asset.sha256,
        gitBlobSha1: asset.gitBlobSha1,
      })),
      sourceURL: previous.sourceURL,
      license: previous.license,
    }
  }
  if (bundle.releaseAsset) {
    const release = await remoteJson(
      `https://api.github.com/repos/${bundle.repository}/releases/tags/${encodeURIComponent(bundle.revision)}`,
      signal,
    )
    if (release.tag_name !== bundle.revision) {
      throw new Error('运行库 release 版本不一致')
    }
    const name = bundle.releaseAsset.replace('{version}', bundle.revision.replace(/^v/, ''))
    const matches = release.assets.filter((asset) => asset.name === name)
    if (matches.length !== 1 || !matches[0].digest?.startsWith('sha256:')) {
      throw new Error('来源没有提供唯一发布资源及 SHA256')
    }
    return {
      sourceURL: release.html_url,
      files: [{ name, url: matches[0].browser_download_url, sha256: matches[0].digest.slice(7) }],
    }
  }
  if (bundle.files) {
    return {
      sourceURL: `https://github.com/${bundle.repository}/tree/${bundle.revision}`,
      files: bundle.files.map((asset) => ({
        ...asset,
        url: asset.url ?? `https://raw.githubusercontent.com/${bundle.repository}/${bundle.revision}/${asset.path}`,
      })),
    }
  }
  const metadata = await remoteJson(
    `https://huggingface.co/api/models/${bundle.repository}/revision/${bundle.revision}?blobs=true`,
    signal,
  )
  if (metadata.sha !== bundle.revision) {
    throw new Error('来源 revision 不一致')
  }
  const files = metadata.siblings
    .filter((asset) => plan.huggingFaceFiles.includes(asset.rfilename))
    .map((asset) => ({
      name: asset.rfilename,
      url: `https://huggingface.co/${bundle.repository}/resolve/${bundle.revision}/${encodeURIComponent(asset.rfilename)}`,
      sha256: asset.lfs?.sha256,
      gitBlobSha1: asset.lfs ? undefined : asset.blobId,
    }))
  if (!files.some((asset) => asset.name.includes('tokenizer') && asset.name !== 'tokenizer_config.json')) {
    throw new Error('来源没有公开词表')
  }
  return {
    sourceURL: `https://huggingface.co/${bundle.repository}/tree/${bundle.revision}`,
    license: metadata.cardData?.license ?? '见来源模型卡',
    files,
  }
}

export const performTokenizerAssetTask = async ({ ids, operation, signal, progress, assertOwnership }) => {
  const { plan, baseline, installed } = await loadTokenizerAssets()
  const selected = plan.bundles.filter((bundle) => ids.includes(bundle.id))
  if (selected.length !== ids.length || selected.length === 0) {
    throw new Error('请选择来源清单内的词表资源')
  }
  const updates = []
  if (operation === 'check-updates') {
    for (const bundle of selected) {
      updates.push({ id: bundle.id, latestRevision: await latestTokenizerRevision(bundle, signal) })
      await progress(updates.length, selected.length, `已检查 ${bundle.id}`)
    }
    return { updates }
  }
  if (operation === 'verify') {
    const catalog = await getTokenizerResourceCatalog()
    const rows = catalog.filter((row) => ids.includes(row.id))
    if (rows.some((row) => row.status !== 'available')) {
      throw new Error('所选资源存在缺失或校验失败的文件')
    }
    return { verified: rows.map((row) => row.id) }
  }
  if (operation === 'apply') {
    const catalog = await getTokenizerResourceCatalog()
    const previous = await getAppliedTokenizerAssets()
    const bundles = []
    for (const bundle of selected) {
      if (!localTokenizerFormats.includes(bundle.format)) {
        throw new Error(`${bundle.id} 当前不能用于本地计数`)
      }
      if (catalog.find((row) => row.id === bundle.id)?.status !== 'available') {
        throw new Error(`${bundle.id} 请先下载并通过校验`)
      }
      const downloaded = installed.bundles.find((entry) => entry.id === bundle.id)
      const asset = {
        id: bundle.id,
        format: bundle.format,
        models: bundle.models,
        precision: bundle.precision,
        revision: downloaded.revision,
        files: downloaded.files.map((file) => ({
          name: file.name,
          sha256: file.sha256,
          path: file.path,
        })),
      }
      for (const tokenizer of bundle.format === 'tiktoken'
        ? ['openai_o200k_base', 'openai_cl100k_base']
        : [bundle.id]) {
        await runLocalTokenizer({ asset, tokenizer, texts: [], validateOnly: true }, { timeoutMs: 30000 })
      }
      bundles.push(asset)
      await progress(bundles.length, selected.length, `已验证可应用 ${bundle.id}`)
    }
    if (signal.aborted) {
      throw new Error('词表任务已取消')
    }
    await writeTokenizerManifest(
      'applied.json',
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        bundles: [...previous.bundles.filter((bundle) => !ids.includes(bundle.id)), ...bundles],
      },
      assertOwnership,
    )
    return { applied: ids }
  }
  await fs.mkdir(path.join(tokenizerConfig.dataRoot, 'blobs'), { recursive: true })
  const temporary = path.join(tokenizerConfig.dataRoot, '.downloads')
  await fs.mkdir(temporary, { recursive: true })
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    bundles: installed.bundles.filter((bundle) => !ids.includes(bundle.id)),
  }
  const downloads = []
  for (const original of selected) {
    if (signal.aborted) {
      throw new Error('词表任务已取消')
    }
    const bundle = { ...original }
    const previous =
      installed.bundles.find((entry) => entry.id === bundle.id) ??
      baseline.bundles.find((entry) => entry.id === bundle.id)
    bundle.revision =
      operation === 'update' ? await latestTokenizerRevision(bundle, signal) : (previous?.revision ?? bundle.revision)
    const resolved = await resolveTokenizerFiles(bundle, previous, plan, signal)
    const files = new Array(resolved.files.length)
    resolved.files.forEach((asset, index) => downloads.push({ asset, bundleId: bundle.id, index, files }))
    manifest.bundles.push({ ...bundle, ...resolved, files, status: 'complete', downloadedAt: new Date().toISOString() })
  }
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('词表任务已取消'))
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) {
    cancel()
  }
  let cursor = 0
  let completedFiles = 0
  let activeDownloads = 0
  let failure = null
  let reporting = Promise.resolve()
  const report = (message) => {
    const completed = manifest.bundles.filter(
      (bundle) => ids.includes(bundle.id) && bundle.files.filter(Boolean).length === bundle.files.length,
    ).length
    const detail = {
      filesCompleted: completedFiles,
      filesTotal: downloads.length,
      activeDownloads,
      downloadConcurrency: LIMITS.tokenizerDownloads,
    }
    reporting = reporting.then(() => progress(completed, selected.length, message, detail))
    return reporting
  }
  const downloadNext = async () => {
    while (!controller.signal.aborted && cursor < downloads.length) {
      const job = downloads[cursor++]
      activeDownloads += 1
      try {
        await assertOwnership()
        await report(`正在下载 ${job.bundleId} / ${job.asset.name}`)
        if (controller.signal.aborted) {
          throw new Error('词表任务已取消')
        }
        const downloaded = await downloadTokenizerFile(job.asset, temporary, controller.signal)
        job.files[job.index] = { name: job.asset.name, sourceURL: job.asset.url, ...downloaded }
        completedFiles += 1
      } catch (error) {
        if (!failure) {
          failure = error
        }
        controller.abort(error)
      } finally {
        activeDownloads -= 1
      }
      if (!controller.signal.aborted) {
        try {
          await report(`已完成 ${completedFiles} / ${downloads.length} 个文件`)
        } catch (error) {
          if (!failure) {
            failure = error
          }
          controller.abort(error)
        }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(LIMITS.tokenizerDownloads, downloads.length) }, downloadNext))
    await reporting.catch((error) => {
      if (!failure) {
        failure = error
      }
    })
    if (failure) {
      throw failure
    }
    if (controller.signal.aborted) {
      throw new Error('词表任务已取消')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
  if (signal.aborted) {
    throw new Error('词表任务已取消')
  }
  await assertOwnership()
  await writeTokenizerManifest('manifest.json', manifest, assertOwnership)
  return { installed: selected.map((bundle) => bundle.id) }
}
