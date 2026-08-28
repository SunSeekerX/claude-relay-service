// 管理 API 信封辅助：只认 code/msg/data（业务失败常 HTTP 200 + code≠2xx）

export const isOk = (body) =>
  !!body && typeof body === 'object' && typeof body.code === 'number' && body.code >= 200 && body.code < 300

export const msgOf = (body, fallback = '请求失败') => {
  if (!body || typeof body !== 'object') return fallback
  if (typeof body.msg === 'string' && body.msg) return body.msg
  return fallback
}

export const dataOf = (body, fallback) => {
  if (!body || typeof body !== 'object') return fallback
  if (Object.prototype.hasOwnProperty.call(body, 'data')) return body.data
  return fallback
}

export const reasonOf = (body) => {
  if (!body || typeof body !== 'object') return undefined
  return body.data?.reason || body.reason
}
