import axios from 'axios'
import { config } from '../../../config/config.js'
import { logger } from '../../common/logger.js'
import { ProxyHelper } from '../proxy/proxy_helper.js'
import { timedUpstreamRequest } from '../../common/request_timing.js'
import { createStreamBackpressure } from '../../common/stream_helper.js'
import { buildClientError } from '../../common/client_error_builder.js'
import * as geminiAccountService from '../account/account_gemini_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { buildGeminiTokenUsagePayload, createRequestDetailMeta } from './relay_request_detail_helper.js'
import { requestDetailService } from './relay_request_detail_service.js'
import { buildOpenAIChatGeminiRequest } from './relay_openai_gemini_request.js'
import { GeminiToOpenAIConverter, getGeminiPromptBlockReason } from './relay_gemini_to_openai.js'
import { IncrementalSSEParser } from './relay_sse_parser.js'
import { ensureAntigravityProjectId } from './relay_antigravity_client.js'

const GEMINI_API_BASE = 'https://cloudcode.googleapis.com/v1'
const createProxyAgent = (proxyConfig) => ProxyHelper.createProxyAgent(proxyConfig)
const geminiConverter = new GeminiToOpenAIConverter()

// 已完成认证和选号的 Chat 入口共用官方 OAuth 请求、转换及结算。
export const relayGeminiChatResponse = async ({
  req,
  res,
  account,
  model,
  stream,
  requestBody,
  signal,
  proxyConfig,
}) => {
  const apiKeyData = req.apiKey
  const antigravity = account.oauthProvider === 'antigravity'
  const request = buildOpenAIChatGeminiRequest(requestBody, { vendor: account.oauthProvider })
  let projectId = account.projectId ?? account.tempProjectId ?? null
  if (antigravity) {
    projectId = ensureAntigravityProjectId(account)
    if (!account.projectId && account.tempProjectId !== projectId) {
      await geminiAccountService.updateTempProjectId(account.id, projectId)
    }
  }
  const client = await geminiAccountService.getOauthClient(
    account.accessToken,
    account.refreshToken,
    proxyConfig,
    account.oauthProvider,
  )
  const generate = stream
    ? antigravity
      ? geminiAccountService.generateContentStreamAntigravity
      : geminiAccountService.generateContentStream
    : antigravity
      ? geminiAccountService.generateContentAntigravity
      : geminiAccountService.generateContent
  const { data: response } = await timedUpstreamRequest(req, async () => ({
    data: await generate(
      client,
      { model, request },
      requestBody.user_prompt_id ?? null,
      projectId,
      apiKeyData.id,
      ...(stream ? [signal, proxyConfig] : [proxyConfig, signal]),
    ),
  }))
  const settle = async (usage, result) => {
    req._crsUsageDetailHandled = true
    req._crsProtocolTerminal = result.protocolTerminal ?? null
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
          createRequestDetailMeta(req, { ...result, requestBody: req.body, stream }),
        )
      } else {
        await requestDetailService.captureUnmeteredRequest(req, {
          apiKeyId: apiKeyData.id,
          accountId: account.id,
          accountType: 'gemini',
          result: { ...result, model, stream },
        })
      }
    } catch (error) {
      logger.error('Failed to record Gemini Chat usage:', error)
    }
  }
  if (!stream) {
    const data = response.response ?? response
    const openaiResponse = geminiConverter.convertResponse(response, model)
    const blocked = getGeminiPromptBlockReason(data)
    const result = {
      statusCode: 200,
      errorCode: null,
      errorMessage: blocked ? `Gemini prompt blocked: ${blocked}` : null,
      protocolTerminal: blocked
        ? 'content_filter'
        : (data.candidates?.find((item) => item.finishReason)?.finishReason ?? null),
    }
    await settle(data.usageMetadata, result)
    if (!res.destroyed && !res.writableEnded) {
      res.json(openaiResponse)
    }
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  const parser = new IncrementalSSEParser()
  const state = geminiConverter.createStreamState()
  const backpressure = createStreamBackpressure(response, res)
  let usage = null
  let result = { statusCode: 200, errorCode: null, errorMessage: null, protocolTerminal: null }
  const consume = async (events) => {
    for (const event of events) {
      if (event.type === 'invalid') {
        throw Object.assign(new Error('Invalid Gemini SSE payload'), { code: 'upstream_parse_error' })
      }
      if (event.type !== 'data') {
        continue
      }
      const data = event.data.response ?? event.data
      if (data.usageMetadata) {
        usage = data.usageMetadata
      }
      if (data.error) {
        const status = Number(data.error.code)
        throw Object.assign(new Error('Gemini upstream reported an error'), {
          status: status >= 400 && status <= 599 ? status : 502,
          upstreamBody: { error: data.error },
          code: 'upstream_stream_error',
        })
      }
      const blocked = getGeminiPromptBlockReason(data)
      if (blocked) {
        result.errorMessage = `Gemini prompt blocked: ${blocked}`
        result.protocolTerminal = 'content_filter'
      } else {
        result.protocolTerminal ??=
          data.candidates?.find(
            (candidate) => candidate.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED',
          )?.finishReason ?? null
      }
      const converted = geminiConverter.convertStreamEvent(data, model, state)
      if (converted && !res.destroyed && !res.writableEnded && !res.write(converted)) {
        await backpressure.waitForDrain()
      }
    }
  }
  try {
    for await (const chunk of response) {
      await consume(parser.feed(chunk))
    }
    await consume(parser.finish())
    if (!result.protocolTerminal) {
      throw Object.assign(new Error('Gemini stream ended before a finish reason'), {
        code: 'upstream_stream_incomplete',
      })
    }
  } catch (error) {
    const statusCode = res.destroyed ? 499 : (error.status ?? 502)
    result = {
      ...result,
      statusCode,
      errorCode: error.code ?? 'upstream_stream_error',
      errorMessage: error.message,
    }
    logger.warn('Gemini Chat stream failed', { requestId: req.requestId, ...result })
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
    await settle(usage, result)
    if (!res.destroyed && !res.writableEnded) {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
}

// 获取可用模型列表
export const getAvailableModels = async (accessToken, proxy, projectId, location = 'us-central1') => {
  let apiUrl
  if (projectId) {
    // 使用项目特定的 URL 格式
    apiUrl = `${GEMINI_API_BASE}/projects/${projectId}/locations/${location}/models`
    logger.debug(`Fetching models with projectId: ${projectId}, location: ${location}`)
  } else {
    // 使用标准 URL 格式
    apiUrl = `${GEMINI_API_BASE}/models`
    logger.debug('Fetching models without projectId')
  }

  const axiosConfig = {
    method: 'GET',
    url: apiUrl,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    timeout: config.requestTimeout || 600000,
  }

  const proxyAgent = createProxyAgent(proxy)
  if (proxyAgent) {
    // 只设置 httpsAgent，目标 URL 为 HTTPS
    axiosConfig.httpsAgent = proxyAgent
    axiosConfig.proxy = false
    logger.info(`Using proxy for Gemini models request: ${ProxyHelper.getProxyDescription(proxy)}`)
  } else {
    logger.debug('No proxy configured for Gemini models request')
  }

  try {
    const response = await axios(axiosConfig)
    const models = response.data.models || []

    // 转换为 OpenAI 格式
    return models
      .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
      .map((model) => ({
        id: model.name.replace('models/', ''),
        object: 'model',
        created: Date.now() / 1000,
        owned_by: 'google',
      }))
  } catch (error) {
    logger.error('Failed to get Gemini models:', error)
    // 返回默认模型列表
    return [
      {
        id: 'gemini-2.5-flash',
        object: 'model',
        created: Date.now() / 1000,
        owned_by: 'google',
      },
    ]
  }
}

// Count Tokens API - 用于Gemini CLI兼容性
export const countTokens = async ({ model, content, accessToken, proxy, projectId, location = 'us-central1' }) => {
  // 确保模型名称格式正确
  if (!model.startsWith('models/')) {
    model = `models/${model}`
  }

  // 转换内容格式 - 支持多种输入格式
  let requestBody
  if (Array.isArray(content)) {
    // 如果content是数组，直接使用
    requestBody = { contents: content }
  } else if (typeof content === 'string') {
    // 如果是字符串，转换为Gemini格式
    requestBody = {
      contents: [
        {
          parts: [{ text: content }],
        },
      ],
    }
  } else if (content.parts || content.role) {
    // 如果已经是Gemini格式的单个content
    requestBody = { contents: [content] }
  } else {
    // 其他情况，尝试直接使用
    requestBody = { contents: content }
  }

  // 构建API URL - countTokens需要使用generativelanguage API
  const GENERATIVE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
  let apiUrl
  if (projectId) {
    // 使用项目特定的 URL 格式（Google Cloud/Workspace 账号）
    apiUrl = `${GENERATIVE_API_BASE}/projects/${projectId}/locations/${location}/${model}:countTokens`
    logger.debug(`Using project-specific countTokens URL with projectId: ${projectId}, location: ${location}`)
  } else {
    // 使用标准 URL 格式（个人 Google 账号）
    apiUrl = `${GENERATIVE_API_BASE}/${model}:countTokens`
    logger.debug('Using standard countTokens URL without projectId')
  }

  const axiosConfig = {
    method: 'POST',
    url: apiUrl,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Goog-User-Project': projectId || undefined,
    },
    data: requestBody,
    timeout: config.requestTimeout || 600000,
  }

  // 添加代理配置
  const proxyAgent = createProxyAgent(proxy)
  if (proxyAgent) {
    // 只设置 httpsAgent，目标 URL 为 HTTPS
    axiosConfig.httpsAgent = proxyAgent
    axiosConfig.proxy = false
    logger.info(`Using proxy for Gemini countTokens request: ${ProxyHelper.getProxyDescription(proxy)}`)
  } else {
    logger.debug('No proxy configured for Gemini countTokens request')
  }

  try {
    logger.debug(`Sending countTokens request to: ${apiUrl}`)
    logger.debug(`Request body: ${JSON.stringify(requestBody, null, 2)}`)
    const response = await axios(axiosConfig)

    // 返回符合Gemini API格式的响应
    return {
      totalTokens: response.data.totalTokens || 0,
      totalBillableCharacters: response.data.totalBillableCharacters || 0,
      ...response.data,
    }
  } catch (error) {
    logger.error(`Gemini countTokens API request failed for URL: ${apiUrl}`)
    logger.error(
      'Request config:',
      JSON.stringify(
        {
          url: apiUrl,
          headers: axiosConfig.headers,
          data: requestBody,
        },
        null,
        2,
      ),
    )
    logger.error('Error details:', error.response?.data || error.message)

    // 转换错误格式
    if (error.response) {
      const geminiError = error.response.data?.error
      const errorObj = new Error(
        geminiError?.message || `Gemini countTokens API request failed (Status: ${error.response.status})`,
      )
      errorObj.status = error.response.status
      errorObj.error = {
        message: geminiError?.message || `Gemini countTokens API request failed (Status: ${error.response.status})`,
        type: geminiError?.code || 'api_error',
        code: geminiError?.code,
      }
      throw errorObj
    }

    const errorObj = new Error(error.message)
    errorObj.status = 500
    errorObj.error = {
      message: error.message,
      type: 'network_error',
    }
    throw errorObj
  }
}
