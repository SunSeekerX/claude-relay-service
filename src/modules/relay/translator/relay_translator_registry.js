// 跨协议转换注册表：from→to 注册 request/response/stream 转换器
// 路由层只查表，不感知具体字段映射

import { buildTranslatorKey, TranslatorQuality } from './relay_translator_formats.js'
import { logger } from '../../../common/logger.js'

const registry = new Map()

/**
 * @typedef {object} TranslatorEntry
 * @property {string} from
 * @property {string} to
 * @property {string} [quality]
 * @property {(request: object, options?: object) => object} [convertRequest]
 * @property {(response: object, options?: object) => object} [convertResponse]
 * @property {(chunk: any, state: object, options?: object) => any} [convertStreamChunk]
 * @property {() => object} [createStreamState]
 */

export const registerTranslator = (entry) => {
  if (!entry || !entry.from || !entry.to) {
    throw new Error('registerTranslator requires from and to')
  }
  const key = buildTranslatorKey(entry.from, entry.to)
  const normalized = {
    quality: TranslatorQuality.fair,
    ...entry,
    key,
  }
  registry.set(key, normalized)
  return normalized
}

export const getTranslator = (from, to) => registry.get(buildTranslatorKey(from, to)) || null

export const hasTranslator = (from, to) => registry.has(buildTranslatorKey(from, to))

export const listTranslators = () =>
  Array.from(registry.values()).map((entry) => ({
    key: entry.key,
    from: entry.from,
    to: entry.to,
    quality: entry.quality,
    hasRequest: typeof entry.convertRequest === 'function',
    hasResponse: typeof entry.convertResponse === 'function',
    hasStream: typeof entry.convertStreamChunk === 'function',
  }))

export const translateRequest = (from, to, request, options = {}) => {
  const entry = getTranslator(from, to)
  if (!entry?.convertRequest) {
    const error = new Error(`No request translator for ${from} -> ${to}`)
    error.code = 'TRANSLATOR_NOT_FOUND'
    throw error
  }
  if (entry.quality === TranslatorQuality.discouraged) {
    logger.warn(`[translator] discouraged path ${entry.key}`)
  } else if (entry.quality === TranslatorQuality.fair) {
    logger.debug(`[translator] fair path ${entry.key}`)
  }
  logger.info(`[translator] request ${entry.key} quality=${entry.quality}`)
  return entry.convertRequest(request, options)
}

export const translateResponse = (from, to, response, options = {}) => {
  const entry = getTranslator(from, to)
  if (!entry?.convertResponse) {
    const error = new Error(`No response translator for ${from} -> ${to}`)
    error.code = 'TRANSLATOR_NOT_FOUND'
    throw error
  }
  return entry.convertResponse(response, options)
}

export const createTranslatorStreamState = (from, to, options = {}) => {
  const entry = getTranslator(from, to)
  if (entry?.createStreamState) {
    return entry.createStreamState(options)
  }
  return {}
}

export const translateStreamChunk = (from, to, chunk, state, options = {}) => {
  const entry = getTranslator(from, to)
  if (!entry?.convertStreamChunk) {
    const error = new Error(`No stream translator for ${from} -> ${to}`)
    error.code = 'TRANSLATOR_NOT_FOUND'
    throw error
  }
  return entry.convertStreamChunk(chunk, state, options)
}

// 组合路径：A→B→C（仅当直接路径不存在时）
export const translateRequestVia = (path, request, options = {}) => {
  if (!Array.isArray(path) || path.length < 2) {
    throw new Error('translateRequestVia requires path [from, ..., to]')
  }
  let current = request
  for (let index = 0; index < path.length - 1; index += 1) {
    current = translateRequest(path[index], path[index + 1], current, options)
  }
  return current
}
