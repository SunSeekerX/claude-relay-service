import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'

try {
  const text = readFileSync(workerData.filename, 'utf8')
  if (workerData.name.endsWith('.json')) {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object') {
      throw new Error('词表 JSON 结构无效')
    }
    if (
      workerData.name === 'tokenizer.json' &&
      (!value.model || !['BPE', 'Unigram', 'WordPiece', 'WordLevel'].includes(value.model.type))
    ) {
      throw new Error('词表没有可识别的分词模型')
    }
    if (workerData.name === 'tokenizer.json') {
      const vocabulary = value.model.vocab
      if (!vocabulary || typeof vocabulary !== 'object' || Object.keys(vocabulary).length === 0) {
        throw new Error('词表词条为空或结构无效')
      }
    }
  } else {
    const lines = text.trim().split('\n')
    if (lines.length === 0 || lines.some((line) => !/^[A-Za-z0-9+/]+=* \d+\s*$/.test(line))) {
      throw new Error('BPE ranks 格式无效')
    }
  }
  parentPort.postMessage({ ok: true })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message })
}
