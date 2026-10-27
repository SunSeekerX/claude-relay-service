import { logger } from '../../common/logger.js'
import { redis } from '../../infra/redis.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import { buildClientError, extractSafeMessage } from '../../common/client_error_builder.js'
import { trackRequestTiming, timedUpstreamRequest } from '../../common/request_timing.js'
import * as geminiAccountService from '../account/account_gemini_service.js'
import { unifiedGeminiScheduler } from './relay_unified_gemini_scheduler.js'
import { sessionHelper } from './relay_session_helper.js'
import { parseProxyConfig } from './relay_gemini_handlers_routes.js'

export const createCodeAssistHandler =
  (apiMethod, { method = 'POST', dedicatedOnly = false } = {}) =>
  async (req, res) => {
    const controller = new AbortController()
    const detach = onClientDisconnect(res, () => controller.abort(), 'Gemini Code Assist')
    try {
      let operationName
      let pinnedAccountId
      if (apiMethod === 'getOperation') {
        const { operationId } = req.params
        if (!/^[A-Za-z0-9_-]+$/.test(operationId)) {
          throw Object.assign(new Error('Invalid operation ID'), { statusCode: 400 })
        }
        operationName = `operations/${operationId}`
        pinnedAccountId = await redis.getGeminiCodeAssistOperationAccount(req.apiKey.id, operationId)
        if (!pinnedAccountId) {
          throw Object.assign(new Error('Operation is unavailable for this API key'), {
            statusCode: 404,
            code: 'operation_not_found',
          })
        }
      }
      const binding = req.apiKey.geminiAccountId
      if (dedicatedOnly && (!binding || binding.startsWith('group:') || binding.startsWith('api:'))) {
        return res.status(403).json({
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'Bind a dedicated Gemini OAuth account to update global settings',
          },
        })
      }
      const selection = await trackRequestTiming(req, 'scheduling', () =>
        unifiedGeminiScheduler.selectAccountForApiKey(
          req.apiKey,
          pinnedAccountId ? null : sessionHelper.generateSessionHash(req.body ?? {}),
          null,
          { oauthProvider: 'gemini-cli', ...(pinnedAccountId ? { pinnedAccountId } : {}) },
        ),
      )
      req._crsAccountId = selection.accountId
      req._crsAccountType = selection.accountType
      const account =
        selection.accountType === 'gemini' ? await geminiAccountService.getAccount(selection.accountId) : null
      if (!account || (account.oauthProvider ?? 'gemini-cli') !== 'gemini-cli') {
        return res.status(503).json({
          error: {
            code: 503,
            status: 'UNAVAILABLE',
            message: 'No available Gemini CLI OAuth account',
          },
        })
      }
      // DEC_20261024_212713 全局设置写入仅允许显式绑定专属 Gemini CLI OAuth 账号。
      if (dedicatedOnly && (selection.accountId !== binding || account.accountType !== 'dedicated')) {
        return res.status(403).json({
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'Global settings cannot be updated on a shared or fallback account',
          },
        })
      }
      const proxyConfig = parseProxyConfig(account)
      const client = await geminiAccountService.getOauthClient(
        account.accessToken,
        account.refreshToken,
        proxyConfig,
        account.oauthProvider,
      )
      const response = await timedUpstreamRequest(req, () =>
        geminiAccountService.forwardToCodeAssist(client, apiMethod, req.body, proxyConfig, {
          method,
          operationName,
          signal: controller.signal,
        }),
      )
      if (apiMethod === 'onboardUser' && response?.done !== true) {
        const operationId =
          typeof response?.name === 'string' ? response.name.match(/^operations\/([A-Za-z0-9_-]+)$/)?.[1] : null
        if (!operationId) {
          throw Object.assign(new Error('Upstream returned an invalid Code Assist operation'), {
            statusCode: 502,
            code: 'invalid_operation_response',
          })
        }
        await redis.saveGeminiCodeAssistOperationAccount(req.apiKey.id, operationId, selection.accountId)
      }
      if (!res.destroyed) {
        if (response === undefined || response === null || response === '') {
          return res.status(204).end()
        }
        return res.json(response)
      }
    } catch (error) {
      logger.error('Gemini Code Assist request failed', {
        requestId: req.requestId,
        accountId: req._crsAccountId,
        apiMethod,
        message: extractSafeMessage(error.message),
        code: error.code,
        status: error.response?.status,
        stack: error.stack?.replace(error.message, extractSafeMessage(error.message)),
      })
      if (!res.destroyed && !res.headersSent) {
        const result = buildClientError({
          statusCode: error.response?.status ?? error.statusCode ?? 503,
          protocol: 'gemini',
          upstreamBody: error.response?.data ?? { error: { message: error.message, code: error.code } },
        })
        return res.status(result.statusCode).json(result.body)
      }
    } finally {
      detach()
    }
  }
