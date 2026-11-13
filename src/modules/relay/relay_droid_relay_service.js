import https from 'node:https'
import axios from 'axios'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { droidScheduler } from './relay_droid_scheduler.js'
import { droidAccountService } from '../account/account_droid_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { redis } from '../../infra/redis.js'
import { updateRateLimitCounters } from './relay_rate_limit_helper.js'
import { logger } from '../../common/logger.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import { runtimeAddon } from '../../common/runtime_addon.js'
import * as upstreamErrorHelper from './relay_upstream_error_helper.js'
import {
  createRequestDetailMeta,
  buildTokenUsagePayload,
  normalizeOpenAITokenUsage,
  resolveOpenAIServiceTier,
} from './relay_request_detail_helper.js'
import { IncrementalSSEParser } from './relay_sse_parser.js'
import { ClaudeStreamState } from './relay_claude_stream_state.js'
import { ResponsesStreamState } from './relay_responses_stream_state.js'
import { createStreamBackpressure } from '../../common/stream_helper.js'
import { buildClientError } from '../../common/client_error_builder.js'
import { RedisKeys } from '../../infra/redis_key.js'

const SYSTEM_PROMPT = 'You are Droid, an AI software engineering agent built by Factory.'
const RUNTIME_EVENT_FMT_PAYLOAD = 'fmtPayload'

/**
 * Droid API 转发服务
 */

class DroidRelayService {
  constructor() {
    this.factoryApiBaseUrl = 'https://api.factory.ai/api/llm'

    this.endpoints = {
      anthropic: '/a/v1/messages',
      openai: '/o/v1/responses',
      comm: '/o/v1/chat/completions',
    }

    this.userAgent = 'factory-cli/0.32.1'
    this.systemPrompt = SYSTEM_PROMPT
  }

  _normalizeEndpointType(endpointType) {
    if (!endpointType) {
      return 'anthropic'
    }

    const normalized = String(endpointType).toLowerCase()
    if (normalized === 'openai') {
      return 'openai'
    }

    if (normalized === 'comm') {
      return 'comm'
    }

    if (normalized === 'anthropic') {
      return 'anthropic'
    }

    return 'anthropic'
  }

  _normalizeRequestBody(requestBody, endpointType) {
    if (!requestBody || typeof requestBody !== 'object') {
      return requestBody
    }

    const normalizedBody = { ...requestBody }

    if (endpointType === 'anthropic' && typeof normalizedBody.model === 'string') {
      const originalModel = normalizedBody.model
      const trimmedModel = originalModel.trim()
      const lowerModel = trimmedModel.toLowerCase()

      if (lowerModel.includes('haiku')) {
        const mappedModel = 'claude-sonnet-4-20250514'
        if (originalModel !== mappedModel) {
          logger.info(`将请求模型从 ${originalModel} 映射为 ${mappedModel}`)
        }
        normalizedBody.model = mappedModel
      }
    }

    if (endpointType === 'openai' && typeof normalizedBody.model === 'string') {
      const originalModel = normalizedBody.model
      const trimmedModel = originalModel.trim()
      const lowerModel = trimmedModel.toLowerCase()

      if (lowerModel === 'gpt-5') {
        const mappedModel = 'gpt-5-2025-08-07'
        if (originalModel !== mappedModel) {
          logger.info(`将请求模型从 ${originalModel} 映射为 ${mappedModel}`)
        }
        normalizedBody.model = mappedModel
      }
    }

    return normalizedBody
  }

  async _applyRateLimitTracking(
    rateLimitInfo,
    usageSummary,
    model,
    context = '',
    keyId = null,
    preCalculatedCost = null,
  ) {
    if (!rateLimitInfo) {
      return
    }

    try {
      const { totalTokens, totalCost } = await updateRateLimitCounters(
        rateLimitInfo,
        usageSummary,
        model,
        keyId,
        'droid',
        preCalculatedCost,
      )

      if (totalTokens > 0) {
        logger.api(`Updated rate limit token count${context}: +${totalTokens}`)
      }
      if (typeof totalCost === 'number' && totalCost > 0) {
        logger.api(`Updated rate limit cost count${context}: +$${totalCost.toFixed(6)}`)
      }
    } catch (error) {
      logger.error(`Failed to update rate limit counters${context}:`, error)
    }
  }

  _composeApiKeyStickyKey(accountId, endpointType, sessionHash) {
    if (!accountId || !sessionHash) {
      return null
    }

    const normalizedEndpoint = this._normalizeEndpointType(endpointType)
    return RedisKeys.accounts.droidApiKey(accountId, normalizedEndpoint, sessionHash)
  }

  async _selectApiKey(account, endpointType, sessionHash) {
    const entries = await droidAccountService.getDecryptedApiKeyEntries(account.id)
    if (!entries || entries.length === 0) {
      throw new Error(`Droid account ${account.id} 未配置任何 API Key`)
    }

    // 过滤掉异常状态的API Key
    const activeEntries = entries.filter((entry) => entry.status !== 'error')
    if (!activeEntries || activeEntries.length === 0) {
      throw new Error(`Droid account ${account.id} 没有可用的 API Key（所有API Key均已异常）`)
    }

    const stickyKey = this._composeApiKeyStickyKey(account.id, endpointType, sessionHash)

    if (stickyKey) {
      const mappedKeyId = await redis.getSessionAccountMapping(stickyKey)
      if (mappedKeyId) {
        const mappedEntry = activeEntries.find((entry) => entry.id === mappedKeyId)
        if (mappedEntry) {
          await redis.extendSessionAccountMappingTTL(stickyKey)
          await droidAccountService.touchApiKeyUsage(account.id, mappedEntry.id)
          logger.info(`使用已绑定的 Droid API Key ${mappedEntry.id}（Account: ${account.id}）`)
          return mappedEntry
        }

        await redis.deleteSessionAccountMapping(stickyKey)
      }
    }

    const selectedEntry = activeEntries[Math.floor(Math.random() * activeEntries.length)]
    if (!selectedEntry) {
      throw new Error(`Droid account ${account.id} 没有可用的 API Key`)
    }

    if (stickyKey) {
      await redis.setSessionAccountMapping(stickyKey, selectedEntry.id)
    }

    await droidAccountService.touchApiKeyUsage(account.id, selectedEntry.id)

    logger.info(
      `随机选取 Droid API Key ${selectedEntry.id}（Account: ${account.id}, Active Keys: ${activeEntries.length}/${entries.length}）`,
    )

    return selectedEntry
  }

  async relayRequest(requestBody, apiKeyData, clientRequest, clientResponse, clientHeaders, options = {}) {
    const {
      endpointType = 'anthropic',
      sessionHash = null,
      customPath = null,
      skipUsageRecord = false,
      disableStreaming = false,
    } = options
    const keyInfo = apiKeyData || {}
    const clientApiKeyId = keyInfo.id || null
    const normalizedEndpoint = this._normalizeEndpointType(endpointType)
    const normalizedRequestBody = this._normalizeRequestBody(requestBody, normalizedEndpoint)
    let account = null
    let selectedApiKey = null
    let accessToken
    // 提到 try 外，使 catch 的 buildErrorContext 能拿到请求 url/headers
    let apiUrl = null
    let headers = null
    let proxyResolution = null

    try {
      logger.info(
        `Processing Droid API request for key: ${
          keyInfo.name || keyInfo.id || 'unknown'
        }, endpoint: ${normalizedEndpoint}${sessionHash ? `, session: ${sessionHash}` : ''}`,
      )

      // 选择一个可用的 Droid 账户（支持粘性会话和分组调度）
      account = await droidScheduler.selectAccount(keyInfo, normalizedEndpoint, sessionHash, requestBody.model)

      if (!account) {
        throw new Error(`No available Droid account for endpoint type: ${normalizedEndpoint}`)
      }

      // 获取认证凭据：支持 Access Token 和 API Key 两种模式
      if (
        typeof account.authenticationMethod === 'string' &&
        account.authenticationMethod.toLowerCase().trim() === 'api_key'
      ) {
        selectedApiKey = await this._selectApiKey(account, normalizedEndpoint, sessionHash)
        accessToken = selectedApiKey.key
      } else {
        accessToken = await droidAccountService.getValidAccessToken(account.id)
      }

      // 获取 Factory.ai API URL
      let endpointPath = this.endpoints[normalizedEndpoint]

      if (typeof customPath === 'string' && customPath.trim()) {
        endpointPath = customPath.startsWith('/') ? customPath : `/${customPath}`
      }

      apiUrl = `${this.factoryApiBaseUrl}${endpointPath}`

      logger.info(`Forwarding to Factory.ai: ${apiUrl}`)

      // 获取代理（保留 proxyId/contextKey 供被动健康检查上报）
      proxyResolution = proxyResolver.resolveAgent(account, 'droid')
      const proxyAgent = proxyResolution.agent

      if (proxyAgent) {
        logger.info(`Using proxy for Droid request`)
      }

      // 构建请求头
      headers = this._buildHeaders(accessToken, normalizedRequestBody, normalizedEndpoint, clientHeaders, account)

      if (selectedApiKey) {
        logger.info(`Forwarding request with Droid API Key ${selectedApiKey.id} (Account: ${account.id})`)
      }

      // 处理请求体（注入 system prompt 等）
      const streamRequested = !disableStreaming && this._isStreamRequested(normalizedRequestBody)

      let processedBody = this._processRequestBody(normalizedRequestBody, normalizedEndpoint, {
        disableStreaming,
        streamRequested,
      })

      const extensionPayload = {
        body: processedBody,
        endpoint: normalizedEndpoint,
        rawRequest: normalizedRequestBody,
        originalRequest: requestBody,
      }

      const extensionResult = runtimeAddon.emitSync(RUNTIME_EVENT_FMT_PAYLOAD, extensionPayload)
      const resolvedPayload =
        extensionResult && typeof extensionResult === 'object' ? extensionResult : extensionPayload

      if (resolvedPayload && typeof resolvedPayload === 'object') {
        if (resolvedPayload.abortResponse && typeof resolvedPayload.abortResponse === 'object') {
          return resolvedPayload.abortResponse
        }

        if (resolvedPayload.body && typeof resolvedPayload.body === 'object') {
          processedBody = resolvedPayload.body
        } else if (resolvedPayload !== extensionPayload) {
          processedBody = resolvedPayload
        }
      }

      // 发送请求
      const isStreaming = streamRequested

      // 根据是否流式选择不同的处理方式
      if (isStreaming) {
        // 被动健康检查：流式建连成功（进入流处理）= 代理传输成功
        proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, null)
        // 流式响应：使用原生 https 模块以更好地控制流
        return await this._handleStreamRequest(
          apiUrl,
          headers,
          processedBody,
          proxyAgent,
          clientRequest,
          clientResponse,
          account,
          keyInfo,
          normalizedRequestBody,
          normalizedEndpoint,
          skipUsageRecord,
          selectedApiKey,
          sessionHash,
          clientApiKeyId,
        )
      } else {
        // 非流式响应：使用 axios
        const requestOptions = {
          method: 'POST',
          url: apiUrl,
          headers,
          data: processedBody,
          timeout: 600 * 1000, // 10分钟超时
          responseType: 'json',
          ...(proxyAgent && {
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent,
            proxy: false,
          }),
        }

        const response = await axios(requestOptions)

        logger.info(`Factory.ai response status: ${response.status}`)

        // 被动健康检查：拿到 HTTP 响应即代理传输成功（含 4xx/5xx，不归咎代理）
        proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, null)

        // 处理非流式响应
        return this._handleNonStreamResponse(
          response,
          account,
          keyInfo,
          normalizedRequestBody,
          clientRequest,
          normalizedEndpoint,
          skipUsageRecord,
        )
      }
    } catch (error) {
      // 被动健康检查：上报连接级故障（classifyBusinessTraffic 区分传输错误 vs 上游响应，不误熔断）
      proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, error)
      // 客户端主动断开连接是正常情况，使用 INFO 级别
      if (error.message === 'Client disconnected') {
        logger.info(`Droid relay ended: Client disconnected`)
      } else {
        logger.error(`Droid relay error: ${error.message}`, error)
      }

      const status = error?.response?.status
      const droidAutoProtectionDisabled =
        account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
      const errorContext = upstreamErrorHelper.buildErrorContext({
        url: apiUrl,
        method: 'POST',
        requestHeaders: headers,
        requestBody: normalizedRequestBody,
        model: normalizedRequestBody?.model,
        responseStatus: error?.response?.status,
        responseHeaders: error?.response?.headers,
        responseBody: error?.response?.data,
        message: error?.message,
      })
      // 5xx 错误
      if (status >= 500 && account?.id && !droidAutoProtectionDisabled) {
        await upstreamErrorHelper.markTempUnavailable(account.id, 'droid', status, null, errorContext).catch(() => {})
      } else if (!status && account?.id && error.message !== 'Client disconnected' && !droidAutoProtectionDisabled) {
        // 网络错误（非客户端断开），临时不可用
        await upstreamErrorHelper.markTempUnavailable(account.id, 'droid', 503, null, errorContext).catch(() => {})
      }

      if (status >= 400 && status < 500) {
        try {
          await this._handleUpstreamClientError(status, {
            account,
            selectedAccountApiKey: selectedApiKey,
            endpointType: normalizedEndpoint,
            sessionHash,
            clientApiKeyId,
          })
        } catch (handlingError) {
          logger.error('处理 Droid 4xx 异常失败:', handlingError)
        }
      }

      if (error.response) {
        // HTTP 错误响应
        return {
          statusCode: error.response.status,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            error.response.data || {
              error: 'upstream_error',
              message: error.message,
            },
          ),
        }
      }

      // 网络错误或其他错误（统一返回 4xx）
      const mappedStatus = this._mapNetworkErrorStatus(error)
      return {
        statusCode: mappedStatus,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._buildNetworkErrorBody(error)),
      }
    }
  }

  /**
   * 处理流式请求
   */
  async _handleStreamRequest(
    apiUrl,
    headers,
    processedBody,
    proxyAgent,
    clientRequest,
    clientResponse,
    account,
    apiKeyData,
    requestBody,
    endpointType,
    skipUsageRecord = false,
    selectedAccountApiKey = null,
    sessionHash = null,
    clientApiKeyId = null,
  ) {
    return new Promise((resolve, reject) => {
      const url = new URL(apiUrl)
      const keyId = apiKeyData?.id
      const bodyString = JSON.stringify(processedBody)
      const contentLength = Buffer.byteLength(bodyString)
      const requestHeaders = {
        ...headers,
        'content-length': contentLength.toString(),
      }

      let responseStarted = false
      let settled = false

      const resolveOnce = (value) => {
        if (settled) {
          return
        }
        settled = true
        detachDisconnect?.()
        resolve(value)
      }

      const rejectOnce = (error) => {
        if (settled) {
          return
        }
        settled = true
        detachDisconnect?.()
        reject(error)
      }

      const model = requestBody.model ?? 'unknown'
      const parser = new IncrementalSSEParser()
      const state =
        endpointType === 'anthropic'
          ? new ClaudeStreamState({ model })
          : new ResponsesStreamState({ model, protocol: endpointType === 'comm' ? 'chat' : 'responses' })
      let finishing = false
      let upstreamSentError = false
      let observedServiceTier
      let backpressure = null
      let detachDisconnect = null
      const observe = (events) => {
        for (const event of events) {
          if (event.type === 'data') {
            const data = event.data.type ? event.data : { ...event.data, type: event.name }
            const response = data.response ?? data
            if (Object.hasOwn(response, 'service_tier')) {
              observedServiceTier = response.service_tier
            }
            state.observe(data)
            upstreamSentError ||= data.type === 'error' || data.type === 'response.failed'
          } else if (event.type === 'done' && endpointType === 'comm') {
            state.sawDone = true
          }
        }
      }
      const finishStream = async (transportError = null) => {
        if (settled || finishing) {
          return
        }
        finishing = true
        try {
          try {
            observe(parser.finish())
          } catch (error) {
            transportError = error
          }
          const result = state.finish(transportError)
          const rawUsage = state.usage ?? {}
          const requestMeta = createRequestDetailMeta(clientRequest, {
            requestBody,
            stream: true,
            ...result,
            protocolTerminal: state.terminalType,
          })
          requestMeta.serviceTier = resolveOpenAIServiceTier(observedServiceTier, requestBody.service_tier)
          if (!skipUsageRecord) {
            const { normalizedUsage, costs } = await this._recordUsageFromStreamData(
              rawUsage,
              apiKeyData,
              account,
              state.model ?? rawUsage.model ?? model,
              requestMeta,
              endpointType,
            )
            await this._applyRateLimitTracking(
              clientRequest?.rateLimitInfo,
              {
                inputTokens: normalizedUsage.input_tokens,
                outputTokens: normalizedUsage.output_tokens,
                cacheCreateTokens: normalizedUsage.cache_creation_input_tokens,
                cacheReadTokens: normalizedUsage.cache_read_input_tokens,
              },
              model,
              ' [stream]',
              keyId,
              costs,
            )
          }
          if (!clientResponse.destroyed && !clientResponse.writableEnded) {
            if (result.statusCode >= 400 && !upstreamSentError) {
              const error = buildClientError({
                statusCode: result.statusCode,
                protocol: endpointType === 'anthropic' ? 'anthropic' : 'openai',
                upstreamBody: { error: { code: result.errorCode, message: result.errorMessage } },
              })
              clientResponse.write(`event: error\ndata: ${JSON.stringify(error.body)}\n\n`)
            }
            clientResponse.end()
          }
          resolveOnce({ ...result, streaming: true })
        } catch (error) {
          logger.error('Droid stream finalization failed:', error)
          if (!clientResponse.destroyed && !clientResponse.writableEnded) {
            clientResponse.end()
          }
          resolveOnce({ statusCode: 502, streaming: true, error })
        } finally {
          backpressure?.dispose()
          detachDisconnect?.()
        }
      }
      const handleStreamError = (error) => {
        if (responseStarted) {
          void finishStream(error)
        } else {
          detachDisconnect?.()
          rejectOnce(error)
        }
      }

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: requestHeaders,
        agent: proxyAgent,
        timeout: 600 * 1000,
      }

      const req = https.request(options, (res) => {
        logger.info(`Factory.ai stream response status: ${res.statusCode}`)

        // 错误响应
        if (res.statusCode !== 200) {
          const chunks = []

          res.on('data', (chunk) => {
            chunks.push(chunk)
            logger.info(`got ${chunk.length} bytes of data`)
          })

          res.on('end', () => {
            logger.info('res.end() reached')
            const body = Buffer.concat(chunks).toString()
            logger.error(`Factory.ai error response body: ${body || '(empty)'}`)
            const errorContext = upstreamErrorHelper.buildErrorContext({
              url: apiUrl,
              method: 'POST',
              requestHeaders,
              requestBody: processedBody,
              model: requestBody?.model,
              responseStatus: res.statusCode,
              responseHeaders: res.headers,
              responseBody: body,
            })
            if (res.statusCode >= 500) {
              const streamAutoProtectionDisabled =
                account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
              if (!streamAutoProtectionDisabled) {
                upstreamErrorHelper
                  .markTempUnavailable(account.id, 'droid', res.statusCode, null, errorContext)
                  .catch(() => {})
              }
            }
            if (res.statusCode >= 400 && res.statusCode < 500) {
              this._handleUpstreamClientError(res.statusCode, {
                account,
                selectedAccountApiKey,
                endpointType,
                sessionHash,
                clientApiKeyId,
              }).catch((handlingError) => {
                logger.error('处理 Droid 流式4xx 异常失败:', handlingError)
              })
            }
            if (!clientResponse.headersSent) {
              clientResponse.status(res.statusCode).json({
                error: 'upstream_error',
                details: body,
              })
            }
            resolveOnce({ statusCode: res.statusCode, streaming: true })
          })

          res.on('close', () => {
            logger.warn('response closed before end event')
          })

          res.on('error', handleStreamError)

          return
        }

        responseStarted = true

        // 设置流式响应头
        clientResponse.setHeader('Content-Type', 'text/event-stream')
        clientResponse.setHeader('Cache-Control', 'no-cache')
        clientResponse.setHeader('Connection', 'keep-alive')

        backpressure = createStreamBackpressure(res, clientResponse)
        res.on('data', (chunk) => {
          try {
            observe(parser.feed(chunk))
            if (!clientResponse.destroyed && !clientResponse.writableEnded && !clientResponse.write(chunk)) {
              void backpressure.waitForDrain()
            }
          } catch (error) {
            res.destroy(error)
            handleStreamError(error)
          }
        })
        res.on('end', () => {
          void finishStream()
        })
        res.on('error', handleStreamError)
        res.on('close', () => {
          if (!res.complete) {
            handleStreamError(new Error('Upstream stream closed unexpectedly'))
          }
        })
      })

      // 客户端断开连接时清理（只用 res 判据）
      detachDisconnect = onClientDisconnect(
        clientResponse,
        () => {
          const error = new Error('Client disconnected')
          handleStreamError(error)
          req.destroy(error)
        },
        'Droid stream',
      )

      req.on('error', handleStreamError)

      req.on('timeout', () => {
        req.destroy()
        logger.error('Droid request timeout')
        handleStreamError(new Error('Request timeout'))
      })

      // 写入请求体
      req.end(bodyString)
    })
  }

  async _recordUsageFromStreamData(
    usageData,
    apiKeyData,
    account,
    model,
    requestMeta = null,
    endpointType = 'anthropic',
  ) {
    const normalizedUsage = this._normalizeUsageSnapshot(usageData, endpointType)
    const costs = await this._recordUsage(apiKeyData, account, model, normalizedUsage, requestMeta)
    return { normalizedUsage, costs }
  }

  _normalizeUsageSnapshot(usageData = {}, endpointType = 'anthropic') {
    if (endpointType !== 'anthropic') {
      const rawUsage = { ...usageData }
      if (
        (rawUsage.output_tokens === undefined || rawUsage.output_tokens === null) &&
        (rawUsage.completion_tokens === undefined || rawUsage.completion_tokens === null) &&
        Number.isFinite(rawUsage.total_tokens)
      ) {
        rawUsage.output_tokens = Math.max(
          0,
          rawUsage.total_tokens - (rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? 0),
        )
      }
      return buildTokenUsagePayload({ ...normalizeOpenAITokenUsage(rawUsage), rawUsage })
    }
    const tokenCount = (value) => {
      const count = Number(value)
      return Number.isSafeInteger(count) && count >= 0 ? count : 0
    }
    const cache = usageData.cache_creation
      ? {
          ephemeral_5m_input_tokens: tokenCount(usageData.cache_creation.ephemeral_5m_input_tokens),
          ephemeral_1h_input_tokens: tokenCount(usageData.cache_creation.ephemeral_1h_input_tokens),
        }
      : null
    return buildTokenUsagePayload({
      inputTokens: tokenCount(usageData.input_tokens),
      outputTokens: tokenCount(usageData.output_tokens),
      cacheCreateTokens:
        tokenCount(usageData.cache_creation_input_tokens) ||
        (cache?.ephemeral_5m_input_tokens ?? 0) + (cache?.ephemeral_1h_input_tokens ?? 0),
      cacheReadTokens: tokenCount(usageData.cache_read_input_tokens),
      rawUsage: usageData,
      extras: {
        ...(cache ? { cache_creation: { ...cache } } : {}),
        ...(typeof usageData.speed === 'string' ? { speed: usageData.speed } : {}),
      },
    })
  }

  /**
   * 计算 usage 对象的总 token 数
   */
  _getTotalTokens(usageObject = {}) {
    const toNumber = (value) => {
      if (value === undefined || value === null || value === '') {
        return 0
      }
      const num = Number(value)
      if (!Number.isFinite(num)) {
        return 0
      }
      return Math.max(0, num)
    }

    return (
      toNumber(usageObject.input_tokens) +
      toNumber(usageObject.output_tokens) +
      toNumber(usageObject.cache_creation_input_tokens) +
      toNumber(usageObject.cache_read_input_tokens)
    )
  }

  /**
   * 提取账户 ID
   */
  _extractAccountId(account) {
    if (!account || typeof account !== 'object') {
      return null
    }
    return account.id || account.accountId || account.account_id || null
  }

  /**
   * 根据模型名称推断 API provider
   */
  _inferProviderFromModel(model) {
    if (!model || typeof model !== 'string') {
      return 'baseten'
    }

    const lowerModel = model.toLowerCase()

    // Google Gemini 模型
    if (lowerModel.startsWith('gemini-') || lowerModel.includes('gemini')) {
      return 'google'
    }

    // Anthropic Claude 模型
    if (lowerModel.startsWith('claude-') || lowerModel.includes('claude')) {
      return 'anthropic'
    }

    // OpenAI GPT 模型
    if (lowerModel.startsWith('gpt-') || lowerModel.includes('gpt')) {
      return 'azure_openai'
    }

    // GLM 模型使用 fireworks
    if (lowerModel.startsWith('glm-') || lowerModel.includes('glm')) {
      return 'fireworks'
    }

    // 默认使用 baseten
    return 'baseten'
  }

  /**
   * 构建请求头
   */
  _buildHeaders(accessToken, requestBody, endpointType, clientHeaders = {}, account = null) {
    // 使用账户配置的 userAgent 或默认值
    const userAgent = account?.userAgent || this.userAgent
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': userAgent,
      'x-factory-client': 'cli',
      connection: 'keep-alive',
    }

    // Anthropic 特定头
    if (endpointType === 'anthropic') {
      headers['accept'] = 'application/json'
      headers['anthropic-version'] = '2023-06-01'
      headers['x-api-key'] = 'placeholder'
      headers['x-api-provider'] = 'anthropic'

      if (this._isThinkingRequested(requestBody)) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
      }
    }

    // OpenAI 特定头 - 根据模型动态选择 provider
    if (endpointType === 'openai') {
      const model = (requestBody?.model || '').toLowerCase()
      // -max 模型使用 openai provider，其他使用 azure_openai
      if (model.includes('-max')) {
        headers['x-api-provider'] = 'openai'
      } else {
        headers['x-api-provider'] = 'azure_openai'
      }
    }

    // Comm 端点根据模型动态设置 provider
    if (endpointType === 'comm') {
      const model = requestBody?.model
      headers['x-api-provider'] = this._inferProviderFromModel(model)
    }

    // 生成会话 ID（如果客户端没有提供）
    headers['x-session-id'] = clientHeaders['x-session-id'] || this._generateUUID()

    return headers
  }

  /**
   * 判断请求是否要求流式响应
   */
  _isStreamRequested(requestBody) {
    if (!requestBody || typeof requestBody !== 'object') {
      return false
    }

    const value = requestBody.stream

    if (value === true) {
      return true
    }

    if (typeof value === 'string') {
      return value.toLowerCase() === 'true'
    }

    return false
  }

  /**
   * 判断请求是否启用 Anthropic 推理模式
   */
  _isThinkingRequested(requestBody) {
    const thinking = requestBody && typeof requestBody === 'object' ? requestBody.thinking : null
    if (!thinking) {
      return false
    }

    if (thinking === true) {
      return true
    }

    if (typeof thinking === 'string') {
      return thinking.trim().toLowerCase() === 'enabled'
    }

    if (typeof thinking === 'object') {
      if (thinking.enabled === true) {
        return true
      }

      if (typeof thinking.type === 'string') {
        return thinking.type.trim().toLowerCase() === 'enabled'
      }
    }

    return false
  }

  /**
   * 处理请求体（注入 system prompt 等）
   */
  _processRequestBody(requestBody, endpointType, options = {}) {
    const { disableStreaming = false, streamRequested = false } = options
    const processedBody = { ...requestBody }

    const hasStreamField = requestBody && Object.prototype.hasOwnProperty.call(requestBody, 'stream')

    if (processedBody && Object.prototype.hasOwnProperty.call(processedBody, 'metadata')) {
      delete processedBody.metadata
    }

    if (disableStreaming || !streamRequested) {
      if (hasStreamField) {
        processedBody.stream = false
      } else if ('stream' in processedBody) {
        delete processedBody.stream
      }
    } else {
      processedBody.stream = true
    }

    // Anthropic 端点：仅注入系统提示
    if (endpointType === 'anthropic') {
      if (this.systemPrompt) {
        const promptBlock = { type: 'text', text: this.systemPrompt }
        if (Array.isArray(processedBody.system)) {
          const hasPrompt = processedBody.system.some(
            (item) => item && item.type === 'text' && item.text === this.systemPrompt,
          )
          if (!hasPrompt) {
            processedBody.system = [promptBlock, ...processedBody.system]
          }
        } else {
          processedBody.system = [promptBlock]
        }
      }
    }

    // OpenAI 端点：仅前置系统提示
    if (endpointType === 'openai') {
      if (this.systemPrompt) {
        if (processedBody.instructions) {
          if (!processedBody.instructions.startsWith(this.systemPrompt)) {
            processedBody.instructions = `${this.systemPrompt}${processedBody.instructions}`
          }
        } else {
          processedBody.instructions = this.systemPrompt
        }
      }
    }

    // Comm 端点：在 messages 数组前注入 system 消息
    if (endpointType === 'comm') {
      if (this.systemPrompt && Array.isArray(processedBody.messages)) {
        const hasSystemMessage = processedBody.messages.some((m) => m && m.role === 'system')

        if (hasSystemMessage) {
          // 如果已有 system 消息，在第一个 system 消息的 content 前追加
          const firstSystemIndex = processedBody.messages.findIndex((m) => m && m.role === 'system')
          if (firstSystemIndex !== -1) {
            const existingContent = processedBody.messages[firstSystemIndex].content || ''
            if (typeof existingContent === 'string' && !existingContent.startsWith(this.systemPrompt)) {
              processedBody.messages[firstSystemIndex] = {
                ...processedBody.messages[firstSystemIndex],
                content: this.systemPrompt + existingContent,
              }
            }
          }
        } else {
          // 如果没有 system 消息，在 messages 数组最前面插入
          processedBody.messages = [{ role: 'system', content: this.systemPrompt }, ...processedBody.messages]
        }
      }
    }

    // 处理 temperature 和 top_p 参数
    const hasValidTemperature = processedBody.temperature !== undefined && processedBody.temperature !== null
    const hasValidTopP = processedBody.top_p !== undefined && processedBody.top_p !== null

    if (hasValidTemperature && hasValidTopP) {
      // 仅允许 temperature 或 top_p 其一，同时优先保留 temperature
      delete processedBody.top_p
    }

    return processedBody
  }

  /**
   * 处理非流式响应
   */
  async _handleNonStreamResponse(
    response,
    account,
    apiKeyData,
    requestBody,
    clientRequest,
    endpointType,
    skipUsageRecord = false,
  ) {
    const { data } = response
    const keyId = apiKeyData?.id

    // 从响应中提取 usage 数据
    const usage = data.usage || {}

    const model = requestBody.model || 'unknown'

    const normalizedUsage = this._normalizeUsageSnapshot(usage, endpointType)

    if (!skipUsageRecord) {
      const droidCosts = await this._recordUsage(
        apiKeyData,
        account,
        model,
        normalizedUsage,
        Object.assign(
          createRequestDetailMeta(clientRequest, {
            requestBody,
            stream: false,
            statusCode: response.status || 200,
          }),
          { serviceTier: resolveOpenAIServiceTier(data.service_tier, requestBody.service_tier) },
        ),
      )

      const totalTokens = this._getTotalTokens(normalizedUsage)

      const usageSummary = {
        inputTokens: normalizedUsage.input_tokens || 0,
        outputTokens: normalizedUsage.output_tokens || 0,
        cacheCreateTokens: normalizedUsage.cache_creation_input_tokens || 0,
        cacheReadTokens: normalizedUsage.cache_read_input_tokens || 0,
      }

      const endpointLabel =
        endpointType === 'anthropic' ? ' [anthropic]' : endpointType === 'comm' ? ' [comm]' : ' [openai]'
      await this._applyRateLimitTracking(
        clientRequest?.rateLimitInfo,
        usageSummary,
        model,
        endpointLabel,
        keyId,
        droidCosts,
      )

      logger.success(`Droid request completed - Account: ${account.name}, Tokens: ${totalTokens}`)
    } else {
      logger.success(`Droid request completed - Account: ${account.name}, usage recording skipped`)
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }
  }

  /**
   * 记录使用统计
   */
  async _recordUsage(apiKeyData, account, model, usageObject = {}, requestMeta = null) {
    const totalTokens = this._getTotalTokens(usageObject)

    if (totalTokens <= 0) {
      logger.debug('Droid usage 数据为空，跳过记录')
      return { realCost: 0, ratedCost: 0 }
    }

    try {
      const keyId = apiKeyData?.id
      const accountId = this._extractAccountId(account)
      let costs = { realCost: 0, ratedCost: 0 }

      if (keyId) {
        costs = await apiKeyService.recordUsageWithDetails(keyId, usageObject, model, accountId, 'droid', requestMeta)
      } else if (accountId) {
        await redis.incrementAccountUsage(
          accountId,
          totalTokens,
          usageObject.input_tokens || 0,
          usageObject.output_tokens || 0,
          usageObject.cache_creation_input_tokens || 0,
          usageObject.cache_read_input_tokens || 0,
          usageObject.cache_creation?.ephemeral_5m_input_tokens ?? 0,
          usageObject.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          model,
          false,
          // realCost / costRecorded 都不传（默认 0 / false）：本分支是「无 API Key、只有账户」的
          // 兜底路径，没有走过计费、手上没有可信金额。读取侧会按 token 反推
          //（Droid 不涉 service_tier 档，口径与改动前一致）
        )
      } else {
        logger.warn('无法记录 Droid usage：缺少 API Key 和账户标识')
        return { realCost: 0, ratedCost: 0 }
      }

      logger.debug(
        `Droid usage recorded - Key: ${keyId || 'unknown'}, Account: ${accountId || 'unknown'}, Model: ${model}, Input: ${usageObject.input_tokens || 0}, Output: ${usageObject.output_tokens || 0}, Cache Create: ${usageObject.cache_creation_input_tokens || 0}, Cache Read: ${usageObject.cache_read_input_tokens || 0}, Total: ${totalTokens}`,
      )

      return costs
    } catch (error) {
      logger.error('Failed to record Droid usage:', error)
      return { realCost: 0, ratedCost: 0 }
    }
  }

  /**
   * 处理上游 4xx 响应，移除问题 API Key 或停止账号调度
   */
  async _handleUpstreamClientError(statusCode, context = {}) {
    if (!statusCode || statusCode < 400 || statusCode >= 500) {
      return
    }

    const {
      account,
      selectedAccountApiKey = null,
      endpointType = null,
      sessionHash = null,
      clientApiKeyId = null,
    } = context

    const accountId = this._extractAccountId(account)
    if (!accountId) {
      logger.warn('上游 4xx 处理被跳过：缺少有效的账户信息')
      return
    }

    const normalizedEndpoint = this._normalizeEndpointType(endpointType || account?.endpointType || 'anthropic')
    const authMethod =
      typeof account?.authenticationMethod === 'string' ? account.authenticationMethod.toLowerCase().trim() : ''

    if (authMethod === 'api_key') {
      if (selectedAccountApiKey?.id) {
        let markResult = null
        const errorMessage = `${statusCode}`

        try {
          // 标记API Key为异常状态而不是删除
          markResult = await droidAccountService.markApiKeyAsError(accountId, selectedAccountApiKey.id, errorMessage)
        } catch (error) {
          logger.error(`标记 Droid API Key ${selectedAccountApiKey.id} 异常状态（Account: ${accountId}）失败：`, error)
        }

        await this._clearApiKeyStickyMapping(accountId, normalizedEndpoint, sessionHash)

        if (markResult?.marked) {
          logger.warn(
            `上游返回 ${statusCode}，已标记 Droid API Key ${selectedAccountApiKey.id} 为异常状态（Account: ${accountId}）`,
          )
        } else {
          logger.warn(
            `上游返回 ${statusCode}，但未能标记 Droid API Key ${selectedAccountApiKey.id} 异常状态（Account: ${accountId}）：${markResult?.error || '未知错误'}`,
          )
        }

        // 检查是否还有可用的API Key
        try {
          const availableEntries = await droidAccountService.getDecryptedApiKeyEntries(accountId)
          const activeEntries = availableEntries.filter((entry) => entry.status !== 'error')

          if (activeEntries.length === 0) {
            await this._stopDroidAccountScheduling(accountId, statusCode, '所有API Key均已异常')
            await this._clearAccountStickyMapping(normalizedEndpoint, sessionHash, clientApiKeyId)
          } else {
            logger.info(`ℹ Droid 账号 ${accountId} 仍有 ${activeEntries.length} 个可用 API Key`)
          }
        } catch (error) {
          logger.error(`检查可用API Key失败（Account: ${accountId}）：`, error)
          await this._stopDroidAccountScheduling(accountId, statusCode, 'API Key检查失败')
          await this._clearAccountStickyMapping(normalizedEndpoint, sessionHash, clientApiKeyId)
        }

        return
      }

      logger.warn(`上游返回 ${statusCode}，但未获取到对应的 Droid API Key（Account: ${accountId}）`)
      await this._stopDroidAccountScheduling(accountId, statusCode, '缺少可用 API Key')
      await this._clearAccountStickyMapping(normalizedEndpoint, sessionHash, clientApiKeyId)
      return
    }

    const clientErrorAutoProtectionDisabled =
      account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
    if (!clientErrorAutoProtectionDisabled) {
      const errorContext = upstreamErrorHelper.buildErrorContext({
        method: 'POST',
        sessionId: sessionHash,
        responseStatus: statusCode,
        reason: `droid_upstream_4xx_${normalizedEndpoint}`,
      })
      await upstreamErrorHelper.markTempUnavailable(accountId, 'droid', statusCode, null, errorContext)
    }
    await this._clearAccountStickyMapping(normalizedEndpoint, sessionHash, clientApiKeyId)
  }

  /**
   * 停止指定 Droid 账号的调度
   */
  async _stopDroidAccountScheduling(accountId, statusCode, reason = '') {
    if (!accountId) {
      return
    }

    // disableAutoProtection 检查：关闭自动防护时不自动停止调度，仅记录日志
    try {
      const account = await droidAccountService.getAccount(accountId)
      if (account?.disableAutoProtection === true || account?.disableAutoProtection === 'true') {
        logger.info(
          `Droid 账号 ${accountId} 已关闭自动防护，跳过自动停止调度（状态码 ${statusCode}，原因：${reason || '4xx'}）`,
        )
        return
      }
    } catch (error) {
      logger.warn(`读取 Droid 账号自动防护配置失败：${accountId}`, error)
    }

    const message = reason ? `${reason}` : '上游返回 4xx 错误'

    try {
      await droidAccountService.updateAccount(accountId, {
        schedulable: 'false',
        status: 'error',
        // 自动停用标记：用于区分"自动停用"与手动/运行时 error，开启 disableAutoProtection 时据此恢复
        autoStoppedAt: new Date().toISOString(),
        errorMessage: `上游返回 ${statusCode}：${message}`,
      })
      logger.warn(`已停止调度 Droid 账号 ${accountId}（状态码 ${statusCode}，原因：${message}）`)
    } catch (error) {
      logger.error(`停止调度 Droid 账号失败：${accountId}`, error)
    }
  }

  /**
   * 清理账号层面的粘性调度映射
   */
  async _clearAccountStickyMapping(endpointType, sessionHash, clientApiKeyId) {
    if (!sessionHash) {
      return
    }

    const normalizedEndpoint = this._normalizeEndpointType(endpointType)
    const apiKeyPart = clientApiKeyId || 'default'
    const stickyKey = `droid:${normalizedEndpoint}:${apiKeyPart}:${sessionHash}`

    try {
      await redis.deleteSessionAccountMapping(stickyKey)
      logger.debug(`已清理 Droid 粘性会话映射：${stickyKey}`)
    } catch (error) {
      logger.warn(`清理 Droid 粘性会话映射失败：${stickyKey}`, error)
    }
  }

  /**
   * 清理 API Key 级别的粘性映射
   */
  async _clearApiKeyStickyMapping(accountId, endpointType, sessionHash) {
    if (!accountId || !sessionHash) {
      return
    }

    try {
      const stickyKey = this._composeApiKeyStickyKey(accountId, endpointType, sessionHash)
      if (stickyKey) {
        await redis.deleteSessionAccountMapping(stickyKey)
        logger.debug(`已清理 Droid API Key 粘性映射：${stickyKey}`)
      }
    } catch (error) {
      logger.warn(`清理 Droid API Key 粘性映射失败：${accountId}（endpoint: ${endpointType}）`, error)
    }
  }

  _mapNetworkErrorStatus(error) {
    const code = (error && error.code ? String(error.code) : '').toUpperCase()

    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return 408
    }

    if (code === 'ECONNRESET' || code === 'EPIPE') {
      return 424
    }

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return 424
    }

    if (typeof error === 'object' && error !== null) {
      const message = (error.message || '').toLowerCase()
      if (message.includes('timeout')) {
        return 408
      }
    }

    return 424
  }

  _buildNetworkErrorBody(error) {
    const body = {
      error: 'relay_upstream_failure',
      message: error?.message || '上游请求失败',
    }

    if (error?.code) {
      body.code = error.code
    }

    if (error?.config?.url) {
      body.upstream = error.config.url
    }

    return body
  }

  /**
   * 生成 UUID
   */
  _generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }
}

// 导出单例
export const droidRelayService = new DroidRelayService()
