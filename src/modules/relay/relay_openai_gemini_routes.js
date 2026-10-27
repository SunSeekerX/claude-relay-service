import { GeminiToOpenAIConverter, getGeminiPromptBlockReason } from './relay_gemini_to_openai.js'
import express from 'express'
import { IncrementalSSEParser } from './relay_sse_parser.js'
import { createStreamBackpressure } from '../../common/stream_helper.js'
import { buildClientError } from '../../common/client_error_builder.js'
import { requestDetailService } from './relay_request_detail_service.js'
import { buildOpenAIChatGeminiRequest } from './relay_openai_gemini_request.js'
import { logger } from '../../common/logger.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import { authenticateApiKey } from '../../infra/middleware_auth.js'
import * as geminiAccountService from '../account/account_gemini_service.js'
import { unifiedGeminiScheduler } from './relay_unified_gemini_scheduler.js'
import { getAvailableModels } from './relay_gemini_relay_service.js'
import crypto from 'node:crypto'
import { apiKeyService } from '../apikey/apikey_service.js'
import { buildGeminiTokenUsagePayload, createRequestDetailMeta } from './relay_request_detail_helper.js'
import { ensureAntigravityProjectId } from './relay_antigravity_client.js'
export const router = express.Router()

// 生成会话哈希
const generateSessionHash = (req) => {
  const authSource = req.headers['authorization'] || req.headers['x-api-key'] || req.headers['x-goog-api-key']

  const sessionData = [req.headers['user-agent'], req.ip, authSource?.substring(0, 20)].filter(Boolean).join(':')

  return crypto.createHash('sha256').update(sessionData).digest('hex')
}

// 检查 API Key 权限
const checkPermissions = (apiKeyData, requiredPermission = 'gemini') =>
  apiKeyService.hasPermission(apiKeyData?.permissions, requiredPermission)

const geminiConverter = new GeminiToOpenAIConverter()

// OpenAI 兼容的聊天完成端点
router.post('/v1/chat/completions', authenticateApiKey, async (req, res) => {
  const startTime = Date.now()
  let abortController = null
  let account = null // Declare account outside try block for error handling
  let accountSelection = null // Declare accountSelection for error handling
  let sessionHash = null // Declare sessionHash for error handling

  try {
    const apiKeyData = req.apiKey

    // 检查权限
    if (!checkPermissions(apiKeyData, 'gemini')) {
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access Gemini',
          type: 'permission_denied',
          code: 'permission_denied',
        },
      })
    }
    // 处理请求体结构 - 支持多种格式
    let requestBody = req.body

    // 如果请求体被包装在 body 字段中，解包它
    if (req.body.body && typeof req.body.body === 'object') {
      requestBody = req.body.body
    }

    // 从 URL 路径中提取模型信息（如果存在）
    let urlModel = null
    const urlPath = req.body?.config?.url || req.originalUrl || req.url
    const modelMatch = urlPath.match(/\/([^/]+):(?:stream)?[Gg]enerateContent/)
    if (modelMatch) {
      urlModel = modelMatch[1]
      logger.debug(`Extracted model from URL: ${urlModel}`)
    }

    // 提取请求参数
    const {
      messages: requestMessages,
      contents: requestContents,
      model: bodyModel = 'gemini-2.5-flash',
      stream = false,
    } = requestBody

    // 检查URL中是否包含stream标识
    const isStreamFromUrl = urlPath && urlPath.includes('streamGenerateContent')
    const actualStream = stream || isStreamFromUrl

    // 优先使用 URL 中的模型，其次是请求体中的模型
    const model = urlModel || bodyModel

    // 支持两种格式: OpenAI 的 messages 或 Gemini 的 contents
    let messages = requestMessages
    if (requestContents && Array.isArray(requestContents)) {
      messages = requestContents
    }

    // 验证必需参数
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'Messages array is required',
          type: 'invalid_request_error',
          code: 'invalid_request',
        },
      })
    }

    // 检查模型限制
    if (apiKeyData.enableModelRestriction && apiKeyData.restrictedModels.length > 0) {
      if (!apiKeyData.restrictedModels.includes(model)) {
        return res.status(403).json({
          error: {
            message: `Model ${model} is not allowed for this API key`,
            type: 'invalid_request_error',
            code: 'model_not_allowed',
          },
        })
      }
    }

    // 生成会话哈希用于粘性会话
    sessionHash = generateSessionHash(req)

    // 选择可用的 Gemini 账户
    try {
      accountSelection = await unifiedGeminiScheduler.selectAccountForApiKey(apiKeyData, sessionHash, model)
      account = await geminiAccountService.getAccount(accountSelection.accountId)
    } catch (error) {
      logger.error('Failed to select Gemini account:', error)
      account = null
    }

    if (!account) {
      return res.status(503).json({
        error: {
          message: 'No available Gemini accounts',
          type: 'service_unavailable',
          code: 'service_unavailable',
        },
      })
    }

    const geminiRequestBody = buildOpenAIChatGeminiRequest(requestBody, { vendor: account.oauthProvider })
    logger.info(`Using Gemini account: ${account.id} for API key: ${apiKeyData.id}`)

    // 标记账户被使用
    await geminiAccountService.markAccountUsed(account.id)

    // 解析账户的代理配置
    let proxyConfig = null
    if (account.proxy) {
      try {
        proxyConfig = typeof account.proxy === 'string' ? JSON.parse(account.proxy) : account.proxy
      } catch (e) {
        logger.warn('Failed to parse proxy configuration:', e)
      }
    }

    // 创建中止控制器
    abortController = new AbortController()

    // 客户端断开：只用 res 判据
    onClientDisconnect(
      res,
      () => {
        if (abortController && !abortController.signal.aborted) {
          logger.info('Client disconnected, aborting Gemini request')
          abortController.abort()
        }
      },
      'OpenAI-Gemini request',
    )

    // 获取OAuth客户端
    const client = await geminiAccountService.getOauthClient(
      account.accessToken,
      account.refreshToken,
      proxyConfig,
      account.oauthProvider,
    )
    if (actualStream) {
      // 流式响应
      const oauthProvider = account.oauthProvider || 'gemini-cli'
      let { projectId } = account

      if (oauthProvider === 'antigravity') {
        projectId = ensureAntigravityProjectId(account)
        if (!account.projectId && account.tempProjectId !== projectId) {
          await geminiAccountService.updateTempProjectId(account.id, projectId)
          account.tempProjectId = projectId
        }
      }

      logger.info('StreamGenerateContent request', {
        model,
        projectId,
        apiKeyId: apiKeyData.id,
      })

      const streamResponse =
        oauthProvider === 'antigravity'
          ? await geminiAccountService.generateContentStreamAntigravity(
              client,
              { model, request: geminiRequestBody },
              null, // user_prompt_id
              projectId,
              apiKeyData.id, // 使用 API Key ID 作为 session ID
              abortController.signal, // 传递中止信号
              proxyConfig, // 传递代理配置
            )
          : await geminiAccountService.generateContentStream(
              client,
              { model, request: geminiRequestBody },
              null, // user_prompt_id
              projectId, // 使用有权限的项目ID
              apiKeyData.id, // 使用 API Key ID 作为 session ID
              abortController.signal, // 传递中止信号
              proxyConfig, // 传递代理配置
            )

      // 设置流式响应头
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')

      const parser = new IncrementalSSEParser()
      const state = geminiConverter.createStreamState()
      const backpressure = createStreamBackpressure(streamResponse, res)
      let usage = null
      let terminal = false
      let result = { statusCode: 200, errorCode: null, errorMessage: null }
      const consume = async (events) => {
        for (const event of events) {
          if (event.type === 'invalid') {
            throw Object.assign(new Error('Invalid Gemini SSE payload'), { code: 'upstream_parse_error' })
          }
          if (event.type !== 'data') {
            continue
          }
          const data = event.data.response ?? event.data
          if (data.error) {
            const status = Number(data.error.code)
            throw Object.assign(new Error('Gemini upstream reported an error'), {
              status: status >= 400 && status <= 599 ? status : 502,
              upstreamBody: { error: data.error },
              code: 'upstream_stream_error',
            })
          }
          if (data.usageMetadata) {
            usage = data.usageMetadata
          }
          const blockReason = getGeminiPromptBlockReason(data)
          if (blockReason) {
            terminal = true
            result.errorMessage = `Gemini prompt blocked: ${blockReason}`
            result.protocolTerminal = 'content_filter'
          }
          terminal ||= Boolean(data.candidates?.some((candidate) => candidate.finishReason))
          const converted = geminiConverter.convertStreamEvent(data, model, state)
          if (converted && !res.destroyed && !res.writableEnded && !res.write(converted)) {
            await backpressure.waitForDrain()
          }
        }
      }
      try {
        for await (const chunk of streamResponse) {
          await consume(parser.feed(chunk))
        }
        await consume(parser.finish())
        if (!terminal) {
          throw Object.assign(new Error('Gemini stream ended before a finish reason'), {
            code: 'upstream_stream_incomplete',
          })
        }
      } catch (error) {
        const statusCode = res.destroyed ? 499 : error.status || 502
        result = { statusCode, errorCode: error.code || 'upstream_stream_error', errorMessage: error.message }
        logger.error('OpenAI-Gemini stream failed', { requestId: req.requestId, ...result })
        if (!res.destroyed && !res.writableEnded) {
          if (!res.headersSent) {
            res.status(statusCode)
          }
          const clientError = buildClientError({
            statusCode,
            upstreamBody: error.upstreamBody ?? { error: { message: error.message, code: error.code } },
          })
          res.write(`data: ${JSON.stringify(clientError.body)}\n\n`)
        }
      } finally {
        backpressure.dispose()
        req._crsUsageDetailHandled = true
        req._crsRecordRelayResult?.({ ...result, hasUsage: Boolean(usage), final: true })
        try {
          if (usage) {
            await apiKeyService.recordUsage(
              apiKeyData.id,
              buildGeminiTokenUsagePayload(usage),
              model,
              account.id,
              'gemini',
              null,
              createRequestDetailMeta(req, { ...result, requestBody: req.body, stream: true }),
            )
          } else {
            await requestDetailService.captureUnmeteredRequest(req, {
              apiKeyId: apiKeyData.id,
              accountId: account.id,
              accountType: 'gemini',
              result: { ...result, model, stream: true },
            })
          }
        } catch (error) {
          logger.error('Failed to record Gemini stream usage:', error)
        }
        if (!res.destroyed && !res.writableEnded) {
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }
    } else {
      // 非流式响应
      const oauthProvider = account.oauthProvider || 'gemini-cli'
      let { projectId } = account

      if (oauthProvider === 'antigravity') {
        projectId = ensureAntigravityProjectId(account)
        if (!account.projectId && account.tempProjectId !== projectId) {
          await geminiAccountService.updateTempProjectId(account.id, projectId)
          account.tempProjectId = projectId
        }
      }

      logger.info('GenerateContent request', {
        model,
        projectId,
        apiKeyId: apiKeyData.id,
      })

      const response =
        oauthProvider === 'antigravity'
          ? await geminiAccountService.generateContentAntigravity(
              client,
              { model, request: geminiRequestBody },
              null, // user_prompt_id
              projectId,
              apiKeyData.id, // 使用 API Key ID 作为 session ID
              proxyConfig, // 传递代理配置
            )
          : await geminiAccountService.generateContent(
              client,
              { model, request: geminiRequestBody },
              null, // user_prompt_id
              projectId, // 使用有权限的项目ID
              apiKeyData.id, // 使用 API Key ID 作为 session ID
              proxyConfig, // 传递代理配置
            )

      // 转换为 OpenAI 格式并返回
      const openaiResponse = geminiConverter.convertResponse(response, model)
      const blockReason = getGeminiPromptBlockReason(response)
      const blockResult = blockReason
        ? {
            statusCode: 200,
            errorCode: null,
            errorMessage: `Gemini prompt blocked: ${blockReason}`,
            protocolTerminal: 'content_filter',
          }
        : {}

      // 记录使用统计
      if (openaiResponse.usage) {
        try {
          await apiKeyService.recordUsage(
            apiKeyData.id,
            buildGeminiTokenUsagePayload((response.response ?? response).usageMetadata),
            model,
            account.id,
            'gemini',
            null,
            createRequestDetailMeta(req, {
              requestBody: req.body,
              stream: false,
              statusCode: res.statusCode || 200,
              ...blockResult,
            }),
          )
          logger.info(
            `Recorded Gemini usage - Input: ${openaiResponse.usage.prompt_tokens}, Output: ${openaiResponse.usage.completion_tokens}, Total: ${openaiResponse.usage.total_tokens}`,
          )
        } catch (error) {
          logger.error('Failed to record Gemini usage:', error)
        }
      }

      if (blockReason) {
        req._crsUsageDetailHandled = true
        req._crsRecordRelayResult?.({ ...blockResult, hasUsage: Boolean(openaiResponse.usage), final: true })
        if (!openaiResponse.usage) {
          try {
            await requestDetailService.captureUnmeteredRequest(req, {
              apiKeyId: apiKeyData.id,
              accountId: account.id,
              accountType: 'gemini',
              result: { ...blockResult, model, stream: false },
            })
          } catch (error) {
            logger.error('Failed to record Gemini blocked prompt:', error)
          }
        }
      }

      res.json(openaiResponse)
    }

    const duration = Date.now() - startTime
    logger.info(`OpenAI-Gemini request completed in ${duration}ms`)
  } catch (error) {
    const statusForLog = error?.status || error?.response?.status
    logger.error('OpenAI-Gemini request error', {
      message: error?.message,
      status: statusForLog,
      code: error?.code,
      requestUrl: error?.config?.url,
      requestMethod: error?.config?.method,
      upstreamTraceId: error?.response?.headers?.['x-cloudaicompanion-trace-id'],
    })

    // 处理速率限制
    if (error.status === 429) {
      if (req.apiKey && account && accountSelection) {
        await unifiedGeminiScheduler.markAccountRateLimited(account.id, 'gemini', sessionHash)
      }
    }

    // 检查响应是否已发送（流式响应场景），避免 ERR_HTTP_HEADERS_SENT
    if (!res.headersSent) {
      // 客户端断开使用 499 状态码 (Client Closed Request)
      if (error.message === 'Client disconnected') {
        res.status(499).end()
      } else {
        // 返回 OpenAI 格式的错误响应
        const clientError = buildClientError({
          statusCode: error.status || error.response?.status || 500,
          upstreamBody: error.response?.data ?? {
            error: error.error ?? { message: error.message, code: error.code },
          },
        })
        res.status(clientError.statusCode).json(clientError.body)
      }
    }
  } finally {
    // 清理资源
    if (abortController) {
      abortController = null
    }
  }
  return undefined
})

// 获取可用模型列表的共享处理器
const handleGetModels = async (req, res) => {
  try {
    const apiKeyData = req.apiKey

    // 检查权限
    if (!checkPermissions(apiKeyData, 'gemini')) {
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access Gemini',
          type: 'permission_denied',
          code: 'permission_denied',
        },
      })
    }

    // 选择账户获取模型列表
    let account = null
    try {
      const accountSelection = await unifiedGeminiScheduler.selectAccountForApiKey(apiKeyData, null, null)
      account = await geminiAccountService.getAccount(accountSelection.accountId)
    } catch (error) {
      logger.warn('Failed to select Gemini account for models endpoint:', error)
    }

    let models = []

    if (account) {
      // 获取实际的模型列表（失败时回退到默认列表，避免影响 /v1/models 可用性）
      try {
        const oauthProvider = account.oauthProvider || 'gemini-cli'
        models =
          oauthProvider === 'antigravity'
            ? await geminiAccountService.fetchAvailableModelsAntigravity(
                account.accessToken,
                account.proxy,
                account.refreshToken,
              )
            : await getAvailableModels(account.accessToken, account.proxy)
      } catch (error) {
        logger.warn('Failed to get Gemini models list from upstream, fallback to default:', error)
        models = []
      }
    } else {
      // 返回默认模型列表
      models = [
        {
          id: 'gemini-2.5-flash',
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'google',
        },
      ]
    }

    if (!models || models.length === 0) {
      models = [
        {
          id: 'gemini-2.5-flash',
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'google',
        },
      ]
    }

    // 如果启用了模型限制，过滤模型列表
    if (apiKeyData.enableModelRestriction && apiKeyData.restrictedModels.length > 0) {
      models = models.filter((model) => apiKeyData.restrictedModels.includes(model.id))
    }

    res.json({
      object: 'list',
      data: models,
    })
  } catch (error) {
    logger.error('Failed to get OpenAI-Gemini models:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve models',
        type: 'server_error',
        code: 'internal_error',
      },
    })
  }
}

// OpenAI 兼容的模型列表端点 (带 v1 版)
router.get('/v1/models', authenticateApiKey, handleGetModels)

// OpenAI 兼容的模型列表端点 (根路径版，方便第三方加载)
router.get('/models', authenticateApiKey, handleGetModels)

// OpenAI 兼容的模型详情端点
router.get('/v1/models/:model', authenticateApiKey, async (req, res) => {
  try {
    const apiKeyData = req.apiKey
    const modelId = req.params.model

    // 检查权限
    if (!checkPermissions(apiKeyData, 'gemini')) {
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access Gemini',
          type: 'permission_denied',
          code: 'permission_denied',
        },
      })
    }

    // 检查模型限制
    if (apiKeyData.enableModelRestriction && apiKeyData.restrictedModels.length > 0) {
      if (!apiKeyData.restrictedModels.includes(modelId)) {
        return res.status(404).json({
          error: {
            message: `Model '${modelId}'not found`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        })
      }
    }

    // 返回模型信息
    res.json({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'google',
      permission: [],
      root: modelId,
      parent: null,
    })
  } catch (error) {
    logger.error('Failed to get model details:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve model details',
        type: 'server_error',
        code: 'internal_error',
      },
    })
  }
  return undefined
})
