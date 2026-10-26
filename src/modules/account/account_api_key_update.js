import { badRequest } from '../../common/http_result.js'

export const normalizeAccountApiKeyUpdate = (updates) => {
  if (!Object.hasOwn(updates, 'apiKey')) {
    return updates
  }
  const { apiKey } = updates
  if (apiKey === undefined || apiKey === null || apiKey === '') {
    delete updates.apiKey
    return updates
  }
  if (typeof apiKey !== 'string') {
    throw badRequest('API Key 必须是字符串')
  }
  const value = apiKey.trim()
  if (!value) {
    delete updates.apiKey
  } else if (/\*{3,}|[•●]{3,}/.test(value)) {
    throw badRequest('不能将脱敏占位值保存为 API Key，请填写完整的新 Key')
  } else {
    updates.apiKey = value
  }
  return updates
}
