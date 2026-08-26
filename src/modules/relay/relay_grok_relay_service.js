import axios from 'axios'
import { logger } from '../../common/logger.js'
import { config } from '../../../config/config.js'
import { redis } from '../../infra/redis.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { grokAccountService } from '../account/account_grok_service.js'
import { grokScheduler } from './relay_grok_scheduler.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { buildTokenUsagePayload } from './relay_request_detail_helper.js'
import { CodexToOpenAIConverter } from './relay_codex_to_openai.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import { buildClientError } from '../../common/client_error_builder.js'
import * as upstreamErrorHelper from './relay_upstream_error_helper.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import * as xaiHelper from '../../common/xai_helper.js'
import { applyFilteredResponseHeaders } from './relay_header_filter.js'
import { isNonProtocolUpstreamBody, handleNonProtocolUpstream } from './relay_upstream_protocol_guard.js'
import * as grokProtocol from './relay_grok_protocol.js'
/**
 * Grok / xAI 转发服务
 * OpenAI 兼容 chat/completions + responses；AbortController 清理；usage 捕获
 */

class GrokRelayService {
  constructor() {
    this.defaultTimeout = config.proxy?.timeout || 600000
  }

  async relayChatCompletions(req, res, apiKeyData, sessionHash = null) {
    return this._relay(req, res, apiKeyData, sessionHash, 'chat')
  }

  async relayResponses(req, res, apiKeyData, sessionHash = null) {
    // compact 子路径：OpenAI /responses/compact → Grok 总结轮
    const path = String(req.path || req.url || '')
    if (path.includes('/compact')) {
      return this._relay(req, res, apiKeyData, sessionHash, 'responses_compact')
    }
    return this._relay(req, res, apiKeyData, sessionHash, 'responses')
  }

  async relayMedia(req, res, apiKeyData, endpoint, sessionHash = null) {
    return this._relay(req, res, apiKeyData, sessionHash, endpoint)
  }

  async _relay(req, res, apiKeyData, sessionHash, endpointKind) {
    let abortController = null
    let detachClientDisconnect = () => {}
    let proxyResolution = null
    let account = null

    try {
      const requestedModel = req.body?.model || ''
      const mediaGeneration =
        endpointKind === 'images_generations' ||
        endpointKind === 'images_edits' ||
        endpointKind === 'videos_generations' ||
        endpointKind === 'videos_edits' ||
        endpointKind === 'videos_extensions'

      // 视频 status/content：优先绑定创建时的账户
      let forcedAccountId = null
      if (endpointKind === 'video_status' || endpointKind === 'video_content') {
        const requestId = req.params.requestId || req.params.request_id
        if (requestId && apiKeyData?.id) {
          const stickyKey = RedisKeys.session.unifiedGrokMapping(
            grokProtocol.videoSessionHash(requestId, apiKeyData.id),
          )
          try {
            forcedAccountId = await redis.getSessionAccountMapping?.(stickyKey)
          } catch (error) {
            console.error(error)
          }
        }
      }

      if (forcedAccountId) {
        account = await grokAccountService.getAccount(forcedAccountId, { decryptSecrets: true })
        if (!account) {
          forcedAccountId = null
        }
      }
      if (!account) {
        account = await grokScheduler.selectAccount(apiKeyData, requestedModel, sessionHash, {
          mediaGeneration,
        })
      }
      if (!account) {
        // selectAccount 正常应直接 throw；此处兜底并带可区分语义
        const error = new Error('No available Grok account')
        error.statusCode = apiKeyData?.grokAccountId ? 403 : 402
        error.code = apiKeyData?.grokAccountId ? 'grok_binding_unavailable' : 'grok_pool_exhausted'
        error.type = apiKeyData?.grokAccountId ? 'binding_error' : 'resource_exhausted'
        throw error
      }

      // 再取一次保证 token 新鲜
      account = (await grokAccountService.ensureFreshToken(account.id)) || account

      let token = account.authType === 'apikey' ? account.apiKey : account.accessToken
      if (!token) {
        throw new Error('Grok account has no usable credential')
      }

      abortController = new AbortController()
      detachClientDisconnect = onClientDisconnect(
        res,
        () => {
          // 流式：不断上游，drain 收 usage；非流式：abort
          if (req.body?.stream) {
            req._crsClientGone = true
            logger.info('Grok client disconnected during stream; draining upstream for usage')
            return
          }
          if (abortController && !abortController.signal.aborted) {
            abortController.abort()
          }
        },
        'Grok request',
      )

      let isStream =
        Boolean(req.body?.stream) &&
        !String(endpointKind).startsWith('images') &&
        !String(endpointKind).startsWith('videos') &&
        endpointKind !== 'responses_compact'

      // 媒体生成：OAuth Free fail-closed
      if (mediaGeneration) {
        const eligibility = await grokAccountService.ensureMediaEligible(account.id)
        if (!eligibility.eligible) {
          const clientError = buildClientError({
            statusCode: 503,
            protocol: 'openai',
            upstreamBody: {
              error: {
                message: `No eligible Grok media account (${eligibility.reason})`,
                type: 'grok_media_no_eligible_account',
                code: eligibility.reason,
              },
            },
          })
          return res.status(clientError.statusCode).json(clientError.body)
        }
        account = (await grokAccountService.ensureFreshToken(account.id)) || account
        token = account.authType === 'apikey' ? account.apiKey : account.accessToken
      }

      let targetUrl = this._buildTargetUrl(
        account,
        endpointKind === 'responses_compact' ? 'responses' : endpointKind,
        req,
      )
      let body = this._prepareBody(req.body, endpointKind)
      let effectiveEndpointKind = endpointKind
      let reverseBridgeToChat = false
      const originalChatModel = requestedModel

      // compact 改写
      if (endpointKind === 'responses_compact') {
        body = grokProtocol.buildGrokCompactRequestBody(body)
        isStream = false
        effectiveEndpointKind = 'responses'
        targetUrl = this._buildTargetUrl(account, 'responses', req)
        logger.info(`[GrokRelay] compact rewrite account=${account.id}`)
      }

      // chat → responses 桥（仅当资格满足；否则 raw chat）
      if (endpointKind === 'chat') {
        const bridge = grokProtocol.isChatBridgeEligible(body)
        const preferBridge =
          account.authType === 'oauth' ||
          account.preferResponsesBridge === true ||
          account.preferResponsesBridge === 'true'
        if (preferBridge && bridge.ok) {
          effectiveEndpointKind = 'responses'
          reverseBridgeToChat = true
          targetUrl = this._buildTargetUrl(account, 'responses', req)
          body = grokProtocol.maybeInjectFreeCacheTools(grokProtocol.chatToResponsesBody(body), account)
          logger.info(`[GrokRelay] chat→responses bridge account=${account.id} reason=${bridge.reason}`)
        } else if (!bridge.ok) {
          logger.debug(`[GrokRelay] chat raw forward account=${account.id} reason=${bridge.reason}`)
        }
      }

      const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': req.headers['content-type'] || 'application/json',
      }
      if (account.authType === 'oauth') {
        Object.assign(headers, xaiHelper.buildCliIdentityHeaders())
      }
      if (account.userAgent) {
        headers['User-Agent'] = account.userAgent
      } else if (req.headers['user-agent']) {
        headers['User-Agent'] = req.headers['user-agent']
      }

      const buildRequestOptions = (dataBody) => {
        const options = {
          method: 'POST',
          url: targetUrl,
          headers,
          data: dataBody,
          timeout: this.defaultTimeout,
          responseType: isStream ? 'stream' : 'json',
          validateStatus: () => true,
          signal: abortController.signal,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }
        if (endpointKind === 'video_status' || endpointKind === 'video_content') {
          options.method = 'GET'
          delete options.data
          if (endpointKind === 'video_content') {
            options.responseType = 'stream'
          }
        }
        return options
      }

      proxyResolution = proxyResolver.resolveAgent(account, 'grok')
      const applyProxy = (options) => {
        if (proxyResolution?.agent) {
          options.httpAgent = proxyResolution.agent
          options.httpsAgent = proxyResolution.agent
          options.proxy = false
        }
        return options
      }

      logger.info(
        `[GrokRelay] forward account=${account.id} url=${targetUrl} stream=${isStream} model=${body?.model || requestedModel || '-'} endpoint=${effectiveEndpointKind} reverseChat=${reverseBridgeToChat}`,
      )

      let response = await axios(applyProxy(buildRequestOptions(body)))
      proxyResolver.report?.(proxyResolution?.proxyId, proxyResolution?.contextKey, null)

      // encrypted_content 400：剥离后同号重试一次
      if (
        effectiveEndpointKind === 'responses' &&
        grokProtocol.isInvalidEncryptedContentError(response.status, response.data)
      ) {
        const stripped = grokProtocol.stripEncryptedReasoningContent(body)
        if (stripped.changed) {
          logger.warn(`[GrokRelay] invalid encrypted_content retry account=${account.id}`)
          ;({ body } = stripped)
          response = await axios(applyProxy(buildRequestOptions(body)))
        }
      }

      // failover：405/401/429/5xx 等换号重试一次
      if (response.status >= 400 && grokProtocol.shouldFailoverGrokStatus(response.status) && !forcedAccountId) {
        if (response.status === 429) {
          const retryAfter = upstreamErrorHelper.parseRetryAfter?.(response.headers) || 3600
          await grokAccountService.markAccountRateLimited(account.id, Math.ceil(retryAfter / 60) || 60)
          if (!(account.disableAutoProtection === true || account.disableAutoProtection === 'true')) {
            await upstreamErrorHelper
              .markTempUnavailable(account.id, 'grok', 429, retryAfter)
              .catch((e) => console.error(e))
          }
        } else if (response.status === 401 || response.status === 403) {
          await grokAccountService.markAccountUnauthorized(account.id, `Grok upstream ${response.status}`)
        } else if (response.status >= 500 || response.status === 405) {
          await upstreamErrorHelper
            .markTempUnavailable(account.id, 'grok', response.status)
            .catch((e) => console.error(e))
        }

        // 换号重试（排除当前号）
        try {
          const next = await grokScheduler.selectAccount(apiKeyData, requestedModel, sessionHash, {
            mediaGeneration,
          })
          if (next && next.id !== account.id) {
            logger.warn(`[GrokRelay] failover ${response.status} ${account.id} -> ${next.id}`)
            account = (await grokAccountService.ensureFreshToken(next.id)) || next
            token = account.authType === 'apikey' ? account.apiKey : account.accessToken
            headers.Authorization = `Bearer ${token}`
            if (account.authType === 'oauth') {
              Object.assign(headers, xaiHelper.buildCliIdentityHeaders())
            }
            targetUrl = this._buildTargetUrl(
              account,
              endpointKind === 'responses_compact'
                ? 'responses'
                : effectiveEndpointKind === 'responses'
                  ? 'responses'
                  : endpointKind,
              req,
            )
            proxyResolution = proxyResolver.resolveAgent(account, 'grok')
            response = await axios(applyProxy(buildRequestOptions(body)))
          }
        } catch (failoverError) {
          console.error(failoverError)
        }
      }

      if (response.status === 429) {
        const retryAfter = upstreamErrorHelper.parseRetryAfter?.(response.headers) || 3600
        await grokAccountService.markAccountRateLimited(account.id, Math.ceil(retryAfter / 60) || 60)
        if (!(account.disableAutoProtection === true || account.disableAutoProtection === 'true')) {
          await upstreamErrorHelper
            .markTempUnavailable(account.id, 'grok', 429, retryAfter)
            .catch((e) => console.error(e))
        }
        const clientError = buildClientError({
          statusCode: 429,
          protocol: 'openai',
          upstreamBody: response.data,
          retryAfterSeconds: retryAfter,
        })
        return res.status(clientError.statusCode).json(clientError.body)
      }

      if (response.status === 401 || response.status === 403) {
        await grokAccountService.markAccountUnauthorized(account.id, `Grok upstream ${response.status}`)
        const clientError = buildClientError({
          statusCode: response.status,
          protocol: 'openai',
          upstreamBody: response.data,
        })
        return res.status(clientError.statusCode).json(clientError.body)
      }

      if (response.status >= 400) {
        let errorData = response.data
        let bodyPreview = ''
        if (errorData && typeof errorData.pipe === 'function') {
          errorData = await this._readStreamText(errorData)
          bodyPreview = typeof errorData === 'string' ? errorData : ''
          try {
            errorData = JSON.parse(errorData)
          } catch {
            errorData = { error: { message: String(errorData).slice(0, 500) } }
          }
        } else if (typeof errorData === 'string') {
          bodyPreview = errorData
        }

        const autoOff = account.disableAutoProtection === true || account.disableAutoProtection === 'true'
        const previewText = bodyPreview || (typeof errorData === 'string' ? errorData : JSON.stringify(errorData || ''))

        // HTML/非协议体：断粘性 + temp_unavailable（防粘性连打坏上游）
        if (
          isNonProtocolUpstreamBody({
            statusCode: response.status,
            contentType: response.headers?.['content-type'],
            bodyText: previewText,
          })
        ) {
          await handleNonProtocolUpstream({
            accountId: account?.id,
            accountType: 'grok',
            sessionHash,
            statusCode: response.status,
            disableAutoProtection: autoOff,
            clearSticky: sessionHash
              ? async () => {
                  try {
                    await redis.deleteSessionAccountMapping?.(RedisKeys.session.unifiedGrokMapping(sessionHash))
                  } catch (error) {
                    console.error(error)
                  }
                }
              : null,
          })
        } else if (!autoOff && (response.status >= 500 || response.status === 405)) {
          await upstreamErrorHelper
            .markTempUnavailable(account.id, 'grok', response.status)
            .catch((e) => console.error(e))
        }

        const clientError = buildClientError({
          statusCode: response.status,
          protocol: 'openai',
          upstreamBody: errorData,
        })
        return res.status(clientError.statusCode).json(clientError.body)
      }

      grokAccountService.updateAccountUsage(account.id).catch((e) => console.error(e))

      // 视频生成成功：绑定 request_id → 账户，供 status/content 同号
      if (
        mediaGeneration &&
        (endpointKind === 'videos_generations' ||
          endpointKind === 'videos_edits' ||
          endpointKind === 'videos_extensions')
      ) {
        try {
          const requestId =
            response.data?.request_id ||
            response.data?.id ||
            response.data?.data?.request_id ||
            response.data?.data?.id ||
            response.data?.video?.request_id ||
            response.data?.video?.id
          if (requestId && apiKeyData?.id) {
            const stickyKey = RedisKeys.session.unifiedGrokMapping(
              grokProtocol.videoSessionHash(requestId, apiKeyData.id),
            )
            await redis.setSessionAccountMapping?.(stickyKey, account.id)
          }
        } catch (error) {
          console.error(error)
        }
      }

      if (isStream || (response.data && typeof response.data.pipe === 'function')) {
        return this._handleStreamResponse(
          response,
          res,
          account,
          apiKeyData,
          body?.model || originalChatModel || requestedModel,
          req,
          { reverseBridgeToChat, originalChatModel, endpointKind },
        )
      }

      return this._handleNormalResponse(
        response,
        res,
        account,
        apiKeyData,
        body?.model || originalChatModel || requestedModel,
        req,
        {
          reverseBridgeToChat,
          originalChatModel,
          isCompact: endpointKind === 'responses_compact',
          endpointKind,
        },
      )
    } catch (error) {
      console.error(error)
      // 传输层异常必须反馈代理池（熔断/权重）
      if (proxyResolution) {
        proxyResolver.report?.(proxyResolution.proxyId, proxyResolution.contextKey, error)
      }
      if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
        logger.info('[GrokRelay] client aborted')
        return
      }
      logger.error(`[GrokRelay] error: ${error.message}`)
      if (!res.headersSent) {
        // 本地调度/绑定错误：直接透传 statusCode/code/type
        // 禁止走 buildClientError——它会把 401/403 归一化成 502，抹掉 binding_error 语义
        if (error.statusCode && !error.response) {
          res.status(error.statusCode).json({
            error: {
              message: error.message,
              type: error.type || (error.statusCode >= 500 ? 'server_error' : 'api_error'),
              code: error.code || undefined,
            },
          })
        } else {
          // 上游/传输错误：走 buildClientError 归一化脱敏
          const clientError = buildClientError({
            statusCode: error.response?.status || 502,
            protocol: 'openai',
            upstreamBody: error.response?.data || { error: { message: error.message } },
          })
          res.status(clientError.statusCode).json(clientError.body)
        }
      }
    } finally {
      detachClientDisconnect()
    }
  }

  _buildTargetUrl(account, endpointKind, req) {
    const baseUrl = grokAccountService.getUpstreamBaseUrl(account, {
      media: String(endpointKind).startsWith('images') || String(endpointKind).startsWith('video'),
    })
    switch (endpointKind) {
      case 'chat':
        return xaiHelper.buildChatCompletionsUrl(baseUrl)
      case 'responses':
        return xaiHelper.buildResponsesUrl(baseUrl)
      case 'images_generations':
        return xaiHelper.buildImagesGenerationsUrl(baseUrl)
      case 'images_edits':
        return xaiHelper.buildImagesEditsUrl(baseUrl)
      case 'videos_generations':
        return xaiHelper.buildVideosGenerationsUrl(baseUrl)
      case 'videos_edits':
        return xaiHelper.buildVideosEditsUrl(baseUrl)
      case 'videos_extensions':
        return xaiHelper.buildVideosExtensionsUrl(baseUrl)
      case 'video_status': {
        const requestId = req.params.requestId || req.params.request_id
        return xaiHelper.buildVideoUrl(baseUrl, requestId)
      }
      case 'video_content': {
        const requestId = req.params.requestId || req.params.request_id
        return xaiHelper.buildVideoContentUrl(baseUrl, requestId)
      }
      default:
        return xaiHelper.buildChatCompletionsUrl(baseUrl)
    }
  }

  // 与转发补模、计费查价共用：未传 model 时媒体端点的默认模型名
  _defaultMediaModel(endpointKind) {
    if (endpointKind === 'images_generations') {
      return 'grok-imagine-image'
    }
    if (endpointKind === 'images_edits') {
      return 'grok-imagine-edit'
    }
    if (String(endpointKind || '').startsWith('videos')) {
      return 'grok-imagine-video-1.5'
    }
    return ''
  }

  // 计费模型：上游回包 model > 请求/补全后的 model > 媒体默认；禁止空串落到 unknown
  _resolveBillingModel(responseModel, requestedModel, endpointKind) {
    const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')
    return pick(responseModel) || pick(requestedModel) || this._defaultMediaModel(endpointKind) || 'unknown'
  }

  _prepareBody(body, endpointKind) {
    // 无 body 时也要产出对象，否则媒体默认 model 补不进去、计费拿到空串
    const next = body && typeof body === 'object' ? { ...body } : {}
    if (next.model) {
      next.model = xaiHelper.mapModel(next.model)
    }
    // 媒体默认模型（转发与计费同一来源）
    if (!next.model) {
      const fallback = this._defaultMediaModel(endpointKind)
      if (fallback) {
        next.model = fallback
      }
    }
    return next
  }

  // 统计请求体中的输入图片张数（image / images / image_url 等）
  _countInputImages(body) {
    if (!body || typeof body !== 'object') {
      return 0
    }
    let count = 0
    const bump = (value) => {
      if (value === null || value === '') {
        return
      }
      if (Array.isArray(value)) {
        count += value.filter((item) => item !== null && item !== '').length
        return
      }
      count += 1
    }
    bump(body.image)
    bump(body.images)
    bump(body.image_url)
    bump(body.image_urls)
    // OpenAI edits 风格
    if (body.image_file) {
      bump(body.image_file)
    }
    // reference images
    bump(body.reference_images)
    bump(body.ref_images)
    return count
  }

  // 从媒体响应/请求推断非 token 计费量（张数、视频秒、分辨率/质量、输入媒体）
  _buildMediaBillingUsage(data, req, endpointKind) {
    const kind = String(endpointKind || '')
    const body = req?.body || {}
    const usage = {}

    // 分辨率/质量：供 Grok 分档选价（pricingService.resolveGrokMediaUnitPrices）
    if (body.size !== null) {
      usage.size = body.size
    }
    if (body.resolution !== null) {
      usage.resolution = body.resolution
    }
    if (body.quality !== null) {
      usage.quality = body.quality
    }
    if (body.image_size !== null) {
      usage.image_size = body.image_size
    }
    if (body.video_resolution !== null) {
      usage.video_resolution = body.video_resolution
    }
    // 响应回显优先
    if (data?.size) {
      usage.size = data.size
    }
    if (data?.quality) {
      usage.quality = data.quality
    }
    if (data?.resolution) {
      usage.resolution = data.resolution
    }
    if (data?.video?.resolution) {
      usage.video_resolution = data.video.resolution
    }

    if (kind.startsWith('images')) {
      let count = 0
      if (Array.isArray(data?.data)) {
        count = data.data.length
      } else if (Array.isArray(data?.images)) {
        count = data.images.length
      }
      if (!count) {
        const n = Number(body.n)
        count = Number.isFinite(n) && n > 0 ? n : 1
      }
      usage.image_count = count
      usage.image_size = usage.image_size || usage.size
      usage.image_quality = usage.quality
      // 编辑/参考图：输入图张数
      const inputImages = this._countInputImages(body)
      if (inputImages > 0) {
        usage.input_image_count = inputImages
      }
    }

    if (kind.startsWith('videos')) {
      // 输出时长：优先响应，其次请求
      const outCandidates = [
        data?.seconds,
        data?.duration,
        data?.video?.seconds,
        data?.video?.duration,
        data?.data?.seconds,
        data?.data?.duration,
        body.seconds,
        body.duration,
      ]
      for (const value of outCandidates) {
        const parsed = Number(value)
        if (Number.isFinite(parsed) && parsed > 0) {
          usage.video_output_seconds = parsed
          break
        }
      }
      if (usage.video_output_seconds === null) {
        usage.request_count = 1
      }
      usage.video_resolution = usage.video_resolution || usage.resolution || usage.size
      usage.video_size = usage.size

      // 输入图（图生视频）
      const inputImages = this._countInputImages(body)
      if (inputImages > 0) {
        usage.input_image_count = inputImages
      }

      // 输入视频秒（编辑/延长）：body 或响应
      const inCandidates = [
        body.input_seconds,
        body.source_seconds,
        body.video_input_seconds,
        body.input_video_seconds,
        data?.input_seconds,
        data?.source?.seconds,
        data?.video?.input_seconds,
      ]
      // 若 body 带输入视频 URL/文件但无时长，无法臆造秒数；有明确字段才计
      for (const value of inCandidates) {
        const parsed = Number(value)
        if (Number.isFinite(parsed) && parsed > 0) {
          usage.video_input_seconds = parsed
          break
        }
      }
    }

    return Object.keys(usage).length ? usage : null
  }

  async _handleNormalResponse(response, res, account, apiKeyData, requestedModel, req, options = {}) {
    let { data } = response
    // compact 响应改写
    if (options.isCompact) {
      data = grokProtocol.convertGrokResponseToOpenAICompact(data)
    }
    // Responses → Chat 回桥
    if (options.reverseBridgeToChat) {
      try {
        const converter = new CodexToOpenAIConverter()
        data = converter.convertResponse(data, options.originalChatModel || requestedModel)
      } catch (error) {
        console.error(error)
        logger.warn(`[GrokRelay] reverse bridge failed: ${error.message}`)
      }
    }

    const usage = data?.usage || response.data?.usage || null
    const mediaBilling = this._buildMediaBillingUsage(data, req, options.endpointKind)
    // 媒体：即使上游不回 usage，也要按张数/秒落账
    if (apiKeyData?.id && (usage || mediaBilling)) {
      // Grok/xAI 官方：chat 用 completion_tokens_details.reasoning_tokens，
      // responses 用 output_tokens_details.reasoning_tokens，均为 output 子集，不可再加一遍
      const usagePayload = buildTokenUsagePayload({
        inputTokens: usage?.prompt_tokens || usage?.input_tokens || 0,
        outputTokens: usage?.completion_tokens || usage?.output_tokens || 0,
        cacheCreateTokens: usage?.cache_creation_input_tokens || 0,
        cacheReadTokens: usage?.cache_read_input_tokens || usage?.prompt_tokens_details?.cached_tokens || 0,
        rawUsage: usage || {},
        extras: mediaBilling || null,
      })
      const billModel = this._resolveBillingModel(data?.model, requestedModel, options.endpointKind)
      await apiKeyService
        .recordUsage(apiKeyData.id, usagePayload, billModel, account.id, 'grok')
        .catch((e) => console.error(e))
    }

    if (response.headers['content-type']) {
      res.setHeader('Content-Type', 'application/json')
    }
    return res.status(response.status).json(data)
  }

  async _handleStreamResponse(response, res, account, apiKeyData, requestedModel, req, options = {}) {
    res.status(response.status)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    applyFilteredResponseHeaders(res, response.headers)

    let usageData = null
    let actualModel = requestedModel
    let buffer = ''
    let clientGone = Boolean(req?._crsClientGone)
    const reverseBridge = Boolean(options.reverseBridgeToChat)
    const converter = reverseBridge ? new CodexToOpenAIConverter() : null
    const streamState = reverseBridge ? converter.createStreamState() : null

    response.data.on('data', (chunk) => {
      if (req?._crsClientGone) {
        clientGone = true
      }
      const text = chunk.toString()
      const filtered = grokProtocol.stripSsePingFrames(text)
      if (!filtered) {
        return
      }

      if (!clientGone && !reverseBridge) {
        res.write(Buffer.from(filtered))
      }

      buffer += filtered
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) {
          continue
        }
        const payload = line.slice(6).trim()
        if (!payload || payload === '[DONE]') {
          if (!clientGone && reverseBridge && payload === '[DONE]') {
            res.write('data: [DONE]\n\n')
          }
          continue
        }
        try {
          const parsed = JSON.parse(payload)
          if (parsed.model) {
            actualModel = parsed.model
          }
          if (parsed.usage) {
            usageData = parsed.usage
          }
          if (parsed.response?.usage) {
            usageData = parsed.response.usage
          }
          if (parsed.type === 'response.completed' && parsed.response?.usage) {
            usageData = parsed.response.usage
          }
          if (!clientGone && reverseBridge) {
            const chunks = converter.convertStreamChunk(
              parsed,
              options.originalChatModel || requestedModel,
              streamState,
            )
            for (const out of chunks) {
              res.write(out)
            }
          }
        } catch {
          // ignore partial JSON
        }
      }
    })

    // 只等上游结束（勿绑 res.close，否则客户端断开会提前停读、漏 usage）
    await new Promise((resolve) => {
      response.data.on('end', resolve)
      response.data.on('error', (error) => {
        console.error(error)
        resolve()
      })
    })

    if (!clientGone && !res.writableEnded) {
      if (reverseBridge) {
        res.write('data: [DONE]\n\n')
      }
      res.end()
    }

    const mediaBilling = this._buildMediaBillingUsage(null, req, options.endpointKind)
    if (apiKeyData?.id && (usageData || mediaBilling)) {
      const usagePayload = buildTokenUsagePayload({
        inputTokens: usageData?.prompt_tokens || usageData?.input_tokens || 0,
        outputTokens: usageData?.completion_tokens || usageData?.output_tokens || 0,
        cacheCreateTokens: usageData?.cache_creation_input_tokens || 0,
        cacheReadTokens: usageData?.cache_read_input_tokens || usageData?.prompt_tokens_details?.cached_tokens || 0,
        rawUsage: usageData || {},
        extras: mediaBilling || null,
      })
      const billModel = this._resolveBillingModel(actualModel, requestedModel, options.endpointKind)
      await apiKeyService
        .recordUsage(apiKeyData.id, usagePayload, billModel, account.id, 'grok')
        .catch((e) => console.error(e))
    } else if (!usageData && !mediaBilling) {
      logger.warn(
        `[Grok] stream ended without usageData accountId=${account?.id} model=${actualModel || requestedModel || 'unknown'} clientGone=${clientGone}`,
      )
    }
  }

  async _readStreamText(stream) {
    const chunks = []
    await new Promise((resolve) => {
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', resolve)
      stream.on('error', resolve)
      setTimeout(resolve, 5000)
    })
    return Buffer.concat(chunks).toString()
  }
}

export const grokRelayService = new GrokRelayService()
