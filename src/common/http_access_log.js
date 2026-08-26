import chalk from 'chalk'
import { env } from '../../config/env.js'
// HTTP 访问日志：人类可读摘要（对齐 llysc http_logger / request_body_log 思路）
// - 大数组/大对象不整包 dump
// - messages/input 等 AI 请求体压成计数摘要
// - 控制台与文件都走摘要（文件可稍宽）

const isDev = () => env.NODE_ENV === 'development' || env.NODE_ENV === 'dev' || env.APP_ENV === 'development'

const CONSOLE_MAX_STRING = () => (isDev() ? 400 : 200)
const CONSOLE_MAX_DEPTH = 3
const CONSOLE_ARRAY_PREVIEW = 2
const FILE_MAX_STRING = 2000
const FILE_MAX_DEPTH = 5
const FILE_ARRAY_PREVIEW = 5

const SENSITIVE_KEY_RE =
  /pass(word)?|secret|token|authorization|api[_-]?key|refresh[_-]?token|access[_-]?token|cookie|credential/i

export const maskSecret = (value) => {
  const text = String(value ?? '')
  if (!text) {
    return ''
  }
  if (text.length <= 8) {
    return '***'
  }
  return `${text.slice(0, 4)}***${text.slice(-4)}`
}

export const formatBytes = (n) => {
  const num = Number(n) || 0
  if (num < 1024) {
    return `${num}B`
  }
  if (num < 1024 * 1024) {
    return `${(num / 1024).toFixed(1)}KB`
  }
  return `${(num / (1024 * 1024)).toFixed(2)}MB`
}

export const colorMethod = (method) => {
  const m = String(method || '').toUpperCase()
  if (m === 'GET' || m === 'HEAD') {
    return chalk.green(m)
  }
  if (m === 'POST') {
    return chalk.yellow(m)
  }
  if (m === 'PUT' || m === 'PATCH') {
    return chalk.cyan(m)
  }
  if (m === 'DELETE') {
    return chalk.red(m)
  }
  return chalk.white(m)
}

export const colorStatus = (status) => {
  const s = Number(status) || 0
  if (s >= 500) {
    return chalk.red(String(s))
  }
  if (s >= 400) {
    return chalk.yellow(String(s))
  }
  if (s >= 300) {
    return chalk.cyan(String(s))
  }
  return chalk.green(String(s))
}

export const colorDuration = (ms) => {
  const n = Number(ms) || 0
  if (n > 1000) {
    return chalk.red(`${n}ms`)
  }
  if (n > 200) {
    return chalk.yellow(`${n}ms`)
  }
  return chalk.green(`${n}ms`)
}

// ---------- AI / 大结构摘要 ----------

const countBlockTypes = (blocks, bag) => {
  if (!Array.isArray(blocks)) {
    return
  }
  for (const block of blocks) {
    const type =
      (typeof block?.type === 'string' && block.type) || (typeof block?.text === 'string' ? 'text' : 'unknown')
    bag.blocks[type] = (bag.blocks[type] || 0) + 1
    if (typeof block?.text === 'string') {
      bag.textChars += block.text.length
    }
    if (type === 'tool_use' || type === 'function_call') {
      bag.toolUse += 1
    }
    if (type === 'tool_result' || type === 'function_response') {
      bag.toolResult += 1
    }
    if (String(type).includes('image')) {
      bag.images += 1
    }
  }
}

const summarizeMessages = (messages) => {
  const roles = {}
  const bag = { blocks: {}, textChars: 0, toolUse: 0, toolResult: 0, images: 0 }
  for (const message of messages) {
    const role = message?.role || 'unknown'
    roles[role] = (roles[role] || 0) + 1
    const content = message?.content
    if (typeof content === 'string') {
      bag.textChars += content.length
      bag.blocks.text = (bag.blocks.text || 0) + 1
    } else if (Array.isArray(content)) {
      countBlockTypes(content, bag)
    }
    if (Array.isArray(message?.tool_calls)) {
      bag.toolUse += message.tool_calls.length
    }
  }
  return {
    _summary: 'messages',
    count: messages.length,
    roles,
    textChars: bag.textChars,
    blocks: bag.blocks,
    toolUse: bag.toolUse,
    toolResult: bag.toolResult,
    images: bag.images,
  }
}

const summarizeModelsList = (models) => {
  const providers = {}
  for (const model of models) {
    const provider = model?.provider || model?.litellm_provider || 'unknown'
    providers[provider] = (providers[provider] || 0) + 1
  }
  const sample = models.slice(0, 3).map((model) => model?.id || model?.name || '?')
  return {
    _summary: 'models',
    count: models.length,
    providers,
    sample,
  }
}

const looksLikeMessageArray = (arr) =>
  Array.isArray(arr) &&
  arr.length > 0 &&
  arr.every(
    (item) => item && typeof item === 'object' && (item.role !== null || item.content !== null || item.type !== null),
  )

const looksLikeModelArray = (arr) =>
  Array.isArray(arr) &&
  arr.length > 3 &&
  arr.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      (item.id !== null || item.name !== null) &&
      (item.provider !== null || item.mode !== null || item.inputCostPerToken !== null),
  )

/**
 * 把任意值压成适合日志的摘要（递归）
 * @param {'console'|'file'} mode
 */
export const summarizeForLog = (value, mode = 'console', depth = 0) => {
  const maxString = mode === 'file' ? FILE_MAX_STRING : CONSOLE_MAX_STRING()
  const maxDepth = mode === 'file' ? FILE_MAX_DEPTH : CONSOLE_MAX_DEPTH
  const arrayPreview = mode === 'file' ? FILE_ARRAY_PREVIEW : CONSOLE_ARRAY_PREVIEW

  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }

  if (typeof value === 'string') {
    if (value.length <= maxString) {
      return value
    }
    return `${value.slice(0, maxString)}…(+${value.length - maxString} chars)`
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (typeof value !== 'object') {
    return String(value)
  }

  if (depth >= maxDepth) {
    if (Array.isArray(value)) {
      return `[Array(${value.length})]`
    }
    return `[Object keys=${Object.keys(value).length}]`
  }

  if (Buffer.isBuffer(value)) {
    return `<Buffer ${value.length}B>`
  }

  if (Array.isArray(value)) {
    if (looksLikeMessageArray(value)) {
      return summarizeMessages(value)
    }
    if (looksLikeModelArray(value)) {
      return summarizeModelsList(value)
    }
    if (value.length === 0) {
      return []
    }
    if (value.length > arrayPreview) {
      return {
        _summary: 'array',
        length: value.length,
        sample: value.slice(0, arrayPreview).map((item) => summarizeForLog(item, mode, depth + 1)),
      }
    }
    return value.map((item) => summarizeForLog(item, mode, depth + 1))
  }

  // plain object
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key) && (typeof child === 'string' || typeof child === 'number')) {
      out[key] = maskSecret(child)
      continue
    }
    // data.models 大列表
    if ((key === 'models' || key === 'data') && Array.isArray(child) && looksLikeModelArray(child)) {
      out[key] = summarizeModelsList(child)
      continue
    }
    if (key === 'models' && child && typeof child === 'object' && !Array.isArray(child)) {
      // { models: [...] } nested
      if (Array.isArray(child.models) && looksLikeModelArray(child.models)) {
        out[key] = {
          ...summarizeForLog({ ...child, models: undefined }, mode, depth + 1),
          models: summarizeModelsList(child.models),
        }
        continue
      }
    }
    if ((key === 'messages' || key === 'input') && Array.isArray(child) && child.length > 0) {
      out[key] = looksLikeMessageArray(child) ? summarizeMessages(child) : summarizeForLog(child, mode, depth + 1)
      continue
    }
    // success envelope: { success, data: { models: [...] } }
    if (key === 'data' && child && typeof child === 'object' && !Array.isArray(child)) {
      if (Array.isArray(child.models)) {
        out[key] = {
          ...Object.fromEntries(
            Object.entries(child)
              .filter(([k]) => k !== 'models')
              .map(([k, v]) => [k, summarizeForLog(v, mode, depth + 1)]),
          ),
          models: Array.isArray(child.models)
            ? looksLikeModelArray(child.models)
              ? summarizeModelsList(child.models)
              : summarizeForLog(child.models, mode, depth + 1)
            : child.models,
        }
        continue
      }
    }
    out[key] = summarizeForLog(child, mode, depth + 1)
  }
  return out
}

/**
 * 控制台树形 meta 单值格式化（单行优先）
 */
export const formatMetaValueForConsole = (value) => {
  if (value === undefined) {
    return 'undefined'
  }
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    const summarized = summarizeForLog(value, 'console')
    const text = JSON.stringify(summarized)
    // 再保险：整段仍过长则硬截
    const max = isDev() ? 800 : 400
    if (text.length > max) {
      return `${text.slice(0, max)}…(+${text.length - max})`
    }
    return text
  } catch {
    return '[Unserializable]'
  }
}

/**
 * 组装访问日志 message + meta（console 友好 / file 仍结构化）
 */
export const buildAccessLogPayload = ({
  statusCode,
  method,
  url,
  durationMs,
  contentLength,
  requestId,
  apiKey,
  authInfo,
  ip,
  userAgent,
  referer,
  requestBody,
  responseBody,
  query,
} = {}) => {
  const status = Number(statusCode) || 0
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
  const bytes = formatBytes(contentLength)
  // 主行：状态 方法 路径 耗时 体积（无 emoji，人类扫一眼）
  const message = `${status} ${String(method || '').toUpperCase()} ${url} ${durationMs}ms ${bytes}`

  const consoleMeta = {
    id: requestId,
  }
  if (apiKey) {
    consoleMeta.key =
      typeof apiKey === 'string' ? apiKey : `${apiKey.name || '?'}(${String(apiKey.id || '').slice(0, 8)})`
  }
  if (authInfo) {
    consoleMeta.auth = summarizeForLog(authInfo, 'console')
  }
  if (ip) {
    consoleMeta.ip = ip
  }

  // 2xx GET 默认不打完整 res/ua/referer，避免管理端列表刷屏
  const isQuietGet = String(method).toUpperCase() === 'GET' && status < 400
  if (!isQuietGet) {
    if (query) {
      consoleMeta.query = summarizeForLog(query, 'console')
    }
    if (requestBody && typeof requestBody === 'object' && Object.keys(requestBody).length) {
      consoleMeta.req = summarizeForLog(requestBody, 'console')
    }
    if (responseBody !== undefined) {
      consoleMeta.res = summarizeForLog(responseBody, 'console')
    }
  } else if (responseBody && typeof responseBody === 'object') {
    // 安静 GET：只留一行摘要
    const summary = summarizeForLog(responseBody, 'console')
    if (summary && typeof summary === 'object') {
      if (summary.data?.models?._summary === 'models') {
        consoleMeta.res = {
          success: responseBody.success,
          models: summary.data.models.count ?? summary.data.models.length,
        }
      } else if (summary.models?._summary === 'models') {
        consoleMeta.res = { models: summary.models.count }
      } else if (Array.isArray(responseBody?.data?.models)) {
        consoleMeta.res = {
          success: responseBody.success,
          models: responseBody.data.models.length,
        }
      } else if (responseBody.success !== null) {
        consoleMeta.res = { success: responseBody.success }
      }
    }
  }

  // 文件侧保留稍完整但仍摘要后的结构 + 诊断字段
  const fileMeta = {
    requestId,
    ip,
    ua: userAgent,
    referer,
    durationMs,
    contentLength: Number(contentLength) || 0,
    statusCode: status,
  }
  if (apiKey) {
    fileMeta.key = apiKey
  }
  if (authInfo) {
    fileMeta.auth = summarizeForLog(authInfo, 'file')
  }
  if (query) {
    fileMeta.query = summarizeForLog(query, 'file')
  }
  if (requestBody && typeof requestBody === 'object' && Object.keys(requestBody).length) {
    fileMeta.req = summarizeForLog(requestBody, 'file')
  }
  if (responseBody !== undefined) {
    fileMeta.res = summarizeForLog(responseBody, 'file')
  }

  return {
    level,
    message,
    consoleMeta,
    fileMeta,
    // 彩色主行（可选，logger 若支持可直接用）
    coloredMessage: `${colorStatus(status)} ${colorMethod(method)} ${url} ${colorDuration(durationMs)} ${chalk.gray(bytes)}`,
  }
}

export const colorKey = (key) => chalk.cyan(key)

/**
 * 生成控制台彩色访问日志行（主行 + 树形 meta）
 * @returns {string[]}
 */
export const formatAccessConsoleLines = (payload) => {
  const lines = []
  // 主行已在 logger message 里；这里只负责 meta 树着色
  const meta = payload?.consoleMeta || {}
  const entries = Object.entries(meta).filter(
    ([k, v]) => v !== undefined && typeof k === 'string' && !k.startsWith('_'),
  )
  entries.forEach(([key, value], i) => {
    const isLast = i === entries.length - 1
    const branch = chalk.gray(isLast ? '└─' : '├─')
    const display = formatMetaValueForConsole(value)
    // JSON 摘要轻微上色：数字黄、true/false 品红、字符串保持
    const coloredVal = display
      .replace(/\b(\d+(?:\.\d+)?)\b/g, (m) => chalk.yellow(m))
      .replace(/\b(true|false|null)\b/g, (m) => chalk.magenta(m))
    lines.push(`${branch} ${colorKey(key)}${chalk.gray(':')} ${coloredVal}`)
  })
  return lines
}
