import axios from 'axios'
import { redis } from '../../infra/redis.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { logger } from '../../common/logger.js'
import { filterForOpenAI, applyFilteredResponseHeaders } from './relay_header_filter.js'
import { openaiResponsesAccountService } from '../account/account_openai_responses_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { unifiedOpenAIScheduler } from './relay_unified_openai_scheduler.js'
import { config } from '../../../config/config.js'
import crypto from 'node:crypto'
import { LRUCache } from '../../common/lru_cache.js'
import * as upstreamErrorHelper from './relay_upstream_error_helper.js'
import { buildClientError, extractSafeMessage, summarizeErrorForLog } from '../../common/client_error_builder.js'
import {
  sanitizeOpenAICapacityShedForClient,
  createCapacityShedSseRewriteStream,
} from './relay_openai_capacity_shed.js'
import { applyOpenAIServiceTierAlias } from './relay_openai_compact_v2.js'
import { applyOpenAIPublicModelAlias } from './relay_openai_model_alias.js'
import { extractMultipartFormField, rewriteMultipartFormField } from './relay_multipart_form_field.js'
import { normalizeCodexBootstrapBody } from './relay_codex_bootstrap_normalize.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import { getMappedModelName } from '../../common/common_helper.js'
import { CostCalculator } from '../pricing/pricing_cost_calculator.js'
import { pricingService } from '../pricing/pricing_service.js'
import { isNonProtocolUpstreamBody, handleNonProtocolUpstream } from './relay_upstream_protocol_guard.js'
import { updateRateLimitCounters } from './relay_rate_limit_helper.js'
import {
  buildTokenUsagePayload,
  createRequestDetailMeta,
  extractOpenAICacheReadTokens,
  resolveOpenAIServiceTier,
} from './relay_request_detail_helper.js'
// lastUsedAt 更新节流（每账户 60 秒内最多更新一次，使用 LRU 防止内存泄漏）
const lastUsedAtThrottle = new LRUCache(1000) // 最多缓存 1000 个账户
const LAST_USED_AT_THROTTLE_MS = 60000

// 抽取缓存写入 token，兼容多种字段命名
const extractCacheCreationTokens = function extractCacheCreationTokens(usageData) {
  if (!usageData || typeof usageData !== 'object') {
    return 0
  }

  const details = usageData.input_tokens_details || usageData.prompt_tokens_details || {}
  const candidates = [
    details.cache_creation_input_tokens,
    details.cache_creation_tokens,
    usageData.cache_creation_input_tokens,
    usageData.cache_creation_tokens,
  ]

  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== '') {
      const parsed = Number(value)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
  }

  return 0
}

class OpenAIResponsesRelayService {
  constructor() {
    this.defaultTimeout = config.requestTimeout || 600000
  }

  // 节流更新 lastUsedAt
  async _throttledUpdateLastUsedAt(accountId) {
    const now = Date.now()
    const lastUpdate = lastUsedAtThrottle.get(accountId)

    if (lastUpdate && now - lastUpdate < LAST_USED_AT_THROTTLE_MS) {
      return // 跳过更新
    }

    lastUsedAtThrottle.set(accountId, now, LAST_USED_AT_THROTTLE_MS)
    await openaiResponsesAccountService.updateAccount(accountId, {
      lastUsedAt: new Date().toISOString(),
    })
  }

  // 处理请求转发
  async handleRequest(req, res, account, apiKeyData) {
    let abortController = null
    let detachClientDisconnect = () => {}
    let proxyResolution = null
    // 获取会话哈希（与 openaiRoutes handleResponses 同源：官方 session-id + 兼容字段）
    const sessionId =
      req.headers['session-id'] ||
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      req.headers['thread-id'] ||
      req.body?.session_id ||
      req.body?.sessionId ||
      null
    const sessionHash = sessionId ? crypto.createHash('sha256').update(String(sessionId)).digest('hex') : null

    let concurrencyAcquired = false
    let concurrencyRequestId = null

    try {
      // 获取完整的账户信息（包含解密的 API Key）
      const fullAccount = await openaiResponsesAccountService.getAccount(account.id)
      if (!fullAccount) {
        throw new Error('Account not found')
      }
      // 失败明细采集用：finish 钩子可带上实际选中的账户
      req._crsAccountId = fullAccount.id
      req._crsAccountType = 'openai-responses'
      if (req.body && typeof req.body.model === 'string') {
        req._crsRequestedModel = req.body.model
      }

      // 账户级并发槽（0=不限制）
      const maxConcurrent = Number(fullAccount.maxConcurrentTasks) || 0
      if (maxConcurrent > 0) {
        concurrencyRequestId = req.id || crypto.randomUUID()
        const newConcurrency = Number(
          await redis.incrOpenaiResponsesAccountConcurrency(fullAccount.id, concurrencyRequestId, 600),
        )
        concurrencyAcquired = true
        if (newConcurrency > maxConcurrent) {
          await redis.decrOpenaiResponsesAccountConcurrency(fullAccount.id, concurrencyRequestId)
          concurrencyAcquired = false
          const error = new Error('OpenAI-Responses account concurrency limit reached')
          error.code = 'OPENAI_RESPONSES_CONCURRENCY_FULL'
          error.statusCode = 429
          throw error
        }
        logger.debug(
          `[OpenAI-Responses] concurrency acquired account=${fullAccount.id} ${newConcurrency}/${maxConcurrent}`,
        )
      }

      // 创建 AbortController 用于取消请求
      abortController = new AbortController()

      const releaseAccountConcurrency = async () => {
        if (!concurrencyAcquired || !concurrencyRequestId) {
          return
        }
        try {
          await redis.decrOpenaiResponsesAccountConcurrency(fullAccount.id || account?.id, concurrencyRequestId)
        } catch (error) {
          console.error(summarizeErrorForLog(error))
        }
        concurrencyAcquired = false
      }

      // 监听客户端断开：判据收口在 utils/clientDisconnect
      // 流式：不断开上游（drain 收 response.completed.usage），对齐 sub2api「断连仍记费」
      // 非流式：abort 即可
      detachClientDisconnect = onClientDisconnect(
        res,
        () => {
          if (req.body?.stream) {
            req._crsClientGone = true
            req._crsDrainForUsage = true
            logger.info('OpenAI-Responses client disconnected during stream; draining upstream for usage')
            return
          }
          if (abortController && !abortController.signal.aborted) {
            abortController.abort()
          }
        },
        'OpenAI-Responses request',
      )

      // 构建目标 URL（根据 providerEndpoint 配置决定端点路径）
      const providerEndpoint = fullAccount.providerEndpoint || 'responses'
      let targetPath = req.path

      // 根据 providerEndpoint 配置归一化路径
      // 注意：unified.js 已将 /v1/chat/completions 的请求体转换为 Responses 格式，
      // 因此这里只需归一化路径即可；反向 responses→completions 需要同时转换请求体，
      // 目前不支持，只保留 responses 和 auto 两种模式
      if (
        providerEndpoint === 'responses' &&
        (targetPath === '/v1/chat/completions' || targetPath === '/chat/completions')
      ) {
        const newPath = targetPath.startsWith('/v1') ? '/v1/responses' : '/responses'
        logger.info(`Normalized path (${req.path}) → ${newPath} (providerEndpoint=responses)`)
        targetPath = newPath
      }
      // providerEndpoint === 'auto'时保持原始路径不变

      // 防止 baseApi 已含 /v1 时路径重复（如 baseApi=http://host/v1 + targetPath=/v1/responses → /v1/v1/responses）
      const baseApi = fullAccount.baseApi || ''
      if (baseApi.endsWith('/v1') && targetPath.startsWith('/v1/')) {
        targetPath = targetPath.slice(3) // '/v1/responses' → '/responses'
      }
      const targetUrl = `${baseApi}${targetPath}`
      logger.info(`Forwarding to: ${targetUrl}`)

      // 构建请求头 - 使用统一的 headerFilter 移除 CDN headers
      const headers = {
        ...filterForOpenAI(req.headers),
        Authorization: `Bearer ${fullAccount.apiKey}`,
        'Content-Type': 'application/json',
      }

      // 处理 User-Agent
      if (fullAccount.userAgent) {
        // 使用自定义 User-Agent
        headers['User-Agent'] = fullAccount.userAgent
        logger.debug(`Using custom User-Agent: ${fullAccount.userAgent}`)
      } else if (req.headers['user-agent']) {
        // 透传原始 User-Agent
        headers['User-Agent'] = req.headers['user-agent']
        logger.debug(`Forwarding original User-Agent: ${req.headers['user-agent']}`)
      }

      // 账户级模型映射：必须用客户端原始 model 作键；公开别名仅在未命中映射时套用
      let outboundBody = req.body && typeof req.body === 'object' ? { ...req.body } : req.body
      const requestedModelName = req.body && typeof req.body.model === 'string' ? req.body.model : ''
      let mapped = false
      if (outboundBody && typeof outboundBody === 'object') {
        applyOpenAIServiceTierAlias(outboundBody)
        const bootstrap = normalizeCodexBootstrapBody(outboundBody)
        if (bootstrap.changed) {
          outboundBody = bootstrap.body
          logger.info(`Codex bootstrap normalized on openai-responses kinds=${bootstrap.kinds.join(',')}`)
        }
        if (requestedModelName && fullAccount.supportedModels) {
          const mappedModel = getMappedModelName(fullAccount.supportedModels, requestedModelName)
          if (mappedModel && mappedModel !== requestedModelName) {
            outboundBody.model = mappedModel
            mapped = true
            logger.info(
              `OpenAI-Responses model mapping: ${requestedModelName} → ${mappedModel} (account=${account.id})`,
            )
          }
        }
        applyOpenAIPublicModelAlias(outboundBody, {
          originalModel: requestedModelName || null,
          mapped,
        })
      }

      // 配置请求选项
      const requestOptions = {
        method: req.method,
        url: targetUrl,
        headers,
        data: outboundBody,
        timeout: this.defaultTimeout,
        responseType: outboundBody?.stream || req.body?.stream ? 'stream' : 'json',
        validateStatus: () => true, // 允许处理所有状态码
        signal: abortController.signal,
      }

      // 配置代理（绑定 proxyGroupId 走代理池，否则用账户静态 proxy）
      proxyResolution = proxyResolver.resolveAgent(fullAccount, 'openai_responses')
      const proxyAgent = proxyResolution.agent
      if (proxyAgent) {
        requestOptions.httpAgent = proxyAgent
        requestOptions.httpsAgent = proxyAgent
        requestOptions.proxy = false
        logger.info('Using proxy for OpenAI-Responses request')
      }

      // 记录请求信息
      logger.info('OpenAI-Responses relay request', {
        accountId: account.id,
        accountName: account.name,
        targetUrl,
        method: req.method,
        stream: req.body?.stream || false,
        model: req.body?.model || 'unknown',
        userAgent: headers['User-Agent'] || 'not set',
      })

      // 发送请求
      const response = await axios(requestOptions)

      // DEC_20260905_194420 上游响应头挂到 req，供 request detail 落 upstreamRequestId
      if (req && typeof req === 'object') {
        req._crsUpstreamHeaders = response.headers || null
        req._crsUpstreamRequestIdHeader =
          fullAccount.upstreamRequestIdHeader || fullAccount.extra?.upstreamRequestIdHeader || null
      }

      // 被动健康检查：拿到 HTTP 响应即代理传输成功（含 429/4xx/5xx，不归咎代理）
      proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, null)

      // 处理 429 限流错误
      if (response.status === 429) {
        const { resetsInSeconds, errorData } = await this._handle429Error(
          account,
          response,
          req.body?.stream,
          sessionHash,
        )

        // 关闭自动防护也要记错误历史（markTempUnavailable skip 时仍留痕）
        const errorContext429 = upstreamErrorHelper.buildErrorContext({
          url: requestOptions.url,
          method: requestOptions.method,
          requestHeaders: requestOptions.headers,
          requestBody: requestOptions.data,
          model: req.body?.model,
          sessionId: sessionHash,
          responseStatus: 429,
          responseHeaders: response.headers,
          responseBody: errorData,
        })
        await upstreamErrorHelper
          .markTempUnavailable(
            account.id,
            'openai-responses',
            429,
            resetsInSeconds || upstreamErrorHelper.parseRetryAfter(response.headers),
            errorContext429,
          )
          .catch(() => {})

        // 返回包装后的限流错误（脱敏 + 协议化，不裸透传上游 body）
        const clientError = buildClientError({
          statusCode: 429,
          protocol: 'openai',
          upstreamBody: errorData,
          retryAfterSeconds: resetsInSeconds,
        })
        {
          const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
          return res.status(clientError.statusCode).json(sanitized.payload)
        }
      }

      // 处理其他错误状态码
      if (response.status >= 400) {
        // 处理流式错误响应
        let errorData = response.data
        if (response.data && typeof response.data.pipe === 'function') {
          // 流式响应需要先读取内容
          const chunks = []
          await new Promise((resolve) => {
            response.data.on('data', (chunk) => chunks.push(chunk))
            response.data.on('end', resolve)
            response.data.on('error', resolve)
            setTimeout(resolve, 5000) // 超时保护
          })
          const fullResponse = Buffer.concat(chunks).toString()

          // 尝试解析错误响应
          try {
            if (fullResponse.includes('data: ')) {
              // SSE格式
              const lines = fullResponse.split('\n')
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const jsonStr = line.slice(6).trim()
                  if (jsonStr && jsonStr !== '[DONE]') {
                    errorData = JSON.parse(jsonStr)
                    break
                  }
                }
              }
            } else {
              // 普通JSON
              errorData = JSON.parse(fullResponse)
            }
          } catch (e) {
            logger.error('Failed to parse error response:', e)
            errorData = { error: { message: fullResponse || 'Unknown error' } }
          }

          // HTML/非协议体：断粘性 + temp_unavailable（防粘性连打坏上游）
          if (
            isNonProtocolUpstreamBody({
              statusCode: response.status,
              contentType: response.headers?.['content-type'],
              bodyText: fullResponse,
            })
          ) {
            const oaiAutoProtectionDisabled =
              account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
            await handleNonProtocolUpstream({
              accountId: account?.id,
              accountType: 'openai-responses',
              sessionHash,
              statusCode: response.status,
              disableAutoProtection: oaiAutoProtectionDisabled,
              errorContext: upstreamErrorHelper.buildErrorContext({
                url: requestOptions.url,
                method: requestOptions.method,
                requestHeaders: requestOptions.headers,
                requestBody: requestOptions.data,
                model: req.body?.model,
                sessionId: sessionHash,
                responseStatus: response.status,
                responseHeaders: response.headers,
                responseBody: fullResponse.slice(0, 500),
              }),
              clearSticky: sessionHash ? () => unifiedOpenAIScheduler._deleteSessionMapping(sessionHash) : null,
            })
          }
        } else if (
          // 非流错误体也可能是 HTML 字符串
          isNonProtocolUpstreamBody({
            statusCode: response.status,
            contentType: response.headers?.['content-type'],
            bodyText: typeof errorData === 'string' ? errorData : '',
          })
        ) {
          const oaiAutoProtectionDisabled =
            account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
          const preview =
            typeof errorData === 'string' ? errorData.slice(0, 500) : JSON.stringify(errorData || {}).slice(0, 500)
          await handleNonProtocolUpstream({
            accountId: account?.id,
            accountType: 'openai-responses',
            sessionHash,
            statusCode: response.status,
            disableAutoProtection: oaiAutoProtectionDisabled,
            errorContext: upstreamErrorHelper.buildErrorContext({
              url: requestOptions.url,
              method: requestOptions.method,
              model: req.body?.model,
              sessionId: sessionHash,
              responseStatus: response.status,
              responseHeaders: response.headers,
              responseBody: preview,
            }),
            clearSticky: sessionHash ? () => unifiedOpenAIScheduler._deleteSessionMapping(sessionHash) : null,
          })
        }

        // 禁止日志打上游 error 原文
        // DEC_20260905_155232
        logger.error('OpenAI-Responses API error', {
          status: response.status,
          statusText: response.statusText,
          message: extractSafeMessage(errorData) || 'upstream error',
        })

        if (response.status === 401) {
          logger.warn(`OpenAI Responses账号认证失败（401错误）for account ${account?.id}`)

          try {
            // 仅临时暂停，不永久禁用
            const errorContext401 = upstreamErrorHelper.buildErrorContext({
              url: requestOptions.url,
              method: requestOptions.method,
              requestHeaders: requestOptions.headers,
              requestBody: requestOptions.data,
              model: req.body?.model,
              sessionId: sessionHash,
              responseStatus: 401,
              responseHeaders: response.headers,
              responseBody: errorData,
            })
            await upstreamErrorHelper
              .markTempUnavailable(account.id, 'openai-responses', 401, null, errorContext401)
              .catch(() => {})
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.error('Failed to mark OpenAI-Responses account temporarily unavailable after 401:', markError)
          }

          // 401 走 buildClientError：隐藏我方账户鉴权，禁止 errorData 原文出站
          // DEC_20260905_155232
          detachClientDisconnect()

          await releaseAccountConcurrency()

          const clientError = buildClientError({
            statusCode: 401,
            protocol: 'openai',
            upstreamBody: errorData,
          })
          {
            const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
            return res.status(clientError.statusCode).json(sanitized.payload)
          }
        }

        // 处理 5xx 上游错误
        if (response.status >= 500 && account?.id) {
          try {
            const errorContext5xx = upstreamErrorHelper.buildErrorContext({
              url: requestOptions.url,
              method: requestOptions.method,
              requestHeaders: requestOptions.headers,
              requestBody: requestOptions.data,
              model: req.body?.model,
              sessionId: sessionHash,
              responseStatus: response.status,
              responseHeaders: response.headers,
              responseBody: errorData,
            })
            await upstreamErrorHelper.markTempUnavailable(
              account.id,
              'openai-responses',
              response.status,
              null,
              errorContext5xx,
            )
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.warn('Failed to mark OpenAI-Responses account temporarily unavailable:', markError)
          }
        }

        // 清理监听器与并发槽
        detachClientDisconnect()
        await releaseAccountConcurrency()

        const clientError = buildClientError({
          statusCode: response.status,
          protocol: 'openai',
          upstreamBody: errorData,
        })
        {
          const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
          return res.status(clientError.statusCode).json(sanitized.payload)
        }
      }

      // 更新最后使用时间（节流）
      await this._throttledUpdateLastUsedAt(account.id)

      // 处理流式响应
      if (req.body?.stream && response.data && typeof response.data.pipe === 'function') {
        return this._handleStreamResponse(
          response,
          res,
          account,
          apiKeyData,
          req.body?.model,
          detachClientDisconnect,
          req,
          {
            releaseConcurrency: releaseAccountConcurrency,
          },
        )
      }

      // 处理非流式响应
      try {
        return await this._handleNormalResponse(response, res, account, apiKeyData, req.body?.model, req)
      } finally {
        await releaseAccountConcurrency()
      }
    } catch (error) {
      detachClientDisconnect()
      if (concurrencyAcquired && concurrencyRequestId) {
        try {
          await redis.decrOpenaiResponsesAccountConcurrency(account?.id, concurrencyRequestId)
        } catch (releaseError) {
          console.error(releaseError)
        }
        concurrencyAcquired = false
      }
      // 客户端断开导致的主动 abort 不是代理/上游故障，先拦截再 report，否则会污染代理健康与错误日志
      if (error.name === 'AbortError' || error.name === 'CanceledError' || error.code === 'ERR_CANCELED') {
        logger.info('OpenAI-Responses request aborted due to client disconnect')
        if (!res.headersSent && !res.destroyed) {
          res.status(499).end()
        }
        return
      }
      // 被动健康检查：上报连接级故障（classifyBusinessTraffic 区分传输错误 vs 上游响应，不误熔断）
      proxyResolver.report(proxyResolution?.proxyId, proxyResolution?.contextKey, error)
      // 清理 AbortController
      if (abortController && !abortController.signal.aborted) {
        abortController.abort()
      }

      // 安全地记录错误，避免循环引用
      // DEC_20260905_164536 禁止 message 夹带 URL/凭证
      logger.error('OpenAI-Responses relay error:', summarizeErrorForLog(error))

      // 检查是否是网络错误（含 axios 请求超时 ECONNABORTED）
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        if (account?.id) {
          const errorContextNet = upstreamErrorHelper.buildErrorContext({
            url: error.config?.url,
            method: error.config?.method,
            requestHeaders: error.config?.headers,
            requestBody: error.config?.data,
            model: req.body?.model,
            sessionId: sessionHash,
            responseStatus: 503,
            message: error.message,
          })
          await upstreamErrorHelper
            .markTempUnavailable(account.id, 'openai-responses', 503, null, errorContextNet)
            .catch(() => {})
        }
      }

      // 如果已经发送了响应头，直接结束
      if (res.headersSent) {
        return res.end()
      }

      // 检查是否是axios错误并包含响应
      if (error.response) {
        // 处理axios错误响应
        const status = error.response.status || 500
        let errorData = {
          error: {
            message: error.response.statusText || 'Request failed',
            type: 'api_error',
            code: error.code || 'unknown',
          },
        }

        // 如果响应包含数据，尝试使用它
        if (error.response.data) {
          // 检查是否是流
          if (typeof error.response.data === 'object' && !error.response.data.pipe) {
            errorData = error.response.data
          } else if (typeof error.response.data === 'string') {
            try {
              errorData = JSON.parse(error.response.data)
            } catch (e) {
              errorData.error.message = error.response.data
            }
          }
        }

        if (status === 401) {
          logger.warn(`OpenAI Responses账号认证失败（401错误）for account ${account?.id} (catch handler)`)

          try {
            // 仅临时暂停，不永久禁用
            const errorContextCatch401 = upstreamErrorHelper.buildErrorContext({
              url: error.config?.url,
              method: error.config?.method,
              requestHeaders: error.config?.headers,
              requestBody: error.config?.data,
              model: req.body?.model,
              sessionId: sessionHash,
              responseStatus: 401,
              responseHeaders: error.response?.headers,
              responseBody: errorData,
            })
            await upstreamErrorHelper
              .markTempUnavailable(account.id, 'openai-responses', 401, null, errorContextCatch401)
              .catch(() => {})
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.error('Failed to mark OpenAI-Responses account temporarily unavailable in catch handler:', markError)
          }

          // 401 走 buildClientError：隐藏我方账户鉴权，禁止 errorData 原文出站
          // DEC_20260905_155232
          const clientError401 = buildClientError({
            statusCode: 401,
            protocol: 'openai',
            upstreamBody: errorData,
          })
          {
            const sanitized = sanitizeOpenAICapacityShedForClient(clientError401.body)
            return res.status(clientError401.statusCode).json(sanitized.payload)
          }
        }

        const clientError = buildClientError({
          statusCode: status,
          protocol: 'openai',
          upstreamBody: errorData,
        })
        {
          const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
          return res.status(clientError.statusCode).json(sanitized.payload)
        }
      }

      // 其他错误：禁止把内部 error.message 放进客户端 details
      // DEC_20260905_162636
      const clientError = buildClientError({
        statusCode: 500,
        protocol: 'openai',
        upstreamBody: null,
      })
      {
        const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
        return res.status(clientError.statusCode).json(sanitized.payload)
      }
    }
  }

  // 处理流式响应
  async _handleStreamResponse(
    response,
    res,
    account,
    apiKeyData,
    requestedModel,
    detachClientDisconnect,
    req,
    concurrencyOptions = null,
  ) {
    const releaseConcurrency = async () => {
      if (typeof concurrencyOptions?.releaseConcurrency === 'function') {
        await concurrencyOptions.releaseConcurrency()
      }
    }
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    // 透传上游有用响应头，剥网关指纹
    applyFilteredResponseHeaders(res, response.headers)

    let usageData = null
    // 上游实际生效的 service_tier（response.completed 回包里带），供计费定档
    let upstreamServiceTier = null
    let actualModel = null
    let buffer = ''
    let rateLimitDetected = false
    let rateLimitResetsInSeconds = null
    let rateLimitErrorData = null
    let streamEnded = false
    // 客户端已断：停止写 res，但继续读上游以捕获 usage
    let clientGone = Boolean(req?._crsClientGone)

    // 解析 SSE 事件以捕获 usage 数据和 model
    const parseSSEForUsage = (data) => {
      const lines = data.split('\n')

      for (const line of lines) {
        if (line.startsWith('data:')) {
          try {
            const jsonStr = line.slice(5).trim()
            if (jsonStr === '[DONE]') {
              continue
            }

            const eventData = JSON.parse(jsonStr)

            // 检查是否是 response.completed 事件（OpenAI-Responses 格式）
            if (eventData.type === 'response.completed' && eventData.response) {
              // 从响应中获取真实的 model
              if (eventData.response.model) {
                actualModel = eventData.response.model
                logger.debug(`Captured actual model from response.completed: ${actualModel}`)
              }

              // 获取 usage 数据 - OpenAI-Responses 格式在 response.usage 下
              if (eventData.response.service_tier) {
                upstreamServiceTier = eventData.response.service_tier
                logger.debug(`Captured service_tier: ${upstreamServiceTier}`)
              }

              if (eventData.response.usage) {
                usageData = eventData.response.usage
                logger.info('Successfully captured usage data from OpenAI-Responses:', {
                  input_tokens: usageData.input_tokens,
                  output_tokens: usageData.output_tokens,
                  total_tokens: usageData.total_tokens,
                })
              }
            }

            // 检查是否有限流错误
            if (eventData.error) {
              // 检查多种可能的限流错误类型
              if (
                eventData.error.type === 'rate_limit_error' ||
                eventData.error.type === 'usage_limit_reached' ||
                eventData.error.type === 'rate_limit_exceeded'
              ) {
                rateLimitDetected = true
                rateLimitErrorData = eventData.error
                if (eventData.error.resets_in_seconds) {
                  rateLimitResetsInSeconds = eventData.error.resets_in_seconds
                  logger.warn(
                    `Rate limit detected in stream, resets in ${rateLimitResetsInSeconds} seconds (${Math.ceil(rateLimitResetsInSeconds / 60)} minutes)`,
                  )
                }
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    // 监听数据流
    const capacityShedSseRewriter = createCapacityShedSseRewriteStream()
    response.data.on('data', (chunk) => {
      try {
        const chunkStr = chunk.toString()

        // 客户端已断则只解析 usage，不再写回
        if (req?._crsClientGone) {
          clientGone = true
        }

        // 转发数据给客户端
        if (!clientGone && !res.destroyed && !streamEnded) {
          try {
            const rewritten = capacityShedSseRewriter.push(chunk)
            if (rewritten) {
              res.write(rewritten)
              if (rewritten.includes('"error"') || rewritten.includes('server_error')) {
                res._responseBody = res._responseBody || rewritten.slice(0, 2000)
              }
            }
          } catch (e) {
            console.error(e)
            res.write(chunk)
          }
        }

        // 同时解析数据以捕获 usage 信息
        buffer += chunkStr

        // 处理完整的 SSE 事件（兼容 \n\n 与 \r\n\r\n）
        // DEC_20260905_155232
        while (true) {
          const lfIdx = buffer.indexOf('\n\n')
          const crlfIdx = buffer.indexOf('\r\n\r\n')
          let idx = -1
          let sepLen = 2
          if (lfIdx === -1 && crlfIdx === -1) {
            break
          }
          if (lfIdx === -1) {
            idx = crlfIdx
            sepLen = 4
          } else if (crlfIdx === -1) {
            idx = lfIdx
            sepLen = 2
          } else if (crlfIdx < lfIdx) {
            idx = crlfIdx
            sepLen = 4
          } else {
            idx = lfIdx
            sepLen = 2
          }
          const event = buffer.slice(0, idx)
          buffer = buffer.slice(idx + sepLen)
          if (event.trim()) {
            parseSSEForUsage(event)
          }
        }
      } catch (error) {
        logger.error('Error processing stream chunk:', error)
      }
    })

    response.data.on('end', async () => {
      streamEnded = true
      try {
        const rest = capacityShedSseRewriter.flush()
        if (rest && !clientGone && !res.destroyed) {
          res.write(rest)
          if (rest.includes('"error"')) {
            res._responseBody = res._responseBody || rest.slice(0, 2000)
          }
        }
      } catch (e) {
        console.error(e)
      }

      // 处理剩余的 buffer
      if (buffer.trim()) {
        parseSSEForUsage(buffer)
      }

      // 记录使用统计
      if (usageData) {
        try {
          // OpenAI-Responses 使用 input_tokens/output_tokens，标准 OpenAI 使用 prompt_tokens/completion_tokens
          const totalInputTokens = usageData.input_tokens || usageData.prompt_tokens || 0
          const outputTokens = usageData.output_tokens || usageData.completion_tokens || 0

          // 提取缓存相关的 tokens（如果存在）
          const cacheReadTokens = extractOpenAICacheReadTokens(usageData)
          const cacheCreateTokens = extractCacheCreationTokens(usageData)
          // 计算实际输入token（总输入减去缓存部分）
          const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

          const totalTokens = usageData.total_tokens || totalInputTokens + outputTokens + cacheCreateTokens
          const modelToRecord = actualModel || requestedModel || 'gpt-4'

          const serviceTier = resolveOpenAIServiceTier(upstreamServiceTier, req._serviceTier)
          await apiKeyService.recordUsage(
            apiKeyData.id,
            buildTokenUsagePayload({
              inputTokens: actualInputTokens, // 实际输入（不含缓存）
              outputTokens,
              cacheCreateTokens,
              cacheReadTokens,
              rawUsage: usageData,
            }),
            modelToRecord,
            account.id,
            'openai-responses',
            serviceTier,
            createRequestDetailMeta(req, {
              requestBody: req.body,
              stream: true,
              statusCode: res.statusCode,
            }),
          )

          logger.info(
            `Recorded usage - Input: ${totalInputTokens}(actual:${actualInputTokens}+cached:${cacheReadTokens}), CacheCreate: ${cacheCreateTokens}, Output: ${outputTokens}, Total: ${totalTokens}, Model: ${modelToRecord}`,
          )

          // 更新账户的 token 使用统计
          await openaiResponsesAccountService.updateAccountUsage(account.id, totalTokens)

          // 更新账户使用额度（如果设置了额度限制）
          if (parseFloat(account.dailyQuota) > 0) {
            // 使用CostCalculator正确计算费用（考虑缓存token的不同价格）
            const costInfo = CostCalculator.calculateCost(
              {
                input_tokens: actualInputTokens, // 实际输入（不含缓存）
                output_tokens: outputTokens,
                cache_creation_input_tokens: cacheCreateTokens,
                cache_read_input_tokens: cacheReadTokens,
              },
              modelToRecord,
              serviceTier,
            )
            await openaiResponsesAccountService.updateUsageQuota(account.id, costInfo.costs.total)
          }
        } catch (error) {
          logger.error('Failed to record usage:', error)
        }
      } else {
        // 无 response.completed.usage：可能断流/上游异常；记告警便于对账
        logger.warn(
          `[OpenAI-Responses] stream ended without usageData accountId=${account?.id} model=${actualModel || requestedModel || 'unknown'} clientGone=${clientGone}`,
        )
      }

      // 如果在流式响应中检测到限流
      if (rateLimitDetected) {
        // 使用统一调度器处理限流（与非流式响应保持一致）
        // sessionHash 与 handleRequest 入口同源（勿只读 session_id）
        const limitSessionId =
          req.headers['session-id'] ||
          req.headers['session_id'] ||
          req.headers['x-session-id'] ||
          req.headers['thread-id'] ||
          req.body?.session_id ||
          req.body?.sessionId ||
          null
        const limitSessionHash = limitSessionId
          ? crypto.createHash('sha256').update(String(limitSessionId)).digest('hex')
          : null

        await unifiedOpenAIScheduler.markAccountRateLimited(
          account.id,
          'openai-responses',
          limitSessionHash,
          rateLimitResetsInSeconds,
        )

        // 流式限流也必须留详细错误历史（含关闭自动防护）
        // _handleStreamResponse 内无 requestOptions，用 axios response.config + req.body
        const streamErrorContext = upstreamErrorHelper.buildErrorContext({
          url: response?.config?.url,
          method: response?.config?.method || 'POST',
          requestHeaders: response?.config?.headers,
          requestBody: response?.config?.data || req?.body,
          model: requestedModel || req?.body?.model,
          sessionId: limitSessionHash,
          responseStatus: 429,
          responseHeaders: response?.headers,
          responseBody: rateLimitErrorData,
        })
        await upstreamErrorHelper
          .markTempUnavailable(
            account.id,
            'openai-responses',
            429,
            rateLimitResetsInSeconds || null,
            streamErrorContext,
          )
          .catch(() => {})

        logger.warn(`Processing rate limit for OpenAI-Responses account ${account.id} from stream`)
      }

      // 清理监听器与并发槽
      req._crsDrainForUsage = false
      if (req._crsGroupHoldReleaseDeferred === true) {
        req._crsGroupHoldReleaseDeferred = false
        req.releaseGroupCostHold?.()
      }
      detachClientDisconnect()
      await releaseConcurrency()

      if (!clientGone && !res.destroyed) {
        res.end()
      }

      logger.info('Stream response completed', {
        accountId: account.id,
        hasUsage: !!usageData,
        actualModel: actualModel || 'unknown',
        clientGone,
      })
    })

    response.data.on('error', async (error) => {
      streamEnded = true
      // DEC_20260905_165339 禁止整包异常进日志
      logger.error('Stream error:', summarizeErrorForLog(error))

      // 清理监听器与并发槽
      detachClientDisconnect()
      await releaseConcurrency()

      if (!res.headersSent) {
        const clientError = buildClientError({ statusCode: 502, protocol: 'openai' })
        res.status(clientError.statusCode).json(clientError.body)
      } else if (!res.destroyed && !res.writableEnded) {
        // headers 已发：写 SSE 终端 error 帧，禁止静默断流
        try {
          const clientError = buildClientError({ statusCode: 502, protocol: 'openai' })
          const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
          res.write(`data: ${JSON.stringify(sanitized.payload)}\n\n`)
        } catch (e) {
          console.error(summarizeErrorForLog(e))
        }
        res.end()
      }
    })

    // 客户端断连：handleRequest 入口已标 req._crsClientGone 并继续 drain 上游以捕获 usage。
    // 这里禁止再 destroy 上游流，否则 drain 计费失效。
    // 流结束/出错路径负责 releaseConcurrency + detachClientDisconnect。
  }

  // 处理非流式响应
  async _handleNormalResponse(response, res, account, apiKeyData, requestedModel, req) {
    const responseData = response.data

    // 提取 usage 数据和实际 model
    // 支持两种格式：直接的 usage 或嵌套在 response 中的 usage
    const usageData = responseData?.usage || responseData?.response?.usage
    const actualModel = responseData?.model || responseData?.response?.model || requestedModel || 'gpt-4'

    // 记录使用统计
    if (usageData) {
      try {
        // OpenAI-Responses 使用 input_tokens/output_tokens，标准 OpenAI 使用 prompt_tokens/completion_tokens
        const totalInputTokens = usageData.input_tokens || usageData.prompt_tokens || 0
        const outputTokens = usageData.output_tokens || usageData.completion_tokens || 0

        // 提取缓存相关的 tokens（如果存在）
        const cacheReadTokens = extractOpenAICacheReadTokens(usageData)
        const cacheCreateTokens = extractCacheCreationTokens(usageData)
        // 计算实际输入token（总输入减去缓存部分）
        const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

        const totalTokens = usageData.total_tokens || totalInputTokens + outputTokens + cacheCreateTokens

        const serviceTier = resolveOpenAIServiceTier(
          responseData?.service_tier ?? responseData?.response?.service_tier,
          req._serviceTier,
        )
        await apiKeyService.recordUsage(
          apiKeyData.id,
          buildTokenUsagePayload({
            inputTokens: actualInputTokens, // 实际输入（不含缓存）
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            rawUsage: usageData,
          }),
          actualModel,
          account.id,
          'openai-responses',
          serviceTier,
          createRequestDetailMeta(req, {
            requestBody: req?.body,
            stream: false,
            statusCode: response.status,
          }),
        )

        logger.info(
          `Recorded non-stream usage - Input: ${totalInputTokens}(actual:${actualInputTokens}+cached:${cacheReadTokens}), CacheCreate: ${cacheCreateTokens}, Output: ${outputTokens}, Total: ${totalTokens}, Model: ${actualModel}`,
        )

        // 更新账户的 token 使用统计
        await openaiResponsesAccountService.updateAccountUsage(account.id, totalTokens)

        // 更新账户使用额度（如果设置了额度限制）
        if (parseFloat(account.dailyQuota) > 0) {
          // 使用CostCalculator正确计算费用（考虑缓存token的不同价格）
          const costInfo = CostCalculator.calculateCost(
            {
              input_tokens: actualInputTokens, // 实际输入（不含缓存）
              output_tokens: outputTokens,
              cache_creation_input_tokens: cacheCreateTokens,
              cache_read_input_tokens: cacheReadTokens,
            },
            actualModel,
            serviceTier,
          )
          await openaiResponsesAccountService.updateUsageQuota(account.id, costInfo.costs.total)
        }
      } catch (error) {
        logger.error('Failed to record usage:', error)
      }
    }

    // 返回响应
    res.status(response.status).json(responseData)

    logger.info('Normal response completed', {
      accountId: account.id,
      status: response.status,
      hasUsage: !!usageData,
      model: actualModel,
    })
  }

  // 处理 429 限流错误
  async _handle429Error(account, response, isStream = false, sessionHash = null) {
    let resetsInSeconds = null
    let errorData = null

    try {
      // 对于429错误，响应可能是JSON或SSE格式
      if (isStream && response.data && typeof response.data.pipe === 'function') {
        // 流式响应需要先收集数据
        const chunks = []
        await new Promise((resolve, reject) => {
          response.data.on('data', (chunk) => chunks.push(chunk))
          response.data.on('end', resolve)
          response.data.on('error', reject)
          // 设置超时防止无限等待
          setTimeout(resolve, 5000)
        })

        const fullResponse = Buffer.concat(chunks).toString()

        // 尝试解析SSE格式的错误响应
        if (fullResponse.includes('data: ')) {
          const lines = fullResponse.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const jsonStr = line.slice(6).trim()
                if (jsonStr && jsonStr !== '[DONE]') {
                  errorData = JSON.parse(jsonStr)
                  break
                }
              } catch (e) {
                // 继续尝试下一行
              }
            }
          }
        }

        // 如果SSE解析失败，尝试直接解析为JSON
        if (!errorData) {
          try {
            errorData = JSON.parse(fullResponse)
          } catch (e) {
            logger.error('Failed to parse 429 error response:', e)
            // DEC_20260905_162636 禁止日志打上游原文
            logger.debug('Raw 429 response preview:', extractSafeMessage(fullResponse) || '(empty)')
          }
        }
      } else if (response.data && typeof response.data !== 'object') {
        // 如果response.data是字符串，尝试解析为JSON
        try {
          errorData = JSON.parse(response.data)
        } catch (e) {
          logger.error('Failed to parse 429 error response as JSON:', e)
          errorData = { error: { message: extractSafeMessage(response.data) || 'rate limited' } }
        }
      } else if (response.data && typeof response.data === 'object' && !response.data.pipe) {
        // 非流式响应，且是对象，直接使用
        errorData = response.data
      }

      // 从响应体中提取重置时间（OpenAI 标准格式）
      if (errorData && errorData.error) {
        if (errorData.error.resets_in_seconds) {
          resetsInSeconds = errorData.error.resets_in_seconds
          logger.info(
            `Rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes / ${Math.ceil(resetsInSeconds / 3600)} hours)`,
          )
        } else if (errorData.error.resets_in) {
          // 某些 API 可能使用不同的字段名
          resetsInSeconds = parseInt(errorData.error.resets_in)
          logger.info(
            `Rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes / ${Math.ceil(resetsInSeconds / 3600)} hours)`,
          )
        }
      }

      if (!resetsInSeconds) {
        logger.warn('Could not extract reset time from 429 response, using default 60 minutes')
      }
    } catch (e) {
      logger.error('Failed to parse rate limit error:', e)
    }

    // 使用统一调度器标记账户为限流状态（与普通OpenAI账号保持一致）
    await unifiedOpenAIScheduler.markAccountRateLimited(account.id, 'openai-responses', sessionHash, resetsInSeconds)

    logger.warn('OpenAI-Responses account rate limited', {
      accountId: account.id,
      accountName: account.name,
      resetsInSeconds: resetsInSeconds || 'unknown',
      resetInMinutes: resetsInSeconds ? Math.ceil(resetsInSeconds / 60) : 60,
      resetInHours: resetsInSeconds ? Math.ceil(resetsInSeconds / 3600) : 1,
    })

    // 返回处理后的数据，避免循环引用
    return { resetsInSeconds, errorData }
  }

  // 过滤请求头 - 已迁移到 headerFilter 工具类
  // 此方法保留用于向后兼容，实际使用 filterForOpenAI()
  _filterRequestHeaders(headers) {
    return filterForOpenAI(headers)
  }

  // 估算费用（简化版本，实际应该根据不同的定价模型）
  _estimateCost(model, inputTokens, outputTokens) {
    // 这是一个简化的费用估算，实际应该根据不同的 API 提供商和模型定价
    const rates = {
      'gpt-4': { input: 0.03, output: 0.06 }, // per 1K tokens
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
      'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
      'claude-3-opus': { input: 0.015, output: 0.075 },
      'claude-3-sonnet': { input: 0.003, output: 0.015 },
      'claude-3-haiku': { input: 0.00025, output: 0.00125 },
    }

    // 查找匹配的模型定价
    let rate = rates['gpt-3.5-turbo'] // 默认使用 GPT-3.5 的价格
    for (const [modelKey, modelRate] of Object.entries(rates)) {
      if (model.toLowerCase().includes(modelKey.toLowerCase())) {
        rate = modelRate
        break
      }
    }

    const inputCost = (inputTokens / 1000) * rate.input
    const outputCost = (outputTokens / 1000) * rate.output
    return inputCost + outputCost
  }

  // OpenAI Embeddings 透传（/v1/embeddings）
  async handleEmbeddingsRequest(req, res, account, apiKeyData, _accessToken = null) {
    try {
      const fullAccount = await openaiResponsesAccountService.getAccount(account.id)
      if (!fullAccount) {
        throw new Error('Account not found')
      }
      // 失败明细采集用：finish 钩子可带上实际选中的账户
      req._crsAccountId = fullAccount.id
      req._crsAccountType = 'openai-responses'
      if (req.body && typeof req.body.model === 'string') {
        req._crsRequestedModel = req.body.model
      }

      let targetPath = '/v1/embeddings'
      if (req.path && String(req.path).includes('embeddings')) {
        targetPath = req.path.startsWith('/') ? req.path : `/${req.path}`
      }
      const baseApi = fullAccount.baseApi || ''
      if (baseApi.endsWith('/v1') && targetPath.startsWith('/v1/')) {
        targetPath = targetPath.slice(3)
      }
      const targetUrl = `${baseApi}${targetPath}`

      const headers = {
        ...filterForOpenAI(req.headers),
        Authorization: `Bearer ${fullAccount.apiKey}`,
        'Content-Type': 'application/json',
      }
      if (fullAccount.userAgent) {
        headers['User-Agent'] = fullAccount.userAgent
      }

      // embeddings 也走账户映射 + 公开别名（与主路径一致）
      const outboundBody = req.body && typeof req.body === 'object' ? { ...req.body } : req.body
      const requestedModelName = req.body && typeof req.body.model === 'string' ? req.body.model : ''
      let mapped = false
      if (outboundBody && typeof outboundBody === 'object') {
        if (requestedModelName && fullAccount.supportedModels) {
          const mappedModel = getMappedModelName(fullAccount.supportedModels, requestedModelName)
          if (mappedModel && mappedModel !== requestedModelName) {
            outboundBody.model = mappedModel
            mapped = true
            logger.info(
              `OpenAI-Responses embeddings mapping: ${requestedModelName} → ${mappedModel} (account=${account.id})`,
            )
          }
        }
        applyOpenAIPublicModelAlias(outboundBody, {
          originalModel: requestedModelName || null,
          mapped,
        })
      }

      const proxyResolution = proxyResolver.resolveAgent(fullAccount, 'openai-responses')
      const axiosConfig = {
        method: 'POST',
        url: targetUrl,
        data: outboundBody,
        headers,
        timeout: config.requestTimeout || 120000,
        validateStatus: () => true,
      }
      if (proxyResolution?.agent) {
        axiosConfig.httpAgent = proxyResolution.agent
        axiosConfig.httpsAgent = proxyResolution.agent
      }

      const response = await axios(axiosConfig)
      if (req && typeof req === 'object') {
        req._crsUpstreamHeaders = response.headers || null
        req._crsUpstreamRequestIdHeader =
          fullAccount.upstreamRequestIdHeader || fullAccount.extra?.upstreamRequestIdHeader || null
      }
      applyFilteredResponseHeaders(res, response.headers)

      if (response.status >= 400) {
        // DEC_20260905_155232 禁止 response.data 原文出站
        const clientError = buildClientError({
          statusCode: response.status,
          protocol: 'openai',
          upstreamBody: response.data,
        })
        const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
        return res.status(clientError.statusCode).json(sanitized.payload)
      }

      // usage + 费用落库（embeddings 通常只有 prompt_tokens）
      try {
        const usage = response.data?.usage
        if (usage && apiKeyData) {
          const promptTokens = usage.prompt_tokens || usage.total_tokens || 0
          const modelName =
            (typeof response.data?.model === 'string' && response.data.model.trim()) ||
            (outboundBody && typeof outboundBody.model === 'string' && outboundBody.model) ||
            req.body?.model ||
            'text-embedding-3-small'
          if (promptTokens > 0) {
            if (req.rateLimitInfo) {
              await updateRateLimitCounters(
                req.rateLimitInfo,
                { input_tokens: promptTokens, output_tokens: 0 },
                modelName,
                apiKeyData.id,
                'openai-responses',
              )
            }
            await apiKeyService.recordUsage(
              apiKeyData.id,
              buildTokenUsagePayload({
                inputTokens: promptTokens,
                outputTokens: 0,
                cacheCreateTokens: 0,
                cacheReadTokens: 0,
                rawUsage: usage,
              }),
              modelName,
              account.id,
              'openai-responses',
              null,
              createRequestDetailMeta(req, {
                requestBody: req.body,
                stream: false,
                statusCode: response.status,
              }),
            )
            await openaiResponsesAccountService.updateAccountUsage(account.id, promptTokens).catch((error) => {
              console.error(summarizeErrorForLog(error))
            })
          }
        }
      } catch (error) {
        console.error(summarizeErrorForLog(error))
        logger.error('[OpenAI-Responses] embeddings billing failed:', summarizeErrorForLog(error))
      }

      return res.status(response.status).json(response.data)
    } catch (error) {
      console.error(summarizeErrorForLog(error))
      logger.error('[OpenAI-Responses] embeddings failed:', summarizeErrorForLog(error))
      if (!res.headersSent) {
        // DEC_20260905_162636 禁止 error.message 原文出站
        const clientError = buildClientError({
          statusCode: error.statusCode || 500,
          protocol: 'openai',
          upstreamBody: null,
        })
        res.status(clientError.statusCode).json(clientError.body)
      }
    }
  }

  async handleGenericPassthrough(req, res, account, apiKeyData, _accessToken = null) {
    try {
      const fullAccount = await openaiResponsesAccountService.getAccount(account.id)
      if (!fullAccount) {
        throw new Error('Account not found')
      }
      // 失败明细采集用：finish 钩子可带上实际选中的账户
      req._crsAccountId = fullAccount.id
      req._crsAccountType = 'openai-responses'
      if (req.body && typeof req.body.model === 'string') {
        req._crsRequestedModel = req.body.model
      }

      let targetPath = req.path || req.url || '/'
      // strip query
      targetPath = String(targetPath).split('?')[0]
      if (!targetPath.startsWith('/')) {
        targetPath = `/${targetPath}`
      }
      // normalize mount prefixes
      for (const prefix of ['/openai', '/api']) {
        if (targetPath.startsWith(`${prefix}/`)) {
          targetPath = targetPath.slice(prefix.length)
        }
      }
      const baseApi = fullAccount.baseApi || ''
      if (baseApi.endsWith('/v1') && targetPath.startsWith('/v1/')) {
        targetPath = targetPath.slice(3)
      }
      const targetUrl = `${baseApi}${targetPath}`

      const headers = {
        ...filterForOpenAI(req.headers),
        Authorization: `Bearer ${fullAccount.apiKey}`,
      }
      const contentType = req.headers['content-type'] || req.headers['Content-Type']
      if (contentType) {
        headers['Content-Type'] = contentType
      } else {
        headers['Content-Type'] = 'application/json'
      }
      if (fullAccount.userAgent) {
        headers['User-Agent'] = fullAccount.userAgent
      }

      const proxyResolution = proxyResolver.resolveAgent(fullAccount, 'openai-responses')
      // multipart 音频：必须透传原始 body（req.rawBody），不能发 express.json 解析后的对象
      const isMultipart = String(contentType || '').includes('multipart/form-data')
      // DEC_20260905_194420 passthrough 保留 reasoning / reasoning_effort；multipart 也做 model 映射改写
      let requestData = isMultipart && req.rawBody ? req.rawBody : req.body
      if (isMultipart && Buffer.isBuffer(req.rawBody)) {
        const multipartContentType = contentType || req.headers['content-type'] || ''
        const requestedModelName =
          (req.body && typeof req.body.model === 'string' && req.body.model) ||
          extractMultipartFormField(req.rawBody, 'model', { contentType: multipartContentType }) ||
          ''
        let outboundModel = requestedModelName
        if (requestedModelName && fullAccount.supportedModels) {
          const mappedModel = getMappedModelName(fullAccount.supportedModels, requestedModelName)
          if (mappedModel && mappedModel !== requestedModelName) {
            outboundModel = mappedModel
            logger.info(
              `OpenAI-Responses multipart mapping: ${requestedModelName} → ${mappedModel} (account=${account.id})`,
            )
          }
        }
        const aliasBody = { model: outboundModel || requestedModelName }
        applyOpenAIPublicModelAlias(aliasBody, {
          originalModel: requestedModelName || null,
          mapped: outboundModel !== requestedModelName,
        })
        if (aliasBody.model && aliasBody.model !== requestedModelName) {
          requestData = rewriteMultipartFormField(req.rawBody, 'model', aliasBody.model, {
            contentType: multipartContentType,
          })
          if (req.body && typeof req.body === 'object') {
            req.body.model = aliasBody.model
          }
        }
      } else if (!isMultipart && requestData && typeof requestData === 'object' && !Buffer.isBuffer(requestData)) {
        requestData = { ...requestData }
        applyOpenAIServiceTierAlias(requestData)
        const requestedModelName = req.body && typeof req.body.model === 'string' ? req.body.model : ''
        let mapped = false
        if (requestedModelName && fullAccount.supportedModels) {
          const mappedModel = getMappedModelName(fullAccount.supportedModels, requestedModelName)
          if (mappedModel && mappedModel !== requestedModelName) {
            requestData.model = mappedModel
            mapped = true
          }
        }
        applyOpenAIPublicModelAlias(requestData, {
          originalModel: requestedModelName || null,
          mapped,
        })
        // 显式保留 reasoning 字段（即使别名/映射路径以后再加字段剥离也不会默丢）
        if (req.body && typeof req.body === 'object') {
          if (Object.prototype.hasOwnProperty.call(req.body, 'reasoning')) {
            requestData.reasoning = req.body.reasoning
          }
          if (Object.prototype.hasOwnProperty.call(req.body, 'reasoning_effort')) {
            requestData.reasoning_effort = req.body.reasoning_effort
          }
        }
      }
      const axiosConfig = {
        method: req.method || 'POST',
        url: targetUrl,
        data: requestData,
        headers,
        timeout: config.requestTimeout || 600000,
        validateStatus: () => true,
        responseType: String(targetPath).includes('/audio/speech') ? 'arraybuffer' : 'json',
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
      if (proxyResolution?.agent) {
        axiosConfig.httpAgent = proxyResolution.agent
        axiosConfig.httpsAgent = proxyResolution.agent
      }

      const response = await axios(axiosConfig)
      if (req && typeof req === 'object') {
        req._crsUpstreamHeaders = response.headers || null
        req._crsUpstreamRequestIdHeader =
          fullAccount.upstreamRequestIdHeader || fullAccount.extra?.upstreamRequestIdHeader || null
      }
      applyFilteredResponseHeaders(res, response.headers)
      if (response.status >= 400) {
        // DEC_20260905_155232 禁止 response.data 原文出站
        const upstreamBody =
          Buffer.isBuffer(response.data) || response.data instanceof ArrayBuffer
            ? { error: { message: 'upstream audio error' } }
            : response.data
        const clientError = buildClientError({
          statusCode: response.status,
          protocol: 'openai',
          upstreamBody,
        })
        const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
        return res.status(clientError.statusCode).json(sanitized.payload)
      }

      if (axiosConfig.responseType === 'arraybuffer') {
        const buf = Buffer.from(response.data)
        const ct = response.headers['content-type'] || 'audio/mpeg'
        res.setHeader('Content-Type', ct)
        // TTS 计费（按定价表字段选型，避免「字符当 token / 输出恒 0」漏计漏收）：
        // - 有 output_cost_per_second → audio_output_seconds
        // - 有 output_cost_per_token / audio_token → 按秒粗估 outputTokens
        // - 有 input_cost_per_token → 输入按 ~4 字符/token 估，禁止把字符数当 token
        if (apiKeyData) {
          try {
            const modelName =
              (requestData &&
                typeof requestData === 'object' &&
                typeof requestData.model === 'string' &&
                requestData.model) ||
              req.body?.model ||
              'tts-1'
            const inputText = typeof req.body?.input === 'string' ? req.body.input : ''
            const inputChars = inputText.length
            // 时长：字符语速与音频体积取较大值（mp3 ~16KB/s @128kbps）
            const charSeconds = inputChars > 0 ? Math.max(1, Math.ceil(inputChars / 15)) : 0
            const sizeSeconds = buf && buf.length > 0 ? Math.max(1, Math.ceil(buf.length / 16000)) : 0
            const estimatedSeconds = Math.max(charSeconds, sizeSeconds)

            const pricing = pricingService.getModelPricing(modelName) || CostCalculator.getModelPricing(modelName) || {}
            const hasOutputPerSecond =
              Number(pricing.output_cost_per_second || pricing.output_cost_per_audio_per_second) > 0
            const outputTokenRate = Number(pricing.output_cost_per_token || pricing.output_cost_per_audio_token || 0)
            const inputTokenRate = Number(pricing.input_cost_per_token || pricing.input_cost_per_audio_token || 0)

            // 输入 token：仅在定价吃 token 时估算（约 4 字符/token）
            const inputTokens = inputTokenRate > 0 && inputChars > 0 ? Math.max(1, Math.ceil(inputChars / 4)) : 0
            // 输出 token：无 per-second 价、但有 per-token 价时，按 ~25 token/s 音频粗估
            const outputTokens =
              !hasOutputPerSecond && outputTokenRate > 0 && estimatedSeconds > 0
                ? Math.max(1, Math.ceil(estimatedSeconds * 25))
                : 0

            const billingUsage =
              hasOutputPerSecond && estimatedSeconds > 0
                ? {
                    audio_output_seconds: estimatedSeconds,
                    output_audio_seconds: estimatedSeconds,
                  }
                : null

            await apiKeyService.recordUsage(
              apiKeyData.id,
              buildTokenUsagePayload({
                inputTokens,
                outputTokens,
                cacheCreateTokens: 0,
                cacheReadTokens: 0,
                rawUsage: null,
              }),
              modelName,
              account.id,
              'openai-responses',
              null,
              createRequestDetailMeta(req, {
                requestBody: isMultipart ? { _multipart: true, path: targetPath } : req.body,
                stream: false,
                statusCode: response.status,
                billingUsage,
              }),
            )
          } catch (error) {
            console.error(summarizeErrorForLog(error))
          }
        }
        return res.status(response.status).send(buf)
      }

      // whisper 等 JSON：优先用上游 duration（秒）作 audio_input_seconds
      if (apiKeyData) {
        try {
          const usage = response.data?.usage || {}
          const promptTokens = usage.prompt_tokens || usage.input_tokens || 0
          const completionTokens = usage.completion_tokens || usage.output_tokens || 0
          const durationSeconds = Number(response.data?.duration || usage.seconds || usage.duration || 0)
          const billingUsage =
            Number.isFinite(durationSeconds) && durationSeconds > 0
              ? {
                  audio_input_seconds: durationSeconds,
                  input_audio_seconds: durationSeconds,
                }
              : null
          if (promptTokens > 0 || completionTokens > 0 || billingUsage || isMultipart) {
            await apiKeyService.recordUsage(
              apiKeyData.id,
              buildTokenUsagePayload({
                inputTokens: promptTokens,
                outputTokens: completionTokens,
                cacheCreateTokens: 0,
                cacheReadTokens: 0,
                rawUsage: usage || null,
              }),
              req.body?.model || 'whisper-1',
              account.id,
              'openai-responses',
              null,
              createRequestDetailMeta(req, {
                requestBody: isMultipart ? { _multipart: true, path: targetPath } : req.body,
                stream: false,
                statusCode: response.status,
                billingUsage,
              }),
            )
          }
        } catch (error) {
          console.error(summarizeErrorForLog(error))
          logger.error('[OpenAI-Responses] passthrough billing failed:', summarizeErrorForLog(error))
        }
      }
      return res.status(response.status).json(response.data)
    } catch (error) {
      console.error(summarizeErrorForLog(error))
      logger.error('[OpenAI-Responses] generic passthrough failed:', summarizeErrorForLog(error))
      if (!res.headersSent) {
        // DEC_20260905_162636 禁止 error.message 原文出站
        const clientError = buildClientError({
          statusCode: error.statusCode || 500,
          protocol: 'openai',
          upstreamBody: null,
        })
        res.status(clientError.statusCode).json(clientError.body)
      }
    }
  }
}

export const openaiResponsesRelayService = new OpenAIResponsesRelayService()
