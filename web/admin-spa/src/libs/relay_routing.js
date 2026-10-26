export const parseKeyRouting = (value) => {
  if (value === undefined || value === null || value === '')
    return { allowedRoutes: [], defaults: {} }
  const routing = typeof value === 'string' ? JSON.parse(value) : value
  return { allowedRoutes: [...routing.allowedRoutes], defaults: { ...routing.defaults } }
}

export const routingOrigin = () => {
  const configured = import.meta.env.VITE_API_BASE_PREFIX
  return new URL(
    configured ? configured : window.location.origin,
    window.location.origin
  ).href.replace(/\/+$/, '')
}

export const routeAddress = (basePath) => `${routingOrigin()}${basePath}`

export const modelSourceLabel = (source) =>
  ({
    upstream: '上游已返回',
    configured: '管理员已配置',
    unconfirmed: '未向上游确认'
  })[source] ?? '未向上游确认'

export const modelAvailabilityLabel = (state) =>
  ({
    ready: '有可调度账号',
    blocked: '暂无可调度账号',
    unknown: '调度状态待确认'
  })[state] ?? '调度状态待确认'

export const ROUTE_STATUS_LABELS = {
  configured: '已配置',
  'default-overridden': '使用协议默认入口',
  disabled: '已停用',
  'permission-denied': '服务权限未开放',
  'target-missing': '绑定目标不存在',
  deleted: '入口已删除'
}
