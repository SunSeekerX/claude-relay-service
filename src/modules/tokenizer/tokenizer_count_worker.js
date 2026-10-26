import { parentPort } from 'node:worker_threads'
import { Tiktoken } from 'js-tiktoken/lite'
import {
  countContentCtok,
  ctokVocabularyHash,
  ctokCacheModelKey,
  ctokVersion,
  setCtokVocabularyFiles,
} from './tokenizer_ctok.js'
import { loadBpeDefinition } from './tokenizer_bpe.js'
import { loadAppliedTokenizer } from './tokenizer_runtime.js'

const encodings = new Map()
parentPort.on('message', async ({ texts, model, tokenizer, asset, assetRoot, validateOnly }) => {
  try {
    const applied = asset ? await loadAppliedTokenizer(asset, tokenizer, assetRoot) : null
    setCtokVocabularyFiles(applied?.ctokFiles ?? {})
    if (validateOnly) {
      if (applied?.ctokFiles) {
        for (const referenceModel of ['claude-opus-4-5', 'claude-opus-4-7']) {
          if (countContentCtok('hello', referenceModel) < 0) {
            throw new Error('Claude 词表不能用于当前 ctok 算法')
          }
        }
      }
      parentPort.postMessage({ ok: true })
      return
    }
    let tokens = 0
    let vocabularySha256
    let revision
    let profile
    if (tokenizer === 'claude_ctok') {
      for (const text of texts) {
        const count = countContentCtok(text, model)
        if (count < 0) {
          throw new Error('ctok 不支持此模型或词表不可用')
        }
        tokens += count
      }
      vocabularySha256 = ctokVocabularyHash(model)
      revision = ctokVersion
      profile = ctokCacheModelKey(model)
    } else if (applied?.count) {
      for (const text of texts) {
        tokens += applied.count(text)
      }
      vocabularySha256 = applied.sha256
      profile = asset.id
    } else {
      const encoding = { openai_o200k_base: 'o200k_base', openai_cl100k_base: 'cl100k_base' }[tokenizer]
      if (!encoding) {
        throw new Error('此词表尚未下载并应用，或当前格式不受支持')
      }
      if (!encodings.has(encoding)) {
        const definition = loadBpeDefinition(encoding)
        encodings.set(encoding, {
          encoder: new Tiktoken(definition.ranks),
          hash: definition.sha256,
          version: definition.version,
        })
      }
      const entry = encodings.get(encoding)
      for (const text of texts) {
        tokens += entry.encoder.encode(text, [], []).length
      }
      vocabularySha256 = entry.hash
      revision = entry.version
      profile = encoding
    }
    parentPort.postMessage({
      ok: true,
      contentTokens: tokens,
      vocabSha256: vocabularySha256,
      revision: asset?.revision ?? revision,
      precision: asset?.precision,
      profile,
      engine: 'node',
      tokenizer,
      scope: 'visible-text',
    })
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.message })
  }
})
