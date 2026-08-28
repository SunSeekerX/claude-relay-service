import { logger } from './logger.js'
import { ok, isEnvelope, sendResult, sendError, resolveStatusCode } from './http_result.js'

// handler 已自行写完响应（流式/文件）时返回此哨兵，asyncRoute 不再 json
export const SEND_RAW = Symbol('SEND_RAW')

// 管理 JSON 路由壳：return 数据 → 信封；throw → statusCode 识别后信封
// label 用于错误日志
export const asyncRoute = (labelOrHandler, maybeHandler) => {
  const hasLabel = typeof maybeHandler === 'function'
  const label = hasLabel ? labelOrHandler : null
  const handler = hasLabel ? maybeHandler : labelOrHandler

  return async (req, res, next) => {
    try {
      const result = await handler(req, res, next)
      if (res.headersSent || result === SEND_RAW) {
        return
      }
      // handler 调用了 next(err) 且未结束响应时交给后续；通常管理路由不混用 next
      if (result === undefined && res.headersSent) {
        return
      }
      if (isEnvelope(result)) {
        return sendResult(res, result)
      }
      if (result === undefined) {
        return sendResult(res, ok())
      }
      return sendResult(res, ok(result))
    } catch (error) {
      const logLabel = label || `${req.method} ${req.originalUrl}`
      const statusCode = resolveStatusCode(error, 500)
      if (statusCode >= 500) {
        logger.error(logLabel, error)
      } else {
        logger.warn(`${logLabel}: ${error.message}`)
      }
      if (res.headersSent) {
        return
      }
      return sendError(res, error)
    }
  }
}

// 仅捕获 async 错误并 next(err)；不包装成功体。流式/特殊响应用。
// errorHandler 仍必须 headersSent 守卫。
export const rawRoute = (labelOrHandler, maybeHandler) => {
  const hasLabel = typeof maybeHandler === 'function'
  const label = hasLabel ? labelOrHandler : null
  const handler = hasLabel ? maybeHandler : labelOrHandler

  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (error) {
      const logLabel = label || `${req.method} ${req.originalUrl}`
      logger.error(logLabel, error)
      if (res.headersSent) {
        return
      }
      next(error)
    }
  }
}
