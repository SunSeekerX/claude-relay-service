import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const require = createRequire(import.meta.url)
const definitions = new Map()
export const openaiModelMappings = JSON.parse(
  readFileSync(new URL('../../../resources/tokenizers/openai_model_mappings.json', import.meta.url), 'utf8'),
)
export const tokenizerForOpenaiModel = (model) => {
  const name = model.toLowerCase()
  const encoding =
    openaiModelMappings.exact[name] ??
    Object.entries(openaiModelMappings.prefix).find(([prefix]) => name.startsWith(prefix))?.[1]
  return { o200k_base: 'openai_o200k_base', cl100k_base: 'openai_cl100k_base' }[encoding] ?? null
}
export const loadBpeDefinition = (encoding) => {
  if (!['o200k_base', 'cl100k_base'].includes(encoding)) {
    throw new Error('不支持的 BPE 编码')
  }
  if (!definitions.has(encoding)) {
    const ranks = require(`js-tiktoken/ranks/${encoding}`)
    const packageFile = path.join(path.dirname(require.resolve('js-tiktoken')), '..', 'package.json')
    const { version } = JSON.parse(readFileSync(packageFile, 'utf8'))
    const table = new Map()
    for (const block of ranks.bpe_ranks.split('\n').filter(Boolean)) {
      const [, offsetText, ...tokens] = block.split(' ')
      const offset = Number(offsetText)
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('BPE ranks offset 无效')
      }
      tokens.forEach((token, index) => table.set(offset + index, token))
    }
    const hash = crypto.createHash('sha256')
    let sizeBytes = 0
    for (const [rank, token] of [...table.entries()].sort(([left], [right]) => left - right)) {
      const line = `${token} ${rank}\n`
      hash.update(line)
      sizeBytes += Buffer.byteLength(line)
    }
    definitions.set(encoding, {
      ranks,
      version: `js-tiktoken-${version}`,
      sha256: hash.digest('hex'),
      sizeBytes,
    })
  }
  return definitions.get(encoding)
}
