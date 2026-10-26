import { getEffectiveModel } from './relay_model_helper.js'
import { normalizeKnownOpenAICodexModel } from './relay_openai_model_alias.js'
import { parseThinkingModelSuffix } from './translator/relay_translator_thinking.js'
import { isModelAllowedByGroup } from '../account/account_group_constants.js'

const canonicalModel = (model) => {
  if (typeof model !== 'string') {
    return ''
  }
  const normalized = getEffectiveModel(model)
    .replace(/^models\//, '')
    .toLowerCase()
  const baseModel = parseThinkingModelSuffix(normalized).baseModel ?? normalized
  const alias = normalizeKnownOpenAICodexModel(baseModel)
  return alias ? alias : baseModel
}

export const isModelAllowed = (apiKey, model) => {
  if (apiKey?.enableModelRestriction !== true && apiKey?.enableModelRestriction !== 'true') {
    return true
  }
  const restricted = Array.isArray(apiKey.restrictedModels) ? apiKey.restrictedModels : []
  const requested = canonicalModel(model)
  return !requested || !restricted.some((entry) => canonicalModel(entry) === requested)
}

export const assertModelAccess = (apiKey, model) => {
  if (!isModelAllowed(apiKey, model)) {
    throw Object.assign(new Error('This model is not allowed for this API key'), {
      statusCode: 403,
      code: 'model_not_allowed',
    })
  }
}

export const assertOutboundModelAccess = async (apiKey, model, accountType) => {
  assertModelAccess(apiKey, model)
  const { extractBoundGroupIdForAccountType } = await import('../account/account_group_policy.js')
  const route = apiKey?._relayRoute
  const groupId = route
    ? route.binding.startsWith('group:')
      ? route.binding.slice(6)
      : null
    : extractBoundGroupIdForAccountType(apiKey, accountType)
  if (!groupId) {
    return
  }
  const { accountGroupService } = await import('../account/account_group_service.js')
  const group = await accountGroupService.getGroup(groupId)
  if (!group || !isModelAllowedByGroup(group, model)) {
    throw Object.assign(new Error('最终模型不在此分组允许范围内'), { statusCode: 403, code: 'model_not_allowed' })
  }
}

export const getRequestModels = (req) =>
  [req.body?.model, req.body?.request?.model, req.params?.modelName, req.query?.model].filter(
    (model) => typeof model === 'string',
  )

export const modelAccessErrorBody = (req, error) => {
  const path = req.originalUrl ?? req.url ?? ''
  if (/\/(?:v1beta|v1)\/models\/|\/v1internal[:/]/.test(path)) {
    return { error: { code: 403, status: 'PERMISSION_DENIED', message: error.message } }
  }
  if (/\/messages(?:[/?]|$)/.test(path)) {
    return { type: 'error', error: { type: 'permission_error', message: error.message } }
  }
  return { error: { type: 'permission_error', code: error.code, message: error.message } }
}

export const createWsModelAccessGuard = (apiKey, initialModel = null) => {
  const currentModels = new Map()
  return (text) => {
    const message = JSON.parse(text)
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('Invalid WebSocket request')
    }
    if (['response.create', 'response.append'].includes(message.type)) {
      const streamId = message.stream_id ?? message.response?.stream_id ?? null
      const model = message.response?.model ?? message.model ?? currentModels.get(streamId) ?? initialModel
      assertModelAccess(apiKey, model)
      currentModels.set(streamId, model)
    }
    return text
  }
}
