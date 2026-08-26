import { logger } from '../../common/logger.js'
import * as upstreamErrorHelper from './relay_upstream_error_helper.js'
// 上游非协议响应判定与粘性清理（坏号粘性连打防护）

const HTML_SNIFF_RE = /^\s*<(!doctype\s+html|html[\s>])/i
const XML_SNIFF_RE = /^\s*<\?xml[\s>]|^\s*<[a-zA-Z][\w:.-]*[\s>]/
const JSONISH_RE = /^\s*[{[]/

// 是否把上游响应视为「非协议体」（不是 JSON/SSE API）
export const isNonProtocolUpstreamBody = ({ statusCode, contentType, bodyText } = {}) => {
  const status = Number(statusCode) || 0
  // 2xx/3xx 正常业务响应不走此分支
  if (status > 0 && status < 400) {
    return false
  }

  const ct = String(contentType || '').toLowerCase()
  const text = typeof bodyText === 'string' ? bodyText : bodyText === null ? '' : String(bodyText)
  const head = text.slice(0, 800)

  const looksLikeApiCt =
    ct.includes('application/json') || ct.includes('text/event-stream') || ct.includes('application/x-ndjson')

  // 明确 HTML/XML
  if (
    ct.includes('text/html') ||
    ct.includes('application/xhtml') ||
    ct.includes('text/xml') ||
    ct.includes('application/xml')
  ) {
    return true
  }

  if (head && (HTML_SNIFF_RE.test(head) || XML_SNIFF_RE.test(head))) {
    return true
  }

  // text/plain 或缺 content-type：4xx/5xx 下只要不是 JSON 结构，一律当非协议体
  // （覆盖任意自定义纯文本错页，不依赖短语白名单）
  if (ct.includes('text/plain') || !ct) {
    if (!head) {
      // 无 body 的 5xx 也视为不可用网关响应
      return status >= 500
    }
    if (!JSONISH_RE.test(head)) {
      return true
    }
  }

  // 标成 json 但正文不是 JSON
  if (ct.includes('application/json') && head && !JSONISH_RE.test(head)) {
    return true
  }

  // 其它非 API content-type
  if (ct && !looksLikeApiCt && !ct.includes('octet-stream')) {
    return true
  }

  return false
}

export const extractBodyPreview = async (data, maxLen = 2048) => {
  if (data === null) {
    return ''
  }
  if (typeof data === 'string') {
    return data.slice(0, maxLen)
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8', 0, maxLen)
  }
  if (typeof data.pipe === 'function') {
    return ''
  }
  try {
    return JSON.stringify(data).slice(0, maxLen)
  } catch {
    return String(data).slice(0, maxLen)
  }
}

export const handleNonProtocolUpstream = async ({
  accountId,
  accountType,
  sessionHash = null,
  statusCode = 502,
  errorContext = null,
  disableAutoProtection = false,
  clearSticky = null,
} = {}) => {
  if (!accountId) {
    return
  }

  logger.warn(
    `[UpstreamProtocolGuard] non-protocol upstream body accountId=${accountId} type=${accountType} status=${statusCode} session=${sessionHash || '-'}`,
  )

  if (typeof clearSticky === 'function') {
    try {
      await clearSticky()
    } catch (error) {
      console.error(error)
      logger.warn('[UpstreamProtocolGuard] clearSticky failed:', error.message)
    }
  }

  if (disableAutoProtection) {
    return
  }

  try {
    await upstreamErrorHelper.markTempUnavailable(accountId, accountType, statusCode || 502, null, errorContext)
  } catch (error) {
    console.error(error)
    logger.warn('[UpstreamProtocolGuard] markTempUnavailable failed:', error.message)
  }
}
