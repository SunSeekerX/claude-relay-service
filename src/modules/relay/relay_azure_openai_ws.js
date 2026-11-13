import * as accounts from '../account/account_azure_openai_service.js'
import { buildAzureOpenAIRequest, assertAzureModelAccess } from './relay_azure_openai_request.js'
import { handleNativeResponsesWebSocket } from './relay_native_responses_ws.js'
import { normalizeOpenAITokenUsage } from './relay_request_detail_helper.js'

export const isAzureResponsesWebSocketPath = (path) => ['/azure/responses', '/azure/v1/responses'].includes(path)

export const handleAzureResponsesWebSocket = (req, socket, head) => {
  let originalBinding
  return handleNativeResponsesWebSocket(req, socket, head, {
    accountType: 'azure-openai',
    permission: 'openai',
    label: 'azure-responses',
    maxActiveTurns: 1,
    selectAccount: (keyData, model) => {
      originalBinding = keyData.azureOpenaiAccountId
      return accounts.selectAvailableAccount(req.headers['x-session-id'], originalBinding, model)
    },
    validateAccount: async (account, model, keyData) => {
      assertAzureModelAccess(keyData, model, account)
      if (keyData.azureOpenaiAccountId !== originalBinding) {
        throw Object.assign(new Error('Azure account binding changed; reconnect'), { statusCode: 403 })
      }
      if (!(await accounts._isAccountAvailable(account.id, 'azure-openai', model))) {
        throw Object.assign(new Error('Azure account is unavailable for this model'), { statusCode: 503 })
      }
      return account.deploymentName
    },
    buildConnection: (account) => {
      const request = buildAzureOpenAIRequest({ ...account, apiMode: 'v1' }, 'responses')
      return { targetUrl: request.url, headers: request.headers }
    },
    onTerminal: async (event, account) => {
      const usage = event.response?.usage ?? event.usage
      if (usage) {
        const normalized = normalizeOpenAITokenUsage(usage)
        await accounts.updateAccountUsage(account.id, normalized.totalInputTokens + normalized.outputTokens)
      }
    },
    mapMessage: (message, account) => ({ ...message, model: account.deploymentName }),
  })
}
