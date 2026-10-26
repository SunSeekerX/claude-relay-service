import { badRequest } from './http_result.js'

export const parseStoredAccountModels = (value) => {
  if (typeof value !== 'string') {
    return value ?? []
  }
  const text = value.trim()
  if (!text) {
    return []
  }
  try {
    return JSON.parse(text)
  } catch {
    if (text.startsWith('[') || text.startsWith('{')) {
      throw badRequest('账号模型范围数据格式无效')
    }
    return text
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean)
  }
}

export const readMappedAccountModelRange = (account) => {
  if (Object.hasOwn(account, 'allowedModels')) {
    return parseStoredAccountModels(account.allowedModels)
  }
  const models = parseStoredAccountModels(account.supportedModels)
  return Array.isArray(models) ? models : Object.keys(models ?? {})
}
