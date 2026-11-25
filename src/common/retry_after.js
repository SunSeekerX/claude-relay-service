// HTTP Retry-After 的统一毫秒解析，显式 0 表示可以立即重试。
export const parseRetryAfterMilliseconds = (value, now = Date.now()) => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }
  const text = String(value).trim()
  if (!text) {
    return null
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    const milliseconds = Math.ceil(Number(text) * 1000)
    return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null
  }
  const timestamp = Date.parse(text)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null
}
