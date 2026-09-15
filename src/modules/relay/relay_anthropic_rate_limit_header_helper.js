// Anthropic 统一限流响应头解析
//
// 上游会在每个响应里回传多个「限流窗口」的独立状态：
//   anthropic-ratelimit-unified-5h-{status,reset,utilization}      账号级 5 小时窗口
//   anthropic-ratelimit-unified-7d-{status,reset,utilization}      账号级 7 天窗口
//   anthropic-ratelimit-unified-7d_oi-{status,reset,utilization}   Opus 专属 7 天窗口
//   anthropic-ratelimit-unified-representative-claim               当前「代表窗口」
//   anthropic-ratelimit-unified-reset                              代表窗口的 reset —— 会漂移
//
// DEC_20260912_232856 模型级限流必须按 status=rejected 的窗口取 reset，禁止直接用 unified-reset

import { logger } from '../../common/logger.js'

// 上游会回传的窗口后缀。7d_oi = seven day opus intensive（Opus 专属周窗口）
export const RATE_LIMIT_WINDOW_KEYS = ['5h', '7d', '7d_oi']

// 窗口 → 模型家族。只有 Opus 专属周窗口是真正「按模型」的，
// 5h / 7d 是整个账号共享的窗口，不隶属于任何单一模型家族。
export const WINDOW_MODEL_FAMILY = {
  '7d_oi': 'opus',
}

// 被拒绝的窗口状态。上游取值：allowed / allowed_warning / rejected
const REJECTED_STATUS = 'rejected'

// 兜底时长上限（秒）。仅在无法识别「哪个窗口被拒绝」时生效。
export const DEFAULT_MAX_FALLBACK_SECONDS = 3600

const getHeader = (headers, name) => {
  if (!headers || typeof headers !== 'object') {
    return undefined
  }
  if (headers[name] !== undefined) {
    return headers[name]
  }
  const lower = name.toLowerCase()
  if (headers[lower] !== undefined) {
    return headers[lower]
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key]
    }
  }
  return undefined
}

const parseTimestamp = (value) => {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const raw = String(value).trim()

  // 绝大多数情况下是 Unix 秒。必须先确认整串都是数字：
  // parseInt('2026-09-05T06:10:00Z') 会返回 2026，把 ISO 时间误读成一个 1970 年的时间戳。
  if (/^\d+$/.test(raw)) {
    const seconds = parseInt(raw, 10)
    return seconds > 0 ? seconds : null
  }

  const date = new Date(raw)
  if (!Number.isNaN(date.getTime())) {
    return Math.floor(date.getTime() / 1000)
  }
  return null
}

const parseUtilization = (value) => {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const parsed = parseFloat(value)
  return Number.isNaN(parsed) ? null : parsed
}

// 解析所有限流窗口
export const parseRateLimitWindows = (headers) =>
  RATE_LIMIT_WINDOW_KEYS.map((key) => {
    const status = getHeader(headers, `anthropic-ratelimit-unified-${key}-status`)
    const family = WINDOW_MODEL_FAMILY[key] || null
    return {
      key,
      status: status ? String(status).toLowerCase() : null,
      reset: parseTimestamp(getHeader(headers, `anthropic-ratelimit-unified-${key}-reset`)),
      utilization: parseUtilization(getHeader(headers, `anthropic-ratelimit-unified-${key}-utilization`)),
      family,
      isAccountWide: family === null,
    }
  }).filter((window) => window.status !== null || window.reset !== null)

// 解析一次 429 应该使用的 reset 时间戳。
// 优先级：
//   1. 与请求模型家族匹配、且 status=rejected 的模型级窗口（如 Opus 的 7d_oi）
//   2. status=rejected 的账号级窗口（5h / 7d），取最晚的那个
//   3. 兜底：代表窗口的 unified-reset，并按 maxFallbackSeconds 钳制
export const resolveRateLimitReset = (headers, modelFamily = null, options = {}) => {
  const rawFallback = Number(options.maxFallbackSeconds)
  const maxFallbackSeconds =
    Number.isFinite(rawFallback) && rawFallback > 0 ? rawFallback : DEFAULT_MAX_FALLBACK_SECONDS
  const now = options.now || Date.now()

  const windows = parseRateLimitWindows(headers)
  const rejected = windows.filter((window) => window.status === REJECTED_STATUS && window.reset !== null)

  if (modelFamily) {
    const modelWindow = rejected.find((window) => window.family === modelFamily)
    if (modelWindow) {
      return {
        resetTimestamp: modelWindow.reset,
        windowKey: modelWindow.key,
        scope: 'model',
        authoritative: true,
        clamped: false,
      }
    }
  }

  const accountWindows = rejected.filter((window) => window.isAccountWide)
  if (accountWindows.length > 0) {
    const latest = accountWindows.reduce((left, right) => (right.reset > left.reset ? right : left))
    return {
      resetTimestamp: latest.reset,
      windowKey: latest.key,
      scope: 'account',
      authoritative: true,
      clamped: false,
    }
  }

  const fallback = parseTimestamp(getHeader(headers, 'anthropic-ratelimit-unified-reset'))
  if (fallback === null) {
    return {
      resetTimestamp: null,
      windowKey: null,
      scope: null,
      authoritative: false,
      clamped: false,
    }
  }

  // DEC_20260913_155429 无 rejected 窗口时 unified-reset 非权威：scope 保持 null，禁止调用方记限流
  const capTimestamp = Math.floor(now / 1000) + maxFallbackSeconds
  if (fallback > capTimestamp) {
    logger.warn(
      `⏱️ Unified reset ${new Date(fallback * 1000).toISOString()} exceeds the ${maxFallbackSeconds}s fallback cap ` +
        `(no rejected window reported); clamping to ${new Date(capTimestamp * 1000).toISOString()} ` +
        `(informational only, not authoritative)`,
    )
    return {
      resetTimestamp: capTimestamp,
      windowKey: null,
      scope: null,
      authoritative: false,
      clamped: true,
    }
  }

  return {
    resetTimestamp: fallback,
    windowKey: null,
    scope: null,
    authoritative: false,
    clamped: false,
  }
}
