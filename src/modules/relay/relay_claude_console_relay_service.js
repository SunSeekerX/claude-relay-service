import axios from 'axios'
import { StringDecoder } from 'node:string_decoder'
import { IncrementalSSEParser, parseSSEEvent } from './relay_sse_parser.js'
import { ClaudeStreamState } from './relay_claude_stream_state.js'
import { createClaudeStreamFinalizer } from './relay_claude_stream_usage.js'
import { claudeConsoleAccountService } from '../account/account_claude_console_service.js'
import { redis } from '../../infra/redis.js'
import { logger } from '../../common/logger.js'
import { config } from '../../../config/config.js'
import * as upstreamErrorHelper from './relay_upstream_error_helper.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { userMessageQueueService } from '../user/user_message_queue_service.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import { createStreamBackpressure, isStreamWritable } from '../../common/stream_helper.js'
import { filterForClaude } from './relay_header_filter.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { isAccountDisabledError } from '../../common/error_sanitizer.js'
import {
  buildAnthropicClientErrorBody,
  buildClientError,
  extractSafeMessage,
  summarizeErrorForLog,
} from '../../common/client_error_builder.js'
import { createClaudeTestPayload, sendStreamTestRequest } from '../../common/test_payload_helper.js'
import crypto from 'node:crypto'
import { sanitizeClaudeBodyFallbacks } from './translator/relay_translator_body_sanitize.js'
import { buildClaudeCliUserAgent } from './relay_claude_cli_version.js'
import { ensureAlignedBillingHeader } from './relay_claude_billing_header.js'
import { normalizeClaudeRequestForModel } from './translator/relay_translator_thinking.js'
class ClaudeConsoleRelayService {
  constructor() {
    this.defaultUserAgent = buildClaudeCliUserAgent()
  }

  // 流式错误写客户端：OpenAI 转换 vs Anthropic 信封；禁止 error.message 原文
  // DEC_20260905_162636
  _writeStreamClientError(
    responseStream,
    { statusCode = 500, rawBody = null, streamTransformer = null, fallbackMessage = 'Stream error' } = {},
  ) {
    if (responseStream.req?._crsUpstreamHeaders) {
      responseStream.req._crsRecordRelayResult?.({ statusCode, final: true })
    }
    if (!isStreamWritable(responseStream)) {
      return
    }
    if (streamTransformer) {
      const clientError = buildClientError({
        statusCode,
        protocol: 'openai',
        upstreamBody: rawBody,
      })
      responseStream.write(`data: ${JSON.stringify(clientError.body)}\n\n`)
      return
    }
    const anthropicBody = buildAnthropicClientErrorBody({
      statusCode,
      upstreamBody: rawBody,
      fallbackMessage,
    })
    responseStream.write(`event: error\ndata: ${JSON.stringify(anthropicBody)}\n\n`)
  }

  // 转发请求到Claude Console API
  async relayRequest(requestBody, apiKeyData, clientRequest, clientResponse, clientHeaders, accountId, options = {}) {
    let abortController = null
    let detachClientDisconnect = () => {}
    let account = null
    const requestId = crypto.randomUUID() // 用于并发追踪
    let concurrencyAcquired = false
    let queueLockAcquired = false
    let queueRequestId = null
    let proxyResolution = null

    try {
      // 用户消息队列处理：如果是用户消息请求，需要获取队列锁
      if (userMessageQueueService.isUserMessageRequest(requestBody)) {
        // 校验 accountId 非空，避免空值污染队列锁键
        if (!accountId || accountId === '') {
          logger.error('accountId missing for queue lock in console relayRequest')
          throw new Error('accountId missing for queue lock')
        }
        const queueResult = await userMessageQueueService.acquireQueueLock(accountId)
        if (!queueResult.acquired && !queueResult.skipped) {
          // 区分 Redis 后端错误和队列超时
          const isBackendError = queueResult.error === 'queue_backend_error'
          const errorCode = isBackendError ? 'QUEUE_BACKEND_ERROR' : 'QUEUE_TIMEOUT'
          const errorType = isBackendError ? 'queue_backend_error' : 'queue_timeout'
          const errorMessage = isBackendError
            ? 'Queue service temporarily unavailable, please retry later'
            : 'User message queue wait timeout, please retry later'
          const statusCode = isBackendError ? 500 : 503

          // 结构化性能日志，用于后续统计
          logger.performance('user_message_queue_error', {
            errorType,
            errorCode,
            accountId,
            statusCode,
            apiKeyName: apiKeyData.name,
            backendError: isBackendError ? queueResult.errorMessage : undefined,
          })

          logger.warn(
            `User message queue ${errorType} for console account ${accountId}, key: ${apiKeyData.name}`,
            isBackendError ? { backendError: queueResult.errorMessage } : {},
          )
          return {
            statusCode,
            headers: {
              'Content-Type': 'application/json',
              'x-user-message-queue-error': errorType,
            },
            body: JSON.stringify({
              type: 'error',
              error: {
                type: errorType,
                code: errorCode,
                message: errorMessage,
              },
            }),
            accountId,
          }
        }
        if (queueResult.acquired && !queueResult.skipped) {
          queueLockAcquired = true
          queueRequestId = queueResult.requestId
          logger.debug(
            `User message queue lock acquired for console account ${accountId}, requestId: ${queueRequestId}`,
          )
        }
      }

      // 获取账户信息
      account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Claude Console Claude account not found')
      }

      const autoProtectionDisabled = account.disableAutoProtection === true

      logger.info(
        `Processing Claude Console API request for key: ${apiKeyData.name || apiKeyData.id}, account: ${account.name} (${accountId}), request: ${requestId}`,
      )

      // 并发控制：原子性抢占槽位
      if (account.maxConcurrentTasks > 0) {
        // 先抢占，再检查 - 避免竞态条件
        const newConcurrency = Number(await redis.incrConsoleAccountConcurrency(accountId, requestId, 600))
        concurrencyAcquired = true

        // 检查是否超过限制
        if (newConcurrency > account.maxConcurrentTasks) {
          // 超限，立即回滚
          await redis.decrConsoleAccountConcurrency(accountId, requestId)
          concurrencyAcquired = false

          logger.warn(
            `Console account ${account.name} (${accountId}) concurrency limit exceeded: ${newConcurrency}/${account.maxConcurrentTasks} (request: ${requestId}, rolled back)`,
          )

          const error = new Error('Console account concurrency limit reached')
          error.code = 'CONSOLE_ACCOUNT_CONCURRENCY_FULL'
          error.accountId = accountId
          throw error
        }

        logger.debug(
          `Acquired concurrency slot for account ${account.name} (${accountId}), current: ${newConcurrency}/${account.maxConcurrentTasks}, request: ${requestId}`,
        )
      }
      logger.debug(`Account API URL: ${account.apiUrl}`)
      logger.debug(`Account supportedModels: ${JSON.stringify(account.supportedModels)}`)
      logger.debug(`Account has apiKey: ${!!account.apiKey}`)
      logger.debug(`Request model: ${requestBody.model}`)

      // 处理模型映射
      let mappedModel = requestBody.model
      if (
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
      ) {
        const newModel = claudeConsoleAccountService.getMappedModel(account.supportedModels, requestBody.model)
        if (newModel !== requestBody.model) {
          logger.info(`Mapping model from ${requestBody.model} to ${newModel}`)
          mappedModel = newModel
        }
      }

      // 创建修改后的请求体
      const modifiedRequestBody = {
        ...requestBody,
        model: mappedModel,
      }
      sanitizeClaudeBodyFallbacks(modifiedRequestBody, { vendor: 'console' })

      // 模型兼容性检查已经在调度器中完成，这里不需要再检查

      // 创建代理agent（保留 proxyId/contextKey 供被动健康检查上报）
      proxyResolution = proxyResolver.resolveAgent(account, 'claude_console')
      const proxyAgent = proxyResolution.agent

      // 创建AbortController用于取消请求
      abortController = new AbortController()

      // 监听客户端断开：判据收口在 utils/clientDisconnect（禁用 req 'close'，它在请求体读完时即触发）
      if (clientResponse) {
        detachClientDisconnect = onClientDisconnect(
          clientResponse,
          () => {
            if (abortController && !abortController.signal.aborted) {
              abortController.abort()
            }
          },
          'Claude Console Claude request',
        )
      }

      // 构建完整的API URL
      const cleanUrl = account.apiUrl.replace(/\/$/, '') // 移除末尾斜杠
      let apiEndpoint

      if (options.customPath) {
        // 如果指定了自定义路径（如 count_tokens），使用它
        const baseUrl = cleanUrl.replace(/\/v1\/messages$/, '') // 移除已有的 /v1/messages
        apiEndpoint = `${baseUrl}${options.customPath}`
      } else {
        // 默认使用 messages 端点
        apiEndpoint = cleanUrl.endsWith('/v1/messages') ? cleanUrl : `${cleanUrl}/v1/messages`
      }

      logger.debug(`Final API endpoint: ${apiEndpoint}`)
      logger.debug(`[DEBUG] Options passed to relayRequest: ${JSON.stringify(options)}`)
      logger.debug(`[DEBUG] Client headers received: ${JSON.stringify(clientHeaders)}`)

      // 过滤客户端请求头
      const filteredHeaders = this._filterClientHeaders(clientHeaders)
      logger.debug(`[DEBUG] Filtered client headers: ${JSON.stringify(filteredHeaders)}`)

      // 决定使用的 User-Agent：优先使用账户自定义的，否则透传客户端的，最后才使用默认值
      const userAgent =
        account.userAgent || clientHeaders?.['user-agent'] || clientHeaders?.['User-Agent'] || this.defaultUserAgent

      // DEC_20260905_194420 Console 全路径也注入 billing 并与出站 UA 对齐
      ensureAlignedBillingHeader(modifiedRequestBody, { userAgent })
      // DEC_20261001_114137 按映射后模型能力归一 thinking 与采样参数
      normalizeClaudeRequestForModel(modifiedRequestBody, modifiedRequestBody.model)

      // 准备请求配置：先 spread 再强制 User-Agent，避免客户端 ua 覆盖
      const requestConfig = {
        method: 'POST',
        url: apiEndpoint,
        data: modifiedRequestBody,
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...filteredHeaders,
          'User-Agent': userAgent,
        },
        timeout: config.requestTimeout || 600000,
        signal: abortController.signal,
        validateStatus: () => true, // 接受所有状态码
      }

      if (proxyAgent) {
        requestConfig.httpAgent = proxyAgent
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
      }

      // 根据 API Key 格式选择认证方式
      if (account.apiKey && account.apiKey.startsWith('sk-ant-')) {
        // Anthropic 官方 API Key 使用 x-api-key
        requestConfig.headers['x-api-key'] = account.apiKey
        logger.debug('[DEBUG] Using x-api-key authentication for sk-ant-* API key')
      } else {
        // 其他 API Key 使用 Authorization Bearer
        requestConfig.headers['Authorization'] = `Bearer ${account.apiKey}`
        logger.debug('[DEBUG] Using Authorization Bearer authentication')
      }

      logger.debug(`[DEBUG] Initial headers before beta: ${JSON.stringify(requestConfig.headers, null, 2)}`)

      // 添加beta header如果需要
      if (options.betaHeader) {
        logger.debug(`[DEBUG] Adding beta header: ${options.betaHeader}`)
        requestConfig.headers['anthropic-beta'] = options.betaHeader
      } else {
        logger.debug('[DEBUG] No beta header to add')
      }

      // 发送请求
      logger.debug(
        'Sending request to Claude Console API with headers:',
        JSON.stringify(requestConfig.headers, null, 2),
      )
      const response = await axios(requestConfig)

      // DEC_20260905_194420 上游响应头挂 clientRequest
      if (clientRequest && typeof clientRequest === 'object') {
        clientRequest._crsUpstreamHeaders = response.headers || null
        clientRequest._crsUpstreamRequestIdHeader =
          account?.upstreamRequestIdHeader || account?.extra?.upstreamRequestIdHeader || null
      }

      // 请求已发送成功，立即释放队列锁（无需等待响应处理完成）
      // Claude API 限流基于请求发送时刻计算（RPM），不是请求完成时刻
      if (queueLockAcquired && queueRequestId && accountId) {
        try {
          await userMessageQueueService.releaseQueueLock(accountId, queueRequestId)
          queueLockAcquired = false // 标记已释放，防止 finally 重复释放
          logger.debug(
            `User message queue lock released early for console account ${accountId}, requestId: ${queueRequestId}`,
          )
        } catch (releaseError) {
          logger.error(
            `Failed to release user message queue lock early for console account ${accountId}:`,
            releaseError.message,
          )
        }
      }

      // 移除监听器（请求成功完成）
      detachClientDisconnect()

      logger.debug(`Claude Console API response: ${response.status}`)
      logger.debug(`[DEBUG] Response headers: ${JSON.stringify(response.headers)}`)
      logger.debug(`[DEBUG] Response data type: ${typeof response.data}`)
      logger.debug(
        `[DEBUG] Response data length: ${response.data ? (typeof response.data === 'string' ? response.data.length : JSON.stringify(response.data).length) : 0}`,
      )

      // 对于错误响应：日志只打脱敏文案；body 用 Anthropic 信封
      // DEC_20260905_161107
      if (response.status < 200 || response.status >= 300) {
        const safeMsg = extractSafeMessage(response.data) || `Claude Console error: ${response.status}`
        logger.error(`Upstream error from ${account?.name || accountId}: status=${response.status} message=${safeMsg}`)
      } else {
        logger.debug(
          `[DEBUG] Response data preview: ${typeof response.data === 'string' ? response.data.substring(0, 200) : JSON.stringify(response.data).substring(0, 200)}`,
        )
      }

      // 检查是否为账户禁用/不可用的 400 错误
      const accountDisabledError = isAccountDisabledError(response.status, response.data)

      // 错误响应上下文（仅错误时构造，避免正常响应的序列化开销）
      const errorContext =
        response.status >= 400
          ? upstreamErrorHelper.buildErrorContext({
              url: requestConfig.url,
              method: requestConfig.method,
              requestHeaders: requestConfig.headers,
              requestBody: requestConfig.data,
              model: requestConfig.data?.model,
              responseStatus: response.status,
              responseHeaders: response.headers,
              responseBody: response.data,
            })
          : null

      // 检查错误状态并相应处理
      if (response.status === 401) {
        logger.warn(
          `Unauthorized error detected for Claude Console account ${accountId}${autoProtectionDisabled ? ' (auto-protection disabled, skipping status change)' : ''}`,
        )

        await upstreamErrorHelper
          .markTempUnavailable(accountId, 'claude-console', 401, null, errorContext)
          .catch(() => {})
      } else if (accountDisabledError) {
        logger.error(
          `Account disabled error (400) detected for Claude Console account ${accountId}${autoProtectionDisabled ? ' (auto-protection disabled, skipping status change)' : ''}`,
        )
        // webhook 只传脱敏 message，禁止上游原文
        // DEC_20260905_162636
        const errorDetails = extractSafeMessage(response.data) || 'account disabled'
        if (!autoProtectionDisabled) {
          await claudeConsoleAccountService.markConsoleAccountBlocked(accountId, errorDetails)
        }
        // blocked 标记受开关约束；错误历史始终写。
        // 禁止把 raw errorDetails 写入 message（会绕过 buildErrorContext 脱敏）；正文已在 errorContext.errorBody
        upstreamErrorHelper
          .recordErrorHistory(
            accountId,
            'claude-console',
            400,
            'auth_error',
            errorContext
              ? { ...errorContext, reason: 'account_disabled' }
              : upstreamErrorHelper.buildErrorContext({
                  reason: 'account_disabled',
                  responseStatus: 400,
                  responseBody: response.data,
                }),
          )
          .catch((e) => console.error(e))
      } else if (response.status === 429) {
        logger.warn(
          `Rate limit detected for Claude Console account ${accountId}${autoProtectionDisabled ? ' (auto-protection disabled, skipping status change)' : ''}`,
        )
        // 收到429先检查是否超过手动配置的每日额度
        await claudeConsoleAccountService.checkQuotaUsage(accountId).catch((err) => {
          logger.error('Failed to check quota after 429 error:', err)
        })

        if (!autoProtectionDisabled) {
          await claudeConsoleAccountService.markAccountRateLimited(accountId)
        }
        await upstreamErrorHelper
          .markTempUnavailable(
            accountId,
            'claude-console',
            429,
            upstreamErrorHelper.parseRetryAfter(response.headers),
            errorContext,
          )
          .catch(() => {})
      } else if (response.status === 529) {
        logger.warn(
          `Overload error detected for Claude Console account ${accountId}${autoProtectionDisabled ? ' (auto-protection disabled, skipping status change)' : ''}`,
        )

        if (!autoProtectionDisabled) {
          await claudeConsoleAccountService.markAccountOverloaded(accountId)
        }
        await upstreamErrorHelper
          .markTempUnavailable(accountId, 'claude-console', 529, null, errorContext)
          .catch(() => {})
      } else if (response.status >= 500) {
        logger.warn(
          `Server error (${response.status}) detected for Claude Console account ${accountId}${autoProtectionDisabled ? ' (auto-protection disabled, skipping status change)' : ''}`,
        )

        await upstreamErrorHelper
          .markTempUnavailable(accountId, 'claude-console', response.status, null, errorContext)
          .catch(() => {})
      } else if (response.status === 200 || response.status === 201) {
        // 如果请求成功，检查并移除错误状态
        const isRateLimited = await claudeConsoleAccountService.isAccountRateLimited(accountId)
        if (isRateLimited) {
          await claudeConsoleAccountService.removeAccountRateLimit(accountId)
        }
        const isOverloaded = await claudeConsoleAccountService.isAccountOverloaded(accountId)
        if (isOverloaded) {
          await claudeConsoleAccountService.removeAccountOverload(accountId)
        }
      }

      // 更新最后使用时间
      await this._updateLastUsedTime(accountId)

      // 准备响应体：错误走 Anthropic 信封
      let responseBody
      if (response.status < 200 || response.status >= 300) {
        // DEC_20260905_161107 Console 非流式错误对齐 Anthropic 信封
        responseBody = JSON.stringify(
          buildAnthropicClientErrorBody({
            statusCode: response.status,
            upstreamBody: response.data,
            fallbackMessage: `Claude Console error: ${response.status}`,
          }),
        )
        logger.debug(`Sanitized console error response to Anthropic envelope`)
      } else {
        // 成功响应，不需要清理
        responseBody = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      }

      logger.debug(`[DEBUG] Final response body to return: ${responseBody.substring(0, 200)}...`)

      // 被动健康检查：拿到 HTTP 响应即代理传输成功（含 4xx/5xx，不归咎代理）
      proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, null)

      return {
        statusCode: response.status,
        headers: response.headers,
        body: responseBody,
        accountId,
      }
    } catch (error) {
      // 客户端断开导致的主动 abort 不是代理/上游故障，先拦截再 report，否则会污染代理健康与错误日志
      if (error.name === 'AbortError' || error.name === 'CanceledError' || error.code === 'ERR_CANCELED') {
        logger.info('Request aborted due to client disconnect')
        throw new Error('Client disconnected', { cause: error })
      }
      // 被动健康检查：上报连接级故障（classifyBusinessTraffic 区分传输错误 vs 上游响应）
      proxyResolver.report(proxyResolution?.proxyId, proxyResolution?.contextKey, error)

      logger.error(`Claude Console relay request failed (Account: ${account?.name || accountId}):`, error.message)

      // 不因模型不支持而 block 账号

      throw error
    } finally {
      // 并发控制：释放并发槽位
      if (concurrencyAcquired) {
        try {
          await redis.decrConsoleAccountConcurrency(accountId, requestId)
          logger.debug(`Released concurrency slot for account ${account?.name || accountId}, request: ${requestId}`)
        } catch (releaseError) {
          logger.error(
            `Failed to release concurrency slot for account ${accountId}, request: ${requestId}:`,
            releaseError.message,
          )
        }
      }

      // 释放用户消息队列锁（兜底，正常情况下已在请求发送后提前释放）
      if (queueLockAcquired && queueRequestId && accountId) {
        try {
          await userMessageQueueService.releaseQueueLock(accountId, queueRequestId)
          logger.debug(
            `User message queue lock released in finally for console account ${accountId}, requestId: ${queueRequestId}`,
          )
        } catch (releaseError) {
          logger.error(`Failed to release user message queue lock for account ${accountId}:`, releaseError.message)
        }
      }
    }
  }

  // 处理流式响应
  async relayStreamRequestWithUsageCapture(
    requestBody,
    apiKeyData,
    responseStream,
    clientHeaders,
    usageCallback,
    accountId,
    streamTransformer = null,
    options = {},
  ) {
    let account = null
    const requestId = crypto.randomUUID() // 用于并发追踪
    let concurrencyAcquired = false
    let leaseRefreshInterval = null // 租约刷新定时器
    let queueLockAcquired = false
    let queueRequestId = null
    let proxyResolution = null

    try {
      // 用户消息队列处理：如果是用户消息请求，需要获取队列锁
      if (userMessageQueueService.isUserMessageRequest(requestBody)) {
        // 校验 accountId 非空，避免空值污染队列锁键
        if (!accountId || accountId === '') {
          logger.error('accountId missing for queue lock in console relayStreamRequestWithUsageCapture')
          throw new Error('accountId missing for queue lock')
        }
        const queueResult = await userMessageQueueService.acquireQueueLock(accountId)
        if (!queueResult.acquired && !queueResult.skipped) {
          // 区分 Redis 后端错误和队列超时
          const isBackendError = queueResult.error === 'queue_backend_error'
          const errorCode = isBackendError ? 'QUEUE_BACKEND_ERROR' : 'QUEUE_TIMEOUT'
          const errorType = isBackendError ? 'queue_backend_error' : 'queue_timeout'
          const errorMessage = isBackendError
            ? 'Queue service temporarily unavailable, please retry later'
            : 'User message queue wait timeout, please retry later'
          const statusCode = isBackendError ? 500 : 503

          // 结构化性能日志，用于后续统计
          logger.performance('user_message_queue_error', {
            errorType,
            errorCode,
            accountId,
            statusCode,
            stream: true,
            apiKeyName: apiKeyData.name,
            backendError: isBackendError ? queueResult.errorMessage : undefined,
          })

          logger.warn(
            `User message queue ${errorType} for console account ${accountId} (stream), key: ${apiKeyData.name}`,
            isBackendError ? { backendError: queueResult.errorMessage } : {},
          )
          if (!responseStream.headersSent) {
            const existingConnection = responseStream.getHeader ? responseStream.getHeader('Connection') : null
            responseStream.writeHead(statusCode, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: existingConnection || 'keep-alive',
              'x-user-message-queue-error': errorType,
            })
          }
          const errorEvent = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: errorType, code: errorCode, message: errorMessage } })}\n\n`
          responseStream.write(errorEvent)
          responseStream.write('data: [DONE]\n\n')
          responseStream.end()
          return
        }
        if (queueResult.acquired && !queueResult.skipped) {
          queueLockAcquired = true
          queueRequestId = queueResult.requestId
          logger.debug(
            `User message queue lock acquired for console account ${accountId} (stream), requestId: ${queueRequestId}`,
          )
        }
      }

      // 获取账户信息
      account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Claude Console Claude account not found')
      }

      logger.info(
        `Processing streaming Claude Console API request for key: ${apiKeyData.name || apiKeyData.id}, account: ${account.name} (${accountId}), request: ${requestId}`,
      )

      // 并发控制：原子性抢占槽位
      if (account.maxConcurrentTasks > 0) {
        // 先抢占，再检查 - 避免竞态条件
        const newConcurrency = Number(await redis.incrConsoleAccountConcurrency(accountId, requestId, 600))
        concurrencyAcquired = true

        // 检查是否超过限制
        if (newConcurrency > account.maxConcurrentTasks) {
          // 超限，立即回滚
          await redis.decrConsoleAccountConcurrency(accountId, requestId)
          concurrencyAcquired = false

          logger.warn(
            `Console account ${account.name} (${accountId}) concurrency limit exceeded: ${newConcurrency}/${account.maxConcurrentTasks} (stream request: ${requestId}, rolled back)`,
          )

          const error = new Error('Console account concurrency limit reached')
          error.code = 'CONSOLE_ACCOUNT_CONCURRENCY_FULL'
          error.accountId = accountId
          throw error
        }

        logger.debug(
          `Acquired concurrency slot for stream account ${account.name} (${accountId}), current: ${newConcurrency}/${account.maxConcurrentTasks}, request: ${requestId}`,
        )

        // 启动租约刷新定时器（每5分钟刷新一次，防止长连接租约过期）
        leaseRefreshInterval = setInterval(
          async () => {
            try {
              await redis.refreshConsoleAccountConcurrencyLease(accountId, requestId, 600)
              logger.debug(
                `Refreshed concurrency lease for stream account ${account.name} (${accountId}), request: ${requestId}`,
              )
            } catch (refreshError) {
              logger.error(
                `Failed to refresh concurrency lease for account ${accountId}, request: ${requestId}:`,
                refreshError.message,
              )
            }
          },
          5 * 60 * 1000,
        ) // 5分钟刷新一次
      }

      logger.debug(`Account API URL: ${account.apiUrl}`)

      // 处理模型映射
      let mappedModel = requestBody.model
      if (
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
      ) {
        const newModel = claudeConsoleAccountService.getMappedModel(account.supportedModels, requestBody.model)
        if (newModel !== requestBody.model) {
          logger.info(`[Stream] Mapping model from ${requestBody.model} to ${newModel}`)
          mappedModel = newModel
        }
      }

      // 创建修改后的请求体
      const modifiedRequestBody = {
        ...requestBody,
        model: mappedModel,
      }
      sanitizeClaudeBodyFallbacks(modifiedRequestBody, { vendor: 'console' })

      // 模型兼容性检查已经在调度器中完成，这里不需要再检查

      // 创建代理agent（保留 proxyId/contextKey 供被动健康检查上报）
      proxyResolution = proxyResolver.resolveAgent(account, 'claude_console')
      const proxyAgent = proxyResolution.agent

      // 发送流式请求
      await this._makeClaudeConsoleStreamRequest(
        modifiedRequestBody,
        account,
        proxyAgent,
        clientHeaders,
        responseStream,
        accountId,
        usageCallback,
        streamTransformer,
        options,
        // 回调：在收到响应头时释放队列锁
        async () => {
          if (queueLockAcquired && queueRequestId && accountId) {
            try {
              await userMessageQueueService.releaseQueueLock(accountId, queueRequestId)
              queueLockAcquired = false // 标记已释放，防止 finally 重复释放
              logger.debug(
                `User message queue lock released early for console stream account ${accountId}, requestId: ${queueRequestId}`,
              )
            } catch (releaseError) {
              logger.error(
                `Failed to release user message queue lock early for console stream account ${accountId}:`,
                releaseError.message,
              )
            }
          }
        },
      )

      // 更新最后使用时间
      await this._updateLastUsedTime(accountId)

      // 被动健康检查：流式正常完成 = 代理传输成功
      proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, null)
    } catch (error) {
      // 客户端断开导致的主动 abort 不是代理/上游故障，先拦截再 report，否则会污染代理健康与错误日志
      if (error.message === 'Client disconnected') {
        logger.info(`Claude Console stream relay ended: Client disconnected (Account: ${account?.name || accountId})`)
        throw error
      }
      // 被动健康检查：上报连接级故障（客户端断开/上游响应由 classifyBusinessTraffic 区分，不误熔断）
      proxyResolver.report(proxyResolution?.proxyId, proxyResolution?.contextKey, error)
      // DEC_20260905_164536 禁止整包 Axios error（含 Authorization）进日志
      logger.error(
        `Claude Console stream relay failed (Account: ${account?.name || accountId}):`,
        summarizeErrorForLog(error),
      )
      throw error
    } finally {
      // 清理租约刷新定时器
      if (leaseRefreshInterval) {
        clearInterval(leaseRefreshInterval)
        logger.debug(
          `Cleared lease refresh interval for stream account ${account?.name || accountId}, request: ${requestId}`,
        )
      }

      // 并发控制:释放并发槽位
      if (concurrencyAcquired) {
        try {
          await redis.decrConsoleAccountConcurrency(accountId, requestId)
          logger.debug(
            `Released concurrency slot for stream account ${account?.name || accountId}, request: ${requestId}`,
          )
        } catch (releaseError) {
          logger.error(
            `Failed to release concurrency slot for stream account ${accountId}, request: ${requestId}:`,
            releaseError.message,
          )
        }
      }

      // 释放用户消息队列锁（兜底，正常情况下已在收到响应头后提前释放）
      if (queueLockAcquired && queueRequestId && accountId) {
        try {
          await userMessageQueueService.releaseQueueLock(accountId, queueRequestId)
          logger.debug(
            `User message queue lock released in finally for console stream account ${accountId}, requestId: ${queueRequestId}`,
          )
        } catch (releaseError) {
          logger.error(
            `Failed to release user message queue lock for stream account ${accountId}:`,
            releaseError.message,
          )
        }
      }
    }
  }

  // 发送流式请求到Claude Console API
  async _makeClaudeConsoleStreamRequest(
    body,
    account,
    proxyAgent,
    clientHeaders,
    responseStream,
    accountId,
    usageCallback,
    streamTransformer = null,
    requestOptions = {},
    onResponseHeaderReceived = null,
  ) {
    return new Promise((resolve, reject) => {
      let aborted = false
      let waitingForClientFinish = false
      let backpressure = null
      const onClientClose = () => {
        aborted = true
        if (waitingForClientFinish) {
          settleStreamErr(new Error('Client disconnected'))
        }
      }
      const cleanup = () => {
        backpressure?.dispose()
        responseStream.removeListener('close', onClientClose)
      }
      // settle 提到 Promise 顶层：data/end/error/axios catch/客户端断开共用
      // DEC_20260905_165725
      let streamSettled = false
      const settleStreamOk = () => {
        if (streamSettled) {
          return
        }
        streamSettled = true
        cleanup()
        resolve()
      }
      const settleStreamErr = (err) => {
        if (streamSettled) {
          return
        }
        streamSettled = true
        cleanup()
        reject(err)
      }

      // 构建完整的API URL
      const cleanUrl = account.apiUrl.replace(/\/$/, '') // 移除末尾斜杠
      const apiEndpoint = cleanUrl.endsWith('/v1/messages') ? cleanUrl : `${cleanUrl}/v1/messages`

      logger.debug(`Final API endpoint for stream: ${apiEndpoint}`)

      // 过滤客户端请求头
      const filteredHeaders = this._filterClientHeaders(clientHeaders)
      logger.debug(`[DEBUG] Filtered client headers: ${JSON.stringify(filteredHeaders)}`)

      // 决定使用的 User-Agent：优先使用账户自定义的，否则透传客户端的，最后才使用默认值
      const userAgent =
        account.userAgent || clientHeaders?.['user-agent'] || clientHeaders?.['User-Agent'] || this.defaultUserAgent

      // DEC_20260905_194420 Console 流式也注入 billing 并与出站 UA 对齐
      if (body && typeof body === 'object') {
        ensureAlignedBillingHeader(body, { userAgent })
        // DEC_20261001_114137 按映射后模型能力归一 thinking 与采样参数
        normalizeClaudeRequestForModel(body, body.model)
      }

      // 准备请求配置：先 spread 再强制 User-Agent
      const requestConfig = {
        method: 'POST',
        url: apiEndpoint,
        data: body,
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...filteredHeaders,
          'User-Agent': userAgent,
        },
        timeout: config.requestTimeout || 600000,
        responseType: 'stream',
        validateStatus: () => true, // 接受所有状态码
      }

      if (proxyAgent) {
        requestConfig.httpAgent = proxyAgent
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
      }

      // 根据 API Key 格式选择认证方式
      if (account.apiKey && account.apiKey.startsWith('sk-ant-')) {
        // Anthropic 官方 API Key 使用 x-api-key
        requestConfig.headers['x-api-key'] = account.apiKey
        logger.debug('[DEBUG] Using x-api-key authentication for sk-ant-* API key')
      } else {
        // 其他 API Key 使用 Authorization Bearer
        requestConfig.headers['Authorization'] = `Bearer ${account.apiKey}`
        logger.debug('[DEBUG] Using Authorization Bearer authentication')
      }

      // 添加beta header如果需要
      if (requestOptions.betaHeader) {
        requestConfig.headers['anthropic-beta'] = requestOptions.betaHeader
      }

      // 发送请求
      const request = axios(requestConfig)

      // 注意：使用 .then(async ...) 模式处理响应
      // - 内部的 releaseQueueLock 有独立的 try-catch，不会导致未捕获异常
      // - queueLockAcquired = false 的赋值会在 finally 执行前完成（JS 单线程保证）
      request
        .then(async (response) => {
          logger.debug(`Claude Console Claude stream response status: ${response.status}`)

          // DEC_20260905_194420 流式上游头挂到 responseStream.req
          const clientReq = responseStream?.req || null
          if (clientReq && typeof clientReq === 'object') {
            clientReq._crsUpstreamHeaders = response.headers || null
            clientReq._crsUpstreamRequestIdHeader =
              account?.upstreamRequestIdHeader || account?.extra?.upstreamRequestIdHeader || null
          }

          // 错误响应处理
          if (response.status !== 200) {
            clientReq?._crsRecordRelayResult?.({
              statusCode: response.status, hasUsage: false, final: true
            })
            logger.error(
              `Claude Console API returned error status: ${response.status} | Account: ${account?.name || accountId}`,
            )

            // 收集错误数据用于检测
            let errorDataForCheck = ''
            const errorDecoder = new StringDecoder('utf8')

            response.data.on('data', (chunk) => {
              errorDataForCheck += errorDecoder.write(chunk)
            })

            response.data.on('end', async () => {
              errorDataForCheck += errorDecoder.end()
              const autoProtectionDisabled = account.disableAutoProtection === true
              // 日志只打脱敏文案，禁止上游原文
              // DEC_20260905_161107
              const safeStreamMsg =
                extractSafeMessage(errorDataForCheck) || `Claude Console stream error: ${response.status}`
              logger.error(
                ` [Stream] Upstream error from ${account?.name || accountId}: status=${response.status} message=${safeStreamMsg}`,
              )

              // 检查是否为账户禁用错误
              const accountDisabledError = isAccountDisabledError(response.status, errorDataForCheck)

              // 错误响应上下文（流式：响应体取已收集的 errorDataForCheck）
              const errorContext = upstreamErrorHelper.buildErrorContext({
                url: requestConfig.url,
                method: requestConfig.method,
                requestHeaders: requestConfig.headers,
                requestBody: requestConfig.data,
                model: requestConfig.data?.model,
                responseStatus: response.status,
                responseHeaders: response.headers,
                responseBody: errorDataForCheck,
              })

              if (response.status === 401) {
                logger.warn(
                  ` [Stream] Unauthorized error detected for Claude Console account ${accountId}${autoProtectionDisabled ? ' (auto-protection disabled, skipping status change)' : ''}`,
                )

                await upstreamErrorHelper
                  .markTempUnavailable(accountId, 'claude-console', 401, null, errorContext)
                  .catch(() => {})
              } else if (accountDisabledError) {
                logger.error(
                  ` [Stream] Account disabled error (400) detected for Claude Console account ${accountId}${autoProtectionDisabled ? ' (auto-protection disabled, skipping status change)' : ''}`,
                )
                // webhook 只传脱敏 message，禁止上游原文
                // DEC_20260905_162636
                if (!autoProtectionDisabled) {
                  await claudeConsoleAccountService.markConsoleAccountBlocked(
                    accountId,
                    extractSafeMessage(errorDataForCheck) || 'account disabled',
                  )
                }
                // 禁止 raw errorDataForCheck 写入 message；脱敏正文已在 errorContext.errorBody
                upstreamErrorHelper
                  .recordErrorHistory(
                    accountId,
                    'claude-console',
                    400,
                    'auth_error',
                    errorContext
                      ? { ...errorContext, reason: 'account_disabled' }
                      : upstreamErrorHelper.buildErrorContext({
                          reason: 'account_disabled',
                          responseStatus: 400,
                          responseBody: errorDataForCheck,
                        }),
                  )
                  .catch((e) => console.error(e))
              } else if (response.status === 429) {
                logger.warn(
                  ` [Stream] Rate limit detected for Claude Console account ${accountId}${autoProtectionDisabled ? ' (auto-protection disabled, skipping status change)' : ''}`,
                )
                // 检查是否超过每日额度
                claudeConsoleAccountService.checkQuotaUsage(accountId).catch((err) => {
                  logger.error('Failed to check quota after 429 error:', err)
                })

                if (!autoProtectionDisabled) {
                  await claudeConsoleAccountService.markAccountRateLimited(accountId)
                }
                await upstreamErrorHelper
                  .markTempUnavailable(
                    accountId,
                    'claude-console',
                    429,
                    upstreamErrorHelper.parseRetryAfter(response.headers),
                    errorContext,
                  )
                  .catch(() => {})
              } else if (response.status === 529) {
                logger.warn(
                  ` [Stream] Overload error detected for Claude Console account ${accountId}${autoProtectionDisabled ? ' (auto-protection disabled, skipping status change)' : ''}`,
                )

                if (!autoProtectionDisabled) {
                  await claudeConsoleAccountService.markAccountOverloaded(accountId)
                }
                await upstreamErrorHelper
                  .markTempUnavailable(accountId, 'claude-console', 529, null, errorContext)
                  .catch(() => {})
              } else if (response.status >= 500) {
                logger.warn(
                  ` [Stream] Server error (${response.status}) detected for Claude Console account ${accountId}${autoProtectionDisabled ? ' (auto-protection disabled, skipping status change)' : ''}`,
                )

                await upstreamErrorHelper
                  .markTempUnavailable(accountId, 'claude-console', response.status, null, errorContext)
                  .catch(() => {})
              }

              // 设置响应头
              if (!responseStream.headersSent) {
                responseStream.writeHead(response.status, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                })
              }

              // 按客户端协议写错误：OpenAI 转换 vs Anthropic 信封
              // DEC_20260905_161107
              if (isStreamWritable(responseStream)) {
                if (streamTransformer) {
                  const clientError = buildClientError({
                    statusCode: response.status,
                    protocol: 'openai',
                    upstreamBody: errorDataForCheck,
                  })
                  responseStream.write(`data: ${JSON.stringify(clientError.body)}\n\n`)
                } else {
                  const anthropicBody = buildAnthropicClientErrorBody({
                    statusCode: response.status,
                    upstreamBody: errorDataForCheck,
                    fallbackMessage: `Claude Console error: ${response.status}`,
                  })
                  responseStream.write(`event: error\ndata: ${JSON.stringify(anthropicBody)}\n\n`)
                }
                responseStream.end()
              }
              resolve() // 不抛出异常，正常完成流处理
            })

            return
          }

          // 收到成功响应头（HTTP 200），调用回调释放队列锁
          // 此时请求已被 Claude API 接受并计入 RPM 配额，无需等待响应完成
          if (onResponseHeaderReceived && typeof onResponseHeaderReceived === 'function') {
            try {
              await onResponseHeaderReceived()
            } catch (callbackError) {
              logger.error(
                `Failed to execute onResponseHeaderReceived callback for console stream account ${accountId}:`,
                callbackError.message,
              )
            }
          }

          // 设置响应头
          // 关键修复：尊重 auth.js 提前设置的 Connection: close
          // 当并发队列功能启用时，auth.js 会设置 Connection: close 来禁用 Keep-Alive
          if (!responseStream.headersSent) {
            const existingConnection = responseStream.getHeader ? responseStream.getHeader('Connection') : null
            const connectionHeader = existingConnection || 'keep-alive'
            if (existingConnection) {
              logger.debug(`[Console Stream] Preserving existing Connection header: ${existingConnection}`)
            }
            responseStream.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: connectionHeader,
              'X-Accel-Buffering': 'no',
            })
          }

          const parser = new IncrementalSSEParser()
          const state = new ClaudeStreamState({
            model: body.model ?? account?.defaultModel ?? null
          })
          const finalizeUsage = createClaudeStreamFinalizer({
            state,
            usageCallback,
            clientRequest: clientReq,
            accountId,
            accountType: 'claude-console'
          })
          let finishing = false
          let errorForwarded = false
          backpressure = createStreamBackpressure(response.data, responseStream)

          const forwardFrames = (frames) => {
            let output = ''
            for (const frame of frames) {
              if (state.terminalType) {
                break
              }
              const event = parseSSEEvent(frame)
              if (event.type === 'data') {
                state.observe(event.data)
              }
              if (state.terminalType === 'error') {
                if (output && !aborted && isStreamWritable(responseStream)) {
                  const transformed = streamTransformer ? streamTransformer(output) : output
                  if (transformed) {
                    responseStream.write(transformed)
                  }
                }
                output = ''
                const result = state.result()
                this._writeStreamClientError(responseStream, {
                  statusCode: result.statusCode,
                  rawBody: { error: state.error },
                  streamTransformer
                })
                errorForwarded = true
              } else {
                output += frame
              }
            }
            if (output && !aborted && isStreamWritable(responseStream)) {
              const transformed = streamTransformer ? streamTransformer(output) : output
              if (transformed) {
                return responseStream.write(transformed)
              }
            }
            return !responseStream.writableNeedDrain
          }

          const finishStream = async (transportError = null) => {
            if (finishing) {
              return
            }
            finishing = true
            try {
              if (!transportError && !forwardFrames(parser.finishFrames())) {
                aborted ||= !(await backpressure.waitForDrain())
              }
              const result = await finalizeUsage(transportError)
              if (result.statusCode !== 200 && !errorForwarded) {
                this._writeStreamClientError(responseStream, {
                  statusCode: result.statusCode,
                  rawBody: { error: state.error },
                  streamTransformer
                })
                errorForwarded = true
              }
              if (result.statusCode === 200) {
                await Promise.all([
                  claudeConsoleAccountService
                    .isAccountRateLimited(accountId)
                    .then((limited) =>
                      limited ? claudeConsoleAccountService.removeAccountRateLimit(accountId) : null
                    ),
                  claudeConsoleAccountService
                    .isAccountOverloaded(accountId)
                    .then((overloaded) =>
                      overloaded
                        ? claudeConsoleAccountService.removeAccountOverload(accountId)
                        : null
                    )
                ]).catch((error) => {
                  logger.error('Failed to clear Console stream account errors:', error)
                })
              }
              if (transportError || aborted || !isStreamWritable(responseStream)) {
                if (isStreamWritable(responseStream)) {
                  responseStream.end()
                }
                settleStreamErr(transportError ?? new Error('Client disconnected'))
                return
              }
              if (responseStream.socket && !responseStream.socket.destroyed) {
                responseStream.socket.setNoDelay(true)
              }
              waitingForClientFinish = true
              responseStream.end(settleStreamOk)
            } catch (error) {
              logger.error('Error processing Console stream end:', summarizeErrorForLog(error))
              // 转换器或分帧失败仍须结算此前已报告的合法用量。
              error.code = 'STREAM_FATAL'
              await finalizeUsage(error)
              if (!errorForwarded) {
                this._writeStreamClientError(responseStream, {
                  statusCode: 502,
                  streamTransformer,
                  fallbackMessage: 'Stream processing error'
                })
              }
              if (isStreamWritable(responseStream)) {
                responseStream.end()
              }
              settleStreamErr(error)
            }
          }

          response.data.on('data', (chunk) => {
            if (finishing) {
              return
            }
            try {
              // DEC_20260905_195558 客户端断开仍继续读取累计用量再计费。
              if (!forwardFrames(parser.feedFrames(chunk))) {
                backpressure.waitForDrain().then((writable) => {
                  aborted ||= !writable
                })
              }
              if (state.terminalType) {
                void finishStream()
                response.data.destroy()
              }
            } catch (error) {
              logger.error('Error processing Console stream data:', summarizeErrorForLog(error))
              error.code = 'STREAM_FATAL'
              void finishStream(error)
              response.data.destroy()
            }
          })
          response.data.on('end', () => {
            void finishStream()
          })
          response.data.on('error', (error) => {
            void finishStream(error)
          })
          response.data.on('close', () => {
            if (!response.data.readableEnded) {
              void finishStream(new Error('Upstream stream closed before end'))
            }
          })
        })
        .catch((error) => {
          if (aborted) {
            // 客户端已断：仍必须 settle，否则 Promise 挂死泄漏并发/租约
            // DEC_20260905_165725
            settleStreamErr(new Error('Client disconnected'))
            return
          }

          logger.error(
            `Claude Console stream request error (Account: ${account?.name || accountId}):`,
            summarizeErrorForLog(error),
          )

          // 检查错误状态
          if (error.response) {
            const catchAutoProtectionDisabled =
              account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
            // 错误响应上下文（catch：响应体可能为流，仅在字符串时记录）
            const errorContext = upstreamErrorHelper.buildErrorContext({
              url: requestConfig.url,
              method: requestConfig.method,
              requestHeaders: requestConfig.headers,
              requestBody: requestConfig.data,
              model: requestConfig.data?.model,
              responseStatus: error.response.status,
              responseHeaders: error.response.headers,
              responseBody: typeof error.response.data === 'string' ? error.response.data : undefined,
            })
            if (error.response.status === 401) {
              upstreamErrorHelper
                .markTempUnavailable(accountId, 'claude-console', 401, null, errorContext)
                .catch(() => {})
            } else if (error.response.status === 429) {
              if (!catchAutoProtectionDisabled) {
                claudeConsoleAccountService.markAccountRateLimited(accountId)
              }
              // 检查是否超过每日额度
              claudeConsoleAccountService.checkQuotaUsage(accountId).catch((err) => {
                logger.error('Failed to check quota after 429 error:', err)
              })
              upstreamErrorHelper
                .markTempUnavailable(
                  accountId,
                  'claude-console',
                  429,
                  upstreamErrorHelper.parseRetryAfter(error.response.headers),
                  errorContext,
                )
                .catch(() => {})
            } else if (error.response.status === 529) {
              if (!catchAutoProtectionDisabled) {
                claudeConsoleAccountService.markAccountOverloaded(accountId)
              }
              upstreamErrorHelper
                .markTempUnavailable(accountId, 'claude-console', 529, null, errorContext)
                .catch(() => {})
            }
          }

          // 发送错误响应
          if (!responseStream.headersSent) {
            const existingConnection = responseStream.getHeader ? responseStream.getHeader('Connection') : null
            responseStream.writeHead(error.response?.status || 500, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: existingConnection || 'keep-alive',
            })
          }

          if (isStreamWritable(responseStream)) {
            // DEC_20260905_162636 协议化脱敏，禁止 error.message 原文
            this._writeStreamClientError(responseStream, {
              statusCode: error.response?.status || 500,
              rawBody: error.response?.data || null,
              streamTransformer,
              fallbackMessage: 'Upstream request failed',
            })
            responseStream.end()
          }

          settleStreamErr(error)
        })

      // 处理客户端断开连接
      responseStream.once('close', onClientClose)
    })
  }

  // 过滤客户端请求头
  _filterClientHeaders(clientHeaders) {
    // 使用统一的 headerFilter 工具类（白名单模式）
    // 与 claudeRelayService 保持一致，避免透传 CDN headers 触发上游 API 安全检查
    return filterForClaude(clientHeaders)
  }

  // 更新最后使用时间
  async _updateLastUsedTime(accountId) {
    try {
      const client = redis.getClientSafe()
      const accountKey = RedisKeys.accounts.claudeConsole(accountId)
      const exists = await client.exists(accountKey)

      if (!exists) {
        logger.debug(`跳过更新已删除的Claude Console账号最近使用时间: ${accountId}`)
        return
      }

      await client.hset(accountKey, 'lastUsedAt', new Date().toISOString())
    } catch (error) {
      logger.warn(`Failed to update last used time for Claude Console account ${accountId}:`, error.message)
    }
  }

  // 创建测试用的流转换器，将 Claude API SSE 格式转换为前端期望的格式
  _createTestStreamTransformer() {
    let testStartSent = false

    return (rawData) => {
      const lines = rawData.split('\n')
      const outputLines = []

      for (const line of lines) {
        if (!line.startsWith('data: ')) {
          // 保留空行用于 SSE 分隔
          if (line.trim() === '') {
            outputLines.push('')
          }
          continue
        }

        const jsonStr = line.substring(6).trim()
        if (!jsonStr || jsonStr === '[DONE]') {
          continue
        }

        try {
          const data = JSON.parse(jsonStr)

          // 发送 test_start 事件（只在第一次 message_start 时发送）
          if (data.type === 'message_start' && !testStartSent) {
            testStartSent = true
            outputLines.push(`data: ${JSON.stringify({ type: 'test_start' })}`)
            outputLines.push('')
          }

          // 转换 content_block_delta 为 content
          if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
            outputLines.push(`data: ${JSON.stringify({ type: 'content', text: data.delta.text })}`)
            outputLines.push('')
          }

          // 转换 message_stop 为 test_complete
          if (data.type === 'message_stop') {
            outputLines.push(`data: ${JSON.stringify({ type: 'test_complete', success: true })}`)
            outputLines.push('')
          }

          // 处理错误事件
          if (data.type === 'error') {
            const errorMsg = data.error?.message || data.message || '未知错误'
            outputLines.push(`data: ${JSON.stringify({ type: 'error', error: errorMsg })}`)
            outputLines.push('')
          }
        } catch {
          // 忽略解析错误
        }
      }

      return outputLines.length > 0 ? outputLines.join('\n') : null
    }
  }

  // 测试账号连接（供Admin API使用）
  async testAccountConnection(accountId, responseStream, model) {
    try {
      const account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      logger.info(`Testing Claude Console account connection: ${account.name} (${accountId})`)

      const cleanUrl = account.apiUrl.replace(/\/$/, '')
      const apiUrl = cleanUrl.endsWith('/v1/messages') ? cleanUrl : `${cleanUrl}/v1/messages?beta=true`
      const payload = createClaudeTestPayload(model, { stream: true })
      // 测试链路与正式转发一致：注入 billing + 对齐 UA
      const userAgent = account.userAgent || this.defaultUserAgent
      ensureAlignedBillingHeader(payload, { userAgent })

      const extraHeaders = { 'User-Agent': userAgent }
      const testProxyResolution = proxyResolver.resolveAgent(account, 'claude_console')
      const requestOptions = {
        apiUrl,
        responseStream,
        payload,
        proxyAgent: testProxyResolution.agent,
        extraHeaders,
      }

      if (account.apiKey && account.apiKey.startsWith('sk-ant-')) {
        requestOptions.extraHeaders['x-api-key'] = account.apiKey
      } else {
        requestOptions.authorization = `Bearer ${account.apiKey}`
      }

      await sendStreamTestRequest(requestOptions)
      // 被动健康检查：测试请求正常完成 = 代理传输成功
      proxyResolver.report(testProxyResolution.proxyId, testProxyResolution.contextKey, null)
    } catch (error) {
      logger.error(`Test account connection failed:`, error)
      if (!responseStream.headersSent) {
        responseStream.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        })
      }
      if (isStreamWritable(responseStream)) {
        responseStream.write(
          `data: ${JSON.stringify({ type: 'test_complete', success: false, error: error.message })}\n\n`,
        )
        responseStream.end()
      }
    }
  }

  // 健康检查
  async healthCheck() {
    try {
      const accounts = await claudeConsoleAccountService.getAllAccounts()
      const activeAccounts = accounts.filter((acc) => acc.isActive && acc.status === 'active')

      return {
        healthy: activeAccounts.length > 0,
        activeAccounts: activeAccounts.length,
        totalAccounts: accounts.length,
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      logger.error('Claude Console Claude health check failed:', error)
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      }
    }
  }
}

export const claudeConsoleRelayService = new ClaudeConsoleRelayService()
