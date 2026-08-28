import { createHttp } from '@/libs/http'
import { APP_CONFIG, getLoginUrl } from '@/libs/tools'

// 401 处理: 清除 token 并跳转登录（公开页面除外）
const handleUnauthorized = () => {
  const path = window.location.pathname + window.location.hash
  const isPublicPage = path.includes('/api-stats') || path.includes('/user-login')
  if (!path.includes('/login') && !path.endsWith('/') && !isPublicPage) {
    localStorage.removeItem('authToken')
    window.location.href = getLoginUrl()
  }
}

const statusMessages = {
  401: '未授权，请重新登录',
  403: '无权限访问',
  404: '请求的资源不存在',
  429: '请求过于频繁',
  500: '服务器内部错误'
}

export const isSuccessCode = (code) => typeof code === 'number' && code >= 200 && code < 300

// 管理信封：只认 { code, msg, data? }；业务失败常 HTTP 200 + code≠2xx
const normalizeEnvelope = (json, httpStatus) => {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return {
      code: typeof httpStatus === 'number' && httpStatus >= 400 ? httpStatus : 0,
      msg: statusMessages[httpStatus] || '请求失败',
      httpStatus
    }
  }
  if (typeof json.code === 'number') {
    const msg =
      typeof json.msg === 'string'
        ? json.msg
        : typeof json.message === 'string'
          ? json.message
          : isSuccessCode(json.code)
            ? 'Ok'
            : statusMessages[json.code] || '请求失败'
    return {
      code: json.code,
      msg,
      data: json.data,
      reason: json.data?.reason,
      requestId: json.requestId,
      httpStatus: httpStatus ?? json.httpStatus
    }
  }
  // 非管理协议体（极少）：合成失败
  return {
    code: typeof httpStatus === 'number' && httpStatus >= 400 ? httpStatus : 500,
    msg:
      (typeof json.msg === 'string' && json.msg) ||
      (typeof json.message === 'string' && json.message) ||
      (typeof json.error === 'string' && json.error) ||
      statusMessages[httpStatus] ||
      '请求失败',
    data: json.data,
    httpStatus
  }
}

const service = createHttp({
  baseURL: APP_CONFIG.apiPrefix,
  timeout: 30000,
  onRequest: (_config, init) => {
    const token = localStorage.getItem('authToken')
    if (token) init.headers['Authorization'] = `Bearer ${token}`
  },
  onResponse: (res, json, config) => {
    if (!res) {
      if (json.error && !json.aborted) {
        console.error('Request failed:', config?.method, config?.url, json.error)
      }
      return normalizeEnvelope(
        { code: 0, msg: json.message || json.msg || '请求失败' },
        0
      )
    }
    // 真 401（鉴权）跳登录；业务体也可能 code=401
    if (res.status === 401) handleUnauthorized()
    const body = normalizeEnvelope(json ?? {}, res.status)
    if (body.code === 401) handleUnauthorized()
    if (!res.ok && res.status >= 500) {
      console.error('Request failed:', config?.method, config?.url, res.status)
    }
    return body
  }
})

const request = (config) => service(config)

export default request
