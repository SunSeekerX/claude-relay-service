import { safeParseJson } from '../../common/common_helper.js'
import { badRequest } from '../../common/http_result.js'
import { LIMITS } from '../../infra/redis_key.js'

export const normalizeAccountModelRange = (raw, allowMapping = false) => {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = raw.trim() ? JSON.parse(raw) : []
    } catch {
      throw badRequest('支持的模型必须是模型名称数组')
    }
  }
  if (!Array.isArray(value) && !(allowMapping && value && typeof value === 'object')) {
    throw badRequest('支持的模型必须是模型名称数组')
  }
  const names = Array.isArray(value) ? value : Object.keys(value)
  if (
    names.length > LIMITS.accountCatalogModels ||
    names.some((name) => typeof name !== 'string' || !name || name !== name.trim() || name.length > 200)
  ) {
    throw badRequest('支持的模型包含无效名称或超过数量限制')
  }
  return Array.isArray(value) ? [...new Set(value)] : value
}

export const isAccountModelInRange = (raw, model) => {
  const value = typeof raw === 'string' ? safeParseJson(raw, []) : raw
  const models = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.keys(value) : []
  if (!models.length) {
    return true
  }
  if (!model) {
    return false
  }
  const requested = model.replace(/^models\//, '').toLowerCase()
  return models.some((name) => {
    const normalized = name.replace(/^models\//, '').toLowerCase()
    return normalized.endsWith('*') ? requested.startsWith(normalized.slice(0, -1)) : requested === normalized
  })
}
