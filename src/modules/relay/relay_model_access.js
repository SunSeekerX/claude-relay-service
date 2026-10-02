import { getEffectiveModel } from './relay_model_helper.js'
import { normalizeKnownOpenAICodexModel } from './relay_openai_model_alias.js'
import { parseThinkingModelSuffix } from './translator/relay_translator_thinking.js'

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

export const assertModelAccess = (apiKey, model) => {
  if (apiKey?.enableModelRestriction !== true && apiKey?.enableModelRestriction !== 'true') {
    return
  }
  const restricted = Array.isArray(apiKey.restrictedModels) ? apiKey.restrictedModels : []
  const requested = canonicalModel(model)
  if (requested && restricted.some((entry) => canonicalModel(entry) === requested)) {
    throw Object.assign(new Error('This model is not allowed for this API key'), {
      statusCode: 403,
      code: 'model_not_allowed',
    })
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
  let currentModel = initialModel
  return (text) => {
    const message = JSON.parse(text)
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('Invalid WebSocket request')
    }
    if (['response.create', 'response.append'].includes(message.type)) {
      const model = message.response?.model ?? message.model ?? currentModel
      assertModelAccess(apiKey, model)
      currentModel = model
    }
    return text
  }
}
