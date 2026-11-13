import express from 'express'
import { assertAzureModelAccess } from './relay_azure_openai_request.js'
import { buildClientError } from '../../common/client_error_builder.js'
import { logger } from '../../common/logger.js'
import { authenticateApiKey } from '../../infra/middleware_auth.js'
import * as azureOpenaiAccountService from '../account/account_azure_openai_service.js'
import * as azureOpenaiRelayService from './relay_azure_openai_relay_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import crypto from 'node:crypto'
import * as upstreamErrorHelper from './relay_upstream_error_helper.js'
import {
  buildTokenUsagePayload,
  normalizeOpenAITokenUsage,
  resolveOpenAIServiceTier,
  createRequestDetailMeta,
} from './relay_request_detail_helper.js'
export const router = express.Router()

const authorizeAzureOpenAI = (req, res, next) => {
  if (!apiKeyService.hasPermission(req.apiKey?.permissions, 'openai')) {
    return res.status(403).json({
      error: { type: 'permission_error', message: 'This API key does not have OpenAI permissions' },
    })
  }
  next()
}

// 支持的模型列表 - 基于真实的 Azure OpenAI 模型
const ALLOWED_MODELS = {
  CHAT_MODELS: [
    'gpt-4',
    'gpt-4-turbo',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-5',
    'gpt-5-mini',
    'gpt-35-turbo',
    'gpt-35-turbo-16k',
    'codex-mini',
  ],
  EMBEDDING_MODELS: ['text-embedding-ada-002', 'text-embedding-3-small', 'text-embedding-3-large'],
}

const ALL_ALLOWED_MODELS = [...ALLOWED_MODELS.CHAT_MODELS, ...ALLOWED_MODELS.EMBEDDING_MODELS]

// Azure OpenAI 稳定 API 版本
// const AZURE_API_VERSION = '2024-02-01' // 当前未使用，保留以备后用

// 原子使用统计报告器
class AtomicUsageReporter {
  constructor() {
    this.reportedUsage = new Set()
    this.pendingReports = new Map()
  }

  async reportOnce(requestId, usageData, apiKeyId, modelToRecord, accountId, requestMeta = null) {
    if (this.reportedUsage.has(requestId)) {
      logger.debug(`Usage already reported for request: ${requestId}`)
      return false
    }

    // 防止并发重复报告
    if (this.pendingReports.has(requestId)) {
      return this.pendingReports.get(requestId)
    }

    const reportPromise = this._performReport(requestId, usageData, apiKeyId, modelToRecord, accountId, requestMeta)
    this.pendingReports.set(requestId, reportPromise)

    try {
      const result = await reportPromise
      this.reportedUsage.add(requestId)
      return result
    } finally {
      this.pendingReports.delete(requestId)
      // 清理过期的已报告记录
      setTimeout(() => this.reportedUsage.delete(requestId), 60 * 1000) // 1分钟后清理
    }
  }

  async _performReport(requestId, usageData, apiKeyId, modelToRecord, accountId, requestMeta = null) {
    try {
      const normalized = normalizeOpenAITokenUsage(usageData)
      const { inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens } = normalized

      await apiKeyService.recordUsage(
        apiKeyId,
        buildTokenUsagePayload({
          ...normalized,
          rawUsage: usageData,
        }),
        modelToRecord,
        accountId,
        'azure-openai',
        resolveOpenAIServiceTier(usageData.service_tier, requestMeta?.requestBody?.service_tier),
        requestMeta,
      )

      // 同步更新 Azure 账户的 lastUsedAt 和累计使用量
      try {
        const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
        if (accountId) {
          await azureOpenaiAccountService.updateAccountUsage(accountId, totalTokens)
        }
      } catch (acctErr) {
        logger.warn(`Failed to update Azure account usage for ${accountId}: ${acctErr.message}`)
      }

      logger.info(
        `Azure OpenAI Usage recorded for ${requestId}: ` +
          `model=${modelToRecord}, ` +
          `input=${inputTokens}, output=${outputTokens}, ` +
          `cache_create=${cacheCreateTokens}, cache_read=${cacheReadTokens}`,
      )
      return true
    } catch (error) {
      logger.error('Failed to report Azure OpenAI usage:', error)
      return false
    }
  }
}

const usageReporter = new AtomicUsageReporter()

// 健康检查
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'azure-openai-relay',
    timestamp: new Date().toISOString(),
  })
})

// 获取可用模型列表（兼容 OpenAI API）
router.get(['/models', '/v1/models'], authenticateApiKey, authorizeAzureOpenAI, async (req, res) => {
  try {
    const models = ALL_ALLOWED_MODELS.map((model) => ({
      id: `azure/${model}`,
      object: 'model',
      created: Date.now(),
      owned_by: 'azure-openai',
    }))

    res.json({
      object: 'list',
      data: models,
    })
  } catch (error) {
    logger.error('Error fetching Azure OpenAI models:', error)
    res.status(500).json({ error: { message: 'Failed to fetch models' } })
  }
})

// 处理聊天完成请求
router.post(
  ['/chat/completions', '/v1/chat/completions'],
  authenticateApiKey,
  authorizeAzureOpenAI,
  async (req, res) => {
    const requestId = `azure_req_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`
    const sessionId = req.sessionId || req.headers['x-session-id'] || null

    logger.info(`Azure OpenAI Chat Request ${requestId}`, {
      apiKeyId: req.apiKey?.id,
      sessionId,
      model: req.body.model,
      stream: req.body.stream || false,
      messages: req.body.messages?.length || 0,
    })

    try {
      const account = await azureOpenaiAccountService.selectAvailableAccount(
        sessionId,
        req.apiKey?.azureOpenaiAccountId,
        req.body.model,
      )

      assertAzureModelAccess(req.apiKey, req.body.model, account)

      // 发送请求到 Azure OpenAI
      const response = await azureOpenaiRelayService.handleAzureOpenAIRequest({
        account,
        requestBody: req.body,
        headers: req.headers,
        isStream: req.body.stream || false,
        endpoint: 'chat/completions',
      })

      // 检查上游响应状态码（仅对认证/限流/服务端错误暂停，不对 400/404 等客户端错误暂停）
      const azureAutoProtectionDisabled =
        account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
      const shouldPause =
        account?.id &&
        !azureAutoProtectionDisabled &&
        (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500)
      if (shouldPause) {
        const customTtl = response.status === 429 ? upstreamErrorHelper.parseRetryAfter(response.headers) : null
        const errorContext = upstreamErrorHelper.buildErrorContext({
          url: response.config?.url,
          method: response.config?.method || 'POST',
          requestHeaders: req.headers,
          requestBody: req.body,
          model: req.body?.model,
          sessionId,
          responseStatus: response.status,
          responseHeaders: response.headers,
          responseBody: response.data,
        })
        await upstreamErrorHelper
          .markTempUnavailable(account.id, 'azure-openai', response.status, customTtl, errorContext)
          .catch(() => {})
      }

      // 处理流式响应
      if (req.body.stream) {
        await azureOpenaiRelayService.handleStreamResponse(response, res, {
          onEnd: async ({ usageData, actualModel }) => {
            if (usageData) {
              const modelToRecord = actualModel || req.body.model || 'unknown'
              await usageReporter.reportOnce(
                requestId,
                usageData,
                req.apiKey.id,
                modelToRecord,
                account.id,
                createRequestDetailMeta(req, {
                  requestBody: req.body,
                  stream: true,
                  statusCode: res.statusCode,
                }),
              )
            }
          },
          onError: (error) => {
            logger.error(`Stream error for request ${requestId}:`, error)
          },
        })
      } else {
        // 处理非流式响应
        const { usageData, actualModel } = azureOpenaiRelayService.handleNonStreamResponse(response, res)

        if (usageData) {
          const modelToRecord = actualModel || req.body.model || 'unknown'
          await usageReporter.reportOnce(
            requestId,
            usageData,
            req.apiKey.id,
            modelToRecord,
            account.id,
            createRequestDetailMeta(req, {
              requestBody: req.body,
              stream: false,
              statusCode: response.status,
            }),
          )
        }
      }
    } catch (error) {
      logger.error(`Azure OpenAI request failed ${requestId}:`, error)

      if (!res.headersSent) {
        const statusCode = error.statusCode ?? error.response?.status ?? 500
        const clientError = buildClientError({ statusCode, protocol: 'openai', upstreamBody: error.response?.data })
        res.status(clientError.statusCode).json(clientError.body)
      }
    }
  },
)

// 处理响应请求 (gpt-5, gpt-5-mini, codex-mini models)
router.post(['/responses', '/v1/responses'], authenticateApiKey, authorizeAzureOpenAI, async (req, res) => {
  const requestId = `azure_resp_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`
  const sessionId = req.sessionId || req.headers['x-session-id'] || null

  logger.info(`Azure OpenAI Responses Request ${requestId}`, {
    apiKeyId: req.apiKey?.id,
    sessionId,
    model: req.body.model,
    stream: req.body.stream || false,
    messages: req.body.messages?.length || 0,
  })

  try {
    const account = await azureOpenaiAccountService.selectAvailableAccount(
      sessionId,
      req.apiKey?.azureOpenaiAccountId,
      req.body.model,
    )

    assertAzureModelAccess(req.apiKey, req.body.model, account)

    // 发送请求到 Azure OpenAI
    const response = await azureOpenaiRelayService.handleAzureOpenAIRequest({
      account,
      requestBody: req.body,
      headers: req.headers,
      isStream: req.body.stream || false,
      endpoint: 'responses',
    })

    // 检查上游响应状态码（仅对认证/限流/服务端错误暂停，不对 400/404 等客户端错误暂停）
    const azureAutoProtectionDisabled =
      account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
    const shouldPause =
      account?.id &&
      !azureAutoProtectionDisabled &&
      (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500)
    if (shouldPause) {
      const customTtl = response.status === 429 ? upstreamErrorHelper.parseRetryAfter(response.headers) : null
      const errorContext = upstreamErrorHelper.buildErrorContext({
        url: response.config?.url,
        method: response.config?.method || 'POST',
        requestHeaders: req.headers,
        requestBody: req.body,
        model: req.body?.model,
        sessionId,
        responseStatus: response.status,
        responseHeaders: response.headers,
        responseBody: response.data,
      })
      await upstreamErrorHelper
        .markTempUnavailable(account.id, 'azure-openai', response.status, customTtl, errorContext)
        .catch(() => {})
    }

    // 处理流式响应
    if (req.body.stream) {
      await azureOpenaiRelayService.handleStreamResponse(response, res, {
        onEnd: async ({ usageData, actualModel }) => {
          if (usageData) {
            const modelToRecord = actualModel || req.body.model || 'unknown'
            await usageReporter.reportOnce(
              requestId,
              usageData,
              req.apiKey.id,
              modelToRecord,
              account.id,
              createRequestDetailMeta(req, {
                requestBody: req.body,
                stream: true,
                statusCode: res.statusCode,
              }),
            )
          }
        },
        onError: (error) => {
          logger.error(`Stream error for request ${requestId}:`, error)
        },
      })
    } else {
      // 处理非流式响应
      const { usageData, actualModel } = azureOpenaiRelayService.handleNonStreamResponse(response, res)

      if (usageData) {
        const modelToRecord = actualModel || req.body.model || 'unknown'
        await usageReporter.reportOnce(
          requestId,
          usageData,
          req.apiKey.id,
          modelToRecord,
          account.id,
          createRequestDetailMeta(req, {
            requestBody: req.body,
            stream: false,
            statusCode: response.status,
          }),
        )
      }
    }
  } catch (error) {
    logger.error(`Azure OpenAI responses request failed ${requestId}:`, error)

    if (!res.headersSent) {
      const statusCode = error.statusCode ?? error.response?.status ?? 500
      const clientError = buildClientError({ statusCode, protocol: 'openai', upstreamBody: error.response?.data })
      res.status(clientError.statusCode).json(clientError.body)
    }
  }
})

// 处理嵌入请求
router.post(['/embeddings', '/v1/embeddings'], authenticateApiKey, authorizeAzureOpenAI, async (req, res) => {
  const requestId = `azure_embed_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`
  const sessionId = req.sessionId || req.headers['x-session-id'] || null

  logger.info(`Azure OpenAI Embeddings Request ${requestId}`, {
    apiKeyId: req.apiKey?.id,
    sessionId,
    model: req.body.model,
    input: Array.isArray(req.body.input) ? req.body.input.length : 1,
  })

  try {
    const account = await azureOpenaiAccountService.selectAvailableAccount(
      sessionId,
      req.apiKey?.azureOpenaiAccountId,
      req.body.model,
    )

    assertAzureModelAccess(req.apiKey, req.body.model, account)

    // 发送请求到 Azure OpenAI
    const response = await azureOpenaiRelayService.handleAzureOpenAIRequest({
      account,
      requestBody: req.body,
      headers: req.headers,
      isStream: false,
      endpoint: 'embeddings',
    })

    // 检查上游响应状态码（仅对认证/限流/服务端错误暂停，不对 400/404 等客户端错误暂停）
    const azureAutoProtectionDisabled =
      account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
    const shouldPause =
      account?.id &&
      !azureAutoProtectionDisabled &&
      (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500)
    if (shouldPause) {
      const customTtl = response.status === 429 ? upstreamErrorHelper.parseRetryAfter(response.headers) : null
      const errorContext = upstreamErrorHelper.buildErrorContext({
        url: response.config?.url,
        method: response.config?.method || 'POST',
        requestHeaders: req.headers,
        requestBody: req.body,
        model: req.body?.model,
        sessionId,
        responseStatus: response.status,
        responseHeaders: response.headers,
        responseBody: response.data,
      })
      await upstreamErrorHelper
        .markTempUnavailable(account.id, 'azure-openai', response.status, customTtl, errorContext)
        .catch(() => {})
    }

    // 处理响应
    const { usageData, actualModel } = azureOpenaiRelayService.handleNonStreamResponse(response, res)

    if (usageData) {
      const modelToRecord = actualModel || req.body.model || 'unknown'
      await usageReporter.reportOnce(
        requestId,
        usageData,
        req.apiKey.id,
        modelToRecord,
        account.id,
        createRequestDetailMeta(req, {
          requestBody: req.body,
          stream: false,
          statusCode: response.status,
        }),
      )
    }
  } catch (error) {
    logger.error(`Azure OpenAI embeddings request failed ${requestId}:`, error)

    if (!res.headersSent) {
      const statusCode = error.statusCode ?? error.response?.status ?? 500
      const clientError = buildClientError({ statusCode, protocol: 'openai', upstreamBody: error.response?.data })
      res.status(clientError.statusCode).json(clientError.body)
    }
  }
})

// 获取使用统计
router.get(['/usage', '/v1/usage'], authenticateApiKey, authorizeAzureOpenAI, async (req, res) => {
  try {
    const { start_date, end_date } = req.query
    const usage = await apiKeyService.getUsageStats(req.apiKey.id, start_date, end_date)

    res.json({
      object: 'usage',
      data: usage,
    })
  } catch (error) {
    logger.error('Error fetching Azure OpenAI usage:', error)
    res.status(500).json({ error: { message: 'Failed to fetch usage data' } })
  }
})
