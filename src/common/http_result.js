// 管理 JSON 统一信封：{ code, msg, data? }
// code 只允许 number；字符串业务细分码走 data.reason
// [人工决策-2026-08-27 18:58:32] HTTP 状态与 body.code 始终一致（真 HTTP）；throw HttpError 与 return fail/ok 同一发送语义；鉴权/限流/业务 4xx/5xx 均真状态；中转协议面禁止本模块发响应
// 说明：曾试验「业务失败 HTTP 200 + body.code」导致 return fail() 与 throw 分裂、导出把错误 JSON 当文件下载，已收回

import { env } from '../../config/env.js'

export class HttpError extends Error {
  constructor(statusCode, msg, options = {}) {
    super(msg)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.code = statusCode
    this.reason = options.reason
    this.data = options.data
    this.headers = options.headers || {}
    // 4xx 默认把 message 暴露给客户端；5xx 生产可脱敏
    this.expose = options.expose ?? statusCode < 500
  }
}

export const badRequest = (msg, options) => new HttpError(400, msg, options)
export const unauthorized = (msg, options) => new HttpError(401, msg, options)
export const forbidden = (msg, options) => new HttpError(403, msg, options)
export const notFound = (msg, options) => new HttpError(404, msg, options)
export const conflict = (msg, options) => new HttpError(409, msg, options)
export const tooManyRequests = (msg, options) => new HttpError(429, msg, options)

// 成功体；code 为业务成功码（通常 200/201），sendResult 对成功用同值 HTTP
export const ok = (data, msg = 'Ok', code = 200) => {
  const body = { code, msg }
  if (data !== undefined) {
    body.data = data
  }
  return body
}

export const fail = (code, msg, options = {}) => {
  const body = { code, msg }
  if (options.reason !== undefined) {
    body.data = { ...(options.data || {}), reason: options.reason }
  } else if (options.data !== undefined) {
    body.data = options.data
  }
  if (options.requestId) {
    body.requestId = options.requestId
  }
  if (options.headers) {
    body.headers = options.headers
  }
  return body
}

export const isEnvelope = (value) =>
  value !== null && typeof value === 'object' && typeof value.code === 'number' && typeof value.msg === 'string'

const applyHeaders = (res, headers) => {
  if (!headers || typeof headers !== 'object') {
    return
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      res.set(key, String(value))
    }
  }
}

// 业务码：来自 HttpError.statusCode / error.statusCode / error.status
export const resolveBodyCode = (error, fallback = 500) => {
  if (!error || typeof error !== 'object') {
    return fallback
  }
  const statusCode = error.statusCode || error.status || error.code
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600) {
    return statusCode
  }
  return fallback
}

// 兼容旧名
export const resolveStatusCode = resolveBodyCode

// HTTP 始终等于 body.code（throw 与 return fail 同路径，禁止再分裂）
export const resolveHttpStatus = (bodyCode, _error) => bodyCode

// 生产环境 5xx 文案脱敏（return fail(500, upstream) 与 throw 共用）
const sanitizeOutboundMsg = (code, msg, expose) => {
  if (code < 500) {
    return msg
  }
  if (expose) {
    return msg
  }
  if (env.NODE_ENV === 'development') {
    return msg
  }
  return '服务器内部错误'
}

// 成功/失败信封统一出口：HTTP === body.code
export const sendResult = (res, body, httpStatus) => {
  if (res.headersSent) {
    return res
  }
  const status = httpStatus ?? body?.code ?? 200
  if (body?.headers) {
    applyHeaders(res, body.headers)
  }
  const expose = body?.expose === true || status < 500
  const payload = {
    code: body.code,
    msg: sanitizeOutboundMsg(status, body.msg, expose),
  }
  if (body.data !== undefined) {
    payload.data = body.data
  }
  if (body.requestId !== undefined) {
    payload.requestId = body.requestId
  }
  return res.status(status).json(payload)
}

// 管理面错误出口：body.code 与 HTTP 同值
export const sendError = (res, error, options = {}) => {
  if (res.headersSent) {
    return res
  }
  const {
    fallbackStatus = 500,
    httpStatus: httpStatusOption,
    msg: msgOption,
    serverMsg,
    headers: optionHeaders,
    requestId,
    data: optionData,
  } = options
  const bodyCode = resolveBodyCode(error, fallbackStatus)
  const httpStatus = typeof httpStatusOption === 'number' ? httpStatusOption : resolveHttpStatus(bodyCode, error)
  const expose = error instanceof HttpError ? error.expose : bodyCode < 500
  let msg
  if (typeof msgOption === 'string') {
    msg = msgOption
  } else if (expose && error?.message) {
    msg = error.message
  } else if (bodyCode >= 500) {
    msg = serverMsg || '服务器内部错误'
  } else {
    msg = error?.message || '请求失败'
  }
  msg = sanitizeOutboundMsg(bodyCode, msg, expose)
  applyHeaders(res, error?.headers)
  applyHeaders(res, optionHeaders)
  const body = fail(bodyCode, msg, {
    reason: error?.reason,
    requestId,
    data: optionData !== undefined ? optionData : error?.data,
  })
  return res.status(httpStatus).json(body)
}

// 鉴权失败：真 HTTP 401/403（与 body.code 一致）
export const sendAuthFail = (res, statusCode, msg, options = {}) => {
  if (res.headersSent) {
    return res
  }
  applyHeaders(res, options.headers)
  return res.status(statusCode).json(fail(statusCode, msg, options))
}
