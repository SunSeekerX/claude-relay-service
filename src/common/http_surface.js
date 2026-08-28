// 管理 JSON 面 vs 中转/运维面划分
// 用 originalUrl（去 query）匹配前缀，避免子路由 req.path 变成相对路径导致误判

const stripQuery = (url) => {
  if (!url || typeof url !== 'string') {
    return ''
  }
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

// 管理端 SPA / 用户门户 / 支付用户 JSON 等套 { code, msg, data } 的路径
export const isManagementJsonPath = (req) => {
  const path = stripQuery(req?.originalUrl || req?.url || '')
  if (path.startsWith('/admin')) {
    return true
  }
  if (path.startsWith('/users')) {
    return true
  }
  if (path.startsWith('/web')) {
    return true
  }
  if (path.startsWith('/apiStats')) {
    return true
  }
  // /payment/* 管理/用户 JSON；webhook 渠道纯文本除外
  if (path.startsWith('/payment') && !path.startsWith('/payment/webhook')) {
    return true
  }
  return false
}
