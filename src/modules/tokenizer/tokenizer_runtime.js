import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Tokenizer } from '@huggingface/tokenizers'
import { Tiktoken } from 'js-tiktoken/lite'
import { loadBpeDefinition } from './tokenizer_bpe.js'
import { tokenizerConfig } from '../../../config/tokenizers.js'
import { tokenizerAssetPath } from '../../common/compat_tokenizer_path.js'

let cached = null

export const loadAppliedTokenizer = async (asset, tokenizer, root = tokenizerConfig.dataRoot) => {
  const key = JSON.stringify([tokenizer, asset, root])
  if (cached?.key === key) {
    return cached.value
  }
  cached?.value.dispose?.()
  cached = null
  const files = new Map()
  for (const file of asset.files) {
    const filename = tokenizerAssetPath(file, root)
    const content = readFileSync(filename)
    if (createHash('sha256').update(content).digest('hex') !== file.sha256) {
      throw new Error(`应用词表校验失败: ${file.name}`)
    }
    files.set(file.name, { ...file, filename, content })
  }
  let value
  if (asset.format === 'ctok') {
    if (!files.has('pieces_v3.json') || !files.has('pieces_v4_7.json')) {
      throw new Error('Claude 词表文件不完整')
    }
    for (const name of ['pieces_v3.json', 'pieces_v4_7.json']) {
      if (!JSON.parse(files.get(name).content).tokens) {
        throw new Error('Claude 词表结构无效')
      }
    }
    value = { ctokFiles: Object.fromEntries([...files].map(([name, file]) => [name, file.filename])) }
  } else if (asset.format === 'tiktoken') {
    const encoding = tokenizer === 'openai_cl100k_base' ? 'cl100k_base' : 'o200k_base'
    const file = files.get(`${encoding}.tiktoken`)
    if (!file) {
      throw new Error('OpenAI 词表文件不完整')
    }
    const baseline = loadBpeDefinition(encoding)
    const bpe_ranks = file.content
      .toString('utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const [token, rank] = line.split(' ')
        return `1 ${rank} ${token}`
      })
      .join('\n')
    const encoder = new Tiktoken({ ...baseline.ranks, bpe_ranks })
    value = { count: (text) => encoder.encode(text, [], []).length, sha256: file.sha256 }
  } else if (asset.format === 'huggingface') {
    const file = files.get('tokenizer.json')
    if (!file) {
      throw new Error('资源没有可用的 tokenizer.json')
    }
    const config = files.get('tokenizer_config.json')
    const encoder = new Tokenizer(JSON.parse(file.content), config ? JSON.parse(config.content) : {})
    value = { count: (text) => encoder.encode(text, { add_special_tokens: false }).ids.length, sha256: file.sha256 }
  } else if (asset.format === 'sentencepiece') {
    const file = files.get('tokenizer.model')
    if (!file) {
      throw new Error('资源没有可用的 tokenizer.model')
    }
    const { SentencePieceProcessor } = await import('@agnai/sentencepiece-js')
    const encoder = new SentencePieceProcessor()
    await encoder.load(file.filename)
    value = {
      count: (text) => encoder.encodeIds(text).length,
      sha256: file.sha256,
      dispose: () => encoder.processor.delete(),
    }
  } else {
    throw new Error('当前本地引擎尚未支持此词表格式')
  }
  if (value.count) {
    value.count('hello')
  }
  cached = { key, value }
  return value
}
