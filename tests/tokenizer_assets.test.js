import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

const tokenConfig = {
  resourceRoot: '',
  dataRoot: '',
  workers: 1,
  queue: 12,
  maxTextBytes: 2097152,
  maxPendingBytes: 16777216,
  queueTimeoutMs: 250,
  countTimeoutMs: 2000,
}
const transport = { get: jest.fn() }
await jest.unstable_mockModule('../config/tokenizers.js', () => ({ tokenizerConfig: tokenConfig }))
await jest.unstable_mockModule('axios', () => ({ default: transport }))
const { performTokenizerAssetTask, getTokenizerResourceCatalog, containedAssetPath, getAppliedTokenizerAssets } =
  await import('../src/modules/tokenizer/tokenizer_assets.js')
const { runLocalTokenizer, closeTokenizerWorkers } = await import('../src/modules/tokenizer/tokenizer_count_pool.js')
afterAll(closeTokenizerWorkers)
let fixtureRoot
const goodData = Buffer.from(
  JSON.stringify({
    model: { type: 'WordPiece', unk_token: '[UNK]', vocab: { '[UNK]': 0, hello: 1, world: 2 } },
    pre_tokenizer: { type: 'Whitespace' },
    normalizer: null,
    post_processor: null,
    decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
    added_tokens: [],
  }),
)
const sha = crypto.createHash('sha256').update(goodData).digest('hex')
const originalManifest = { schemaVersion: 1, bundles: [] }
const plan = {
  schemaVersion: 1,
  huggingFaceFiles: ['tokenizer.json'],
  bundles: [
    {
      id: 'good',
      family: 'Fixture',
      format: 'huggingface',
      repository: 'fixture/tokenizer',
      revision: 'fixed-revision',
      models: ['fixture-model'],
      precision: 'official-text',
      files: [{ name: 'tokenizer.json', url: 'https://example.test/good', sha256: sha }],
    },
    {
      id: 'bad',
      family: 'Fixture',
      format: 'huggingface',
      repository: 'fixture/other',
      revision: 'fixed-revision',
      models: ['fixture-model'],
      precision: 'official-text',
      files: [{ name: 'tokenizer.json', url: 'https://example.test/bad', sha256: 'f'.repeat(64) }],
    },
  ],
}
beforeEach(async () => {
  const base = path.resolve('.agent_tmp/20261025_named_routes')
  await fs.mkdir(base, { recursive: true })
  fixtureRoot = await fs.mkdtemp(path.join(base, 'assets-'))
  tokenConfig.resourceRoot = path.join(fixtureRoot, 'resources')
  tokenConfig.dataRoot = path.join(fixtureRoot, 'installed')
  await fs.mkdir(tokenConfig.resourceRoot)
  await fs.writeFile(path.join(tokenConfig.resourceRoot, 'sources.json'), JSON.stringify(plan))
  await fs.writeFile(path.join(tokenConfig.resourceRoot, 'manifest.json'), JSON.stringify(originalManifest))
  transport.get.mockReset()
  transport.get.mockImplementation(async (url) =>
    url.includes('/commits?') ? { data: [{ sha: 'new-fixed-revision' }] } : { data: Readable.from([goodData]) },
  )
})
afterEach(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true })
})
const invoke = (ids, operation = 'download', extra = {}) =>
  performTokenizerAssetTask({
    ids,
    operation,
    signal: new AbortController().signal,
    progress: async () => {},
    assertOwnership: async () => {},
    ...extra,
  })

describe('tokenizer resource installation', () => {
  test('downloads multiple files concurrently, caps concurrency and commits only complete results', async () => {
    const files = Array.from({ length: 9 }, (_, index) => ({
      name: `part-${index}.txt`,
      url: `https://example.test/parallel-${index}`,
    }))
    const fixturePlan = { ...plan, bundles: [{ ...plan.bundles[0], files }] }
    await fs.writeFile(path.join(tokenConfig.resourceRoot, 'sources.json'), JSON.stringify(fixturePlan))
    let active = 0
    let peak = 0
    transport.get.mockImplementation(async (url, { signal }) => {
      active += 1
      peak = Math.max(peak, active)
      const stream = Readable.from(
        (async function* () {
          try {
            await new Promise((resolve) => setTimeout(resolve, 30))
            if (signal.aborted) {
              throw new Error('cancelled')
            }
            yield Buffer.from(url)
          } finally {
            active -= 1
          }
        })(),
      )
      return { data: stream }
    })
    const progress = []
    await invoke(['good'], 'download', { progress: async (_done, _total, _message, detail) => progress.push(detail) })
    expect(peak).toBe(4)
    expect(active).toBe(0)
    const saved = JSON.parse(await fs.readFile(path.join(tokenConfig.dataRoot, 'manifest.json'), 'utf8'))
    expect(saved.bundles[0].files.map((file) => file.name)).toEqual(files.map((file) => file.name))
    expect(progress.at(-1)).toMatchObject({
      filesCompleted: 9,
      filesTotal: 9,
      activeDownloads: 0,
      downloadConcurrency: 4,
    })
    expect(
      progress.every((value, index) => index === 0 || value.filesCompleted >= progress[index - 1].filesCompleted),
    ).toBe(true)
  })
  test('one parallel download failure cancels the other transfers and keeps the installed manifest', async () => {
    await fs.mkdir(tokenConfig.dataRoot, { recursive: true })
    const before = JSON.stringify({ schemaVersion: 1, bundles: [{ id: 'old', revision: 'original', files: [] }] })
    await fs.writeFile(path.join(tokenConfig.dataRoot, 'manifest.json'), before)
    await fs.writeFile(
      path.join(tokenConfig.resourceRoot, 'sources.json'),
      JSON.stringify({
        ...plan,
        bundles: [
          {
            ...plan.bundles[0],
            files: Array.from({ length: 6 }, (_, index) => ({
              name: `file-${index}.txt`,
              url: `https://example.test/file-${index}`,
            })),
          },
        ],
      }),
    )
    let aborted = 0
    transport.get.mockImplementation(async (url, { signal }) => {
      if (url.endsWith('file-0')) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        throw new Error('first file failed')
      }
      const stream = new Readable({ read() {} })
      signal.addEventListener(
        'abort',
        () => {
          aborted += 1
          stream.destroy(new Error('cancelled transfer'))
        },
        { once: true },
      )
      return { data: stream }
    })
    await expect(invoke(['good'])).rejects.toThrow('first file failed')
    expect(transport.get).toHaveBeenCalledTimes(4)
    expect(aborted).toBe(3)
    expect(await fs.readFile(path.join(tokenConfig.dataRoot, 'manifest.json'), 'utf8')).toBe(before)
    expect(await fs.readdir(path.join(tokenConfig.dataRoot, '.downloads'))).toEqual([])
  })
  test('user cancellation stops all active parallel files and never commits a partial manifest', async () => {
    await fs.writeFile(
      path.join(tokenConfig.resourceRoot, 'sources.json'),
      JSON.stringify({
        ...plan,
        bundles: [
          {
            ...plan.bundles[0],
            files: Array.from({ length: 8 }, (_, index) => ({
              name: `file-${index}.txt`,
              url: `https://example.test/file-${index}`,
            })),
          },
        ],
      }),
    )
    const controller = new AbortController()
    let running = 0
    transport.get.mockImplementation(async (_url, { signal }) => {
      running += 1
      const stream = new Readable({ read() {} })
      signal.addEventListener('abort', () => stream.destroy(new Error('词表任务已取消')), { once: true })
      if (running === 4) {
        setTimeout(() => controller.abort(), 10)
      }
      return { data: stream }
    })
    await expect(invoke(['good'], 'download', { signal: controller.signal })).rejects.toThrow()
    expect(running).toBe(4)
    await expect(fs.stat(path.join(tokenConfig.dataRoot, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(path.join(tokenConfig.dataRoot, '.downloads'))).toEqual([])
  })
  test('download, apply, count and update keep the active snapshot pinned until explicitly applied', async () => {
    await expect(invoke(['good'], 'apply')).rejects.toThrow('请先下载')
    await invoke(['good'])
    expect((await getAppliedTokenizerAssets()).bundles).toEqual([])
    await invoke(['good'], 'apply')
    const first = (await getAppliedTokenizerAssets()).bundles[0]
    expect(
      await runLocalTokenizer({ texts: ['hello world'], model: 'fixture-model', tokenizer: 'good', asset: first }),
    ).toMatchObject({ contentTokens: 2, revision: 'fixed-revision', vocabSha256: sha })
    await invoke(['good'], 'update')
    expect((await getAppliedTokenizerAssets()).bundles[0].revision).toBe('fixed-revision')
    await invoke(['good'], 'apply')
    expect((await getAppliedTokenizerAssets()).bundles[0].revision).toBe('new-fixed-revision')
    const before = await fs.readFile(path.join(tokenConfig.dataRoot, 'applied.json'), 'utf8')
    await fs.writeFile(path.join(tokenConfig.dataRoot, first.files[0].path), '{}')
    await expect(invoke(['good'], 'apply')).rejects.toThrow('请先下载')
    expect(await fs.readFile(path.join(tokenConfig.dataRoot, 'applied.json'), 'utf8')).toBe(before)
  })
  test('a successful HTTP status containing a block page is not installed as a resource', async () => {
    transport.get.mockResolvedValue({
      data: Readable.from(['<html>blocked</html>']),
      headers: { 'content-type': 'text/html' },
    })
    await expect(invoke(['good'])).rejects.toThrow('HTML')
    await expect(fs.stat(path.join(tokenConfig.dataRoot, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('source checks reject success responses without a valid revision', async () => {
    transport.get.mockResolvedValue({ data: [] })
    await expect(invoke(['good'], 'check-updates')).rejects.toThrow('版本信息无效')
  })
  test('commits content-addressed verified files and reports actual local presence', async () => {
    const missing = await getTokenizerResourceCatalog()
    expect(missing[0].status).toBe('missing')
    await invoke(['good'])
    const manifest = JSON.parse(await fs.readFile(path.join(tokenConfig.dataRoot, 'manifest.json'), 'utf8'))
    expect(manifest.bundles[0]).toMatchObject({ id: 'good', revision: 'fixed-revision', status: 'complete' })
    expect(manifest.bundles[0].files[0]).toMatchObject({ sha256: sha, path: `blobs/${sha}.json` })
    const catalog = await getTokenizerResourceCatalog()
    expect(catalog[0].status).toBe('available')
    await fs.writeFile(path.join(tokenConfig.dataRoot, `blobs/${sha}.json`), '{}')
    expect((await getTokenizerResourceCatalog())[0].status).toBe('failed')
  })

  test('one checksum failure preserves the previous manifest for the whole selected batch', async () => {
    await fs.mkdir(tokenConfig.dataRoot)
    const before = JSON.stringify(originalManifest)
    await fs.writeFile(path.join(tokenConfig.dataRoot, 'manifest.json'), before)
    await expect(invoke(['good', 'bad'])).rejects.toThrow('SHA256')
    expect(await fs.readFile(path.join(tokenConfig.dataRoot, 'manifest.json'), 'utf8')).toBe(before)
  })

  test('cancellation after downloading a file cannot switch the current manifest', async () => {
    await fs.mkdir(tokenConfig.dataRoot)
    const before = JSON.stringify(originalManifest)
    await fs.writeFile(path.join(tokenConfig.dataRoot, 'manifest.json'), before)
    const controller = new AbortController()
    await expect(
      invoke(['good'], 'download', { signal: controller.signal, progress: async () => controller.abort() }),
    ).rejects.toThrow('取消')
    expect(await fs.readFile(path.join(tokenConfig.dataRoot, 'manifest.json'), 'utf8')).toBe(before)
  })

  test('read-only source checks never create an installed resource directory', async () => {
    const result = await invoke(['good'], 'check-updates')
    expect(result.updates).toEqual([{ id: 'good', latestRevision: 'new-fixed-revision' }])
    await expect(fs.stat(tokenConfig.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('unknown resources and paths outside the managed directory are rejected', async () => {
    await expect(invoke(['unknown'])).rejects.toThrow('来源清单')
    expect(() => containedAssetPath(tokenConfig.dataRoot, '../outside')).toThrow('越过')
    expect(transport.get).not.toHaveBeenCalled()
  })
})

test('applied vocabularies survive root moves and legacy Windows absolute paths on real counting workers', async () => {
  await invoke(['good'])
  await invoke(['good'], 'apply')
  const first = (await getAppliedTokenizerAssets()).bundles[0]
  expect(first.files[0].path).toMatch(/^blobs\//)
  expect(first.files[0].filename).toBeUndefined()
  const previousRoot = tokenConfig.dataRoot
  tokenConfig.dataRoot = path.join(fixtureRoot, 'mounted-data')
  await fs.cp(previousRoot, tokenConfig.dataRoot, { recursive: true })
  await fs.rm(previousRoot, { recursive: true })
  const count = (asset) => runLocalTokenizer({ texts: ['hello world'], model: 'fixture-model', tokenizer: 'good', asset })
  expect(await count(first)).toMatchObject({ contentTokens: 2, vocabSha256: sha })
  await closeTokenizerWorkers()
  const legacy = { ...first, files: first.files.map(({ path: relative, ...file }) => ({ ...file, filename: 'D:\\old-machine\\data\\tokenizers\\' + relative.replaceAll('/', '\\') })) }
  expect(await count(legacy)).toMatchObject({ contentTokens: 2, vocabSha256: sha })
})
