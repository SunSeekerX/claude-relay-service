import { assertModelAccess } from './relay_model_access.js'

export const assertAzureModelAccess = (apiKey, model, account) => {
  assertModelAccess(apiKey, model?.replace(/^azure\//, ''))
  assertModelAccess(apiKey, account.deploymentName)
}

export const buildAzureOpenAIRequest = (account, endpoint, body = {}) => {
  const base = account.azureEndpoint.replace(/\/+$/, '')
  const model = account.deploymentName
  const v1 = account.apiMode === 'v1'
  const version = account.apiVersion || (endpoint === 'responses' ? '2025-04-01-preview' : '2024-02-01')
  const url = v1
    ? `${base}/openai/v1/${endpoint}`
    : endpoint === 'responses'
      ? `${base}/openai/responses?api-version=${encodeURIComponent(version)}`
      : `${base}/openai/deployments/${encodeURIComponent(model)}/${endpoint}?api-version=${encodeURIComponent(version)}`
  const headers = {
    'Content-Type': 'application/json',
    ...(account.authType === 'entra' ? { Authorization: `Bearer ${account.apiKey}` } : { 'api-key': account.apiKey }),
  }
  return {
    url,
    headers,
    body: { ...body, model: v1 || endpoint === 'responses' ? model : body.model?.replace(/^azure\//, '') },
  }
}
