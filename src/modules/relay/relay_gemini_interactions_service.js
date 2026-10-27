import axios from 'axios'
import { createHash } from 'node:crypto'
import { config } from '../../../config/config.js'
import { logger } from '../../common/logger.js'
import { buildClientError } from '../../common/client_error_builder.js'
import { timedUpstreamRequest, trackRequestTiming } from '../../common/request_timing.js'
import { createStreamBackpressure } from '../../common/stream_helper.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import { redis } from '../../infra/redis.js'
import { RedisKeys, TTL } from '../../infra/redis_key.js'
import { geminiApiAccountService } from '../account/account_gemini_api_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { unifiedGeminiScheduler } from './relay_unified_gemini_scheduler.js'
import { assertModelAccess, assertOutboundModelAccess } from './relay_model_access.js'
import { IncrementalSSEParser } from './relay_sse_parser.js'
import { buildGeminiTokenUsagePayload, createRequestDetailMeta } from './relay_request_detail_helper.js'
import {
  interactionError,
  assertStatelessInteraction,
  interactionToGenerateContent,
  generateContentToInteraction,
  createInteractionStreamState,
  generateContentToInteractionEvents,
  finishInteractionStream
} from './relay_interactions_protocol.js'
import { projectUpstreamUsage } from '../pricing/pricing_billing_audit.js'
import * as upstreamErrorHelper from './relay_upstream_error_helper.js'

const terminal = (status) => ['completed', 'requires_action', 'incomplete', 'failed', 'cancelled'].includes(status)
const hasTokenUsage = (usage) =>
  ['total_input_tokens', 'total_output_tokens'].every(
    (field) => Number.isSafeInteger(usage?.[field]) && usage[field] >= 0
  )
const hasFinalUsage = (record) => record.usageFinal === true && hasTokenUsage(record.usage)
const needsRateLimit = (record) => record.trackRateLimit === true && record.billed && !record.rateLimitRecorded
const needsProcessing = (record) =>
  (!record.billed && (record.stored || hasFinalUsage(record))) || needsRateLimit(record)
const writeEvents = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
const noteInteractionResult = (req, interaction, errorCode = null) => {
  if (req.method !== 'POST' || req.params.id || !terminal(interaction.status)) {
    return
  }
  req._crsRecordRelayResult?.({
    statusCode: interaction.status === 'failed' ? 502 : 200,
    errorCode:
      errorCode ??
      (interaction.status === 'incomplete'
        ? 'response_incomplete'
        : interaction.status === 'failed'
          ? 'interaction_failed'
          : null),
    hasUsage: hasTokenUsage(interaction.usage),
    final: true
  })
}

export const buildInteractionUrl = (baseUrl, version, id = null, cancel = false) => {
  const url = new URL(baseUrl)
  if (baseUrl.includes('{')) {
    throw interactionError('Interactions requires an API base URL, not a model/action template')
  }
  const prefix = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:v1beta|v1)(?:\/models)?$/, '')
    .replace(/\/models$/, '')
  url.pathname = `${prefix}/${version}/interactions${id ? `/${encodeURIComponent(id)}` : ''}${cancel ? '/cancel' : ''}`
  url.searchParams.delete('key')
  return url.toString()
}

export class GeminiInteractionsService {
  constructor() {
    this.timer = null
    this.polling = false
  }

  async _request(
    accountId,
    version,
    { method = 'GET', id = null, cancel = false, body, query, stream = false, req, timeout = config.proxy.timeout } = {}
  ) {
    const account = await geminiApiAccountService.getAccount(accountId)
    if (!account) {
      throw interactionError('The interaction account is unavailable', 'account_unavailable', 503)
    }
    const proxy = proxyResolver.resolveAgent(account, 'gemini-api')
    const start = Date.now()
    try {
      const operation = () =>
        axios({
          method,
          url: buildInteractionUrl(account.baseUrl, version, id, cancel),
          params: query,
          data: body,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': account.apiKey },
          timeout,
          httpAgent: proxy.agent,
          httpsAgent: proxy.agent,
          proxy: false,
          responseType: stream ? 'stream' : 'json'
        })
      const response = req ? await timedUpstreamRequest(req, operation) : await operation()
      if (req) {
        req._crsUpstreamHeaders = response.headers
      }
      proxyResolver.report(proxy.proxyId, proxy.contextKey, null, Date.now() - start)
      return response
    } catch (error) {
      proxyResolver.report(proxy.proxyId, proxy.contextKey, error, Date.now() - start)
      if (typeof error.response?.data?.pipe === 'function') {
        const chunks = []
        let bytes = 0
        for await (const chunk of error.response.data) {
          bytes += chunk.length
          if (bytes > 65536) {
            error.response.data.destroy()
            break
          }
          chunks.push(Buffer.from(chunk))
        }
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          error.response.data = JSON.parse(text)
        } catch {
          error.response.data = text
        }
      }
      const status = error.response?.status
      if (status >= 500 || [401, 403, 429].includes(status)) {
        await upstreamErrorHelper
          .markTempUnavailable(
            accountId,
            'gemini-api',
            status,
            status === 429 ? upstreamErrorHelper.parseRetryAfter(error.response.headers) : null,
            upstreamErrorHelper.buildErrorContext({
              url: error.config?.url,
              method,
              responseStatus: status,
              responseBody: error.response.data
            })
          )
          .catch((markError) =>
            logger.warn('Interactions upstream error history failed', { accountId, error: markError })
          )
      }
      throw error
    }
  }

  async _owned(req, id) {
    if (!id || id.length > 2048) {
      throw interactionError('Interaction not found', 'not_found', 404)
    }
    const record = await redis.getGeminiInteraction(req.apiKey.id, id)
    if (!record || !record.stored) {
      throw interactionError('Interaction not found', 'not_found', 404)
    }
    assertModelAccess(req.apiKey, record.model)
    return record
  }

  async _observe(record, response) {
    if (!response?.id || typeof response.id !== 'string') {
      throw interactionError('Upstream interaction ID is missing', 'invalid_upstream_response', 502)
    }
    if (response.id !== record.id) {
      throw interactionError('Upstream interaction ID changed', 'invalid_upstream_response', 502)
    }
    const key = await redis.createGeminiInteraction(record)
    const owner = await redis.lockGeminiInteraction(key)
    if (!owner) {
      await redis.scheduleGeminiInteraction(key, true)
      return false
    }
    try {
      const saved = await redis.getGeminiInteraction(record.ownerId, record.id)
      saved.status = response.status ?? saved.status
      saved.model = response.model ?? saved.model
      if (response.usage !== undefined && response.usage !== null) {
        if (terminal(saved.status) && saved.usageFinal === false && saved.usage) {
          saved.checkpointUsage = saved.usage
        }
        saved.usage = projectUpstreamUsage(response.usage)
        saved.usageFinal = terminal(saved.status)
      }
      const images =
        response.steps?.reduce(
          (count, step) =>
            count +
            (step.type === 'model_output' ? (step.content?.filter((part) => part.type === 'image').length ?? 0) : 0),
          0
        ) ?? 0
      saved.imageCount = Math.max(saved.imageCount ?? 0, record.imageCount ?? 0, images)
      await redis.saveGeminiInteraction(key, saved)
      await redis.scheduleGeminiInteraction(key, needsProcessing(saved))
      if (terminal(saved.status) && hasFinalUsage(saved) && !saved.billed) {
        const { usage } = saved
        const tokenUsage = buildGeminiTokenUsagePayload({
          promptTokenCount: usage.total_input_tokens,
          cachedContentTokenCount: usage.total_cached_tokens,
          candidatesTokenCount: usage.total_output_tokens,
          thoughtsTokenCount: usage.total_thought_tokens,
          totalTokenCount: usage.total_tokens
        })
        tokenUsage._upstreamUsage = projectUpstreamUsage(usage)
        try {
          const cost = await apiKeyService.recordUsage(
            saved.ownerId,
            tokenUsage,
            saved.model,
            saved.accountId,
            'gemini-api',
            null,
            {
              ...saved.meta,
              upstreamUsage: usage,
              protocolTerminal: saved.status,
              billingUsage: saved.imageCount ? { image_count: saved.imageCount } : undefined,
              billingDedupId: `gemini-interaction:${key}`,
              billingDedupTtl: TTL.geminiInteraction,
              throwOnBillingFailure: true,
              statusCode: saved.status === 'failed' ? 502 : 200
            }
          )
          saved.billed = true
          saved.ratedCost = cost.ratedCost
          saved.rateLimitTokens =
            tokenUsage.input_tokens +
            tokenUsage.output_tokens +
            tokenUsage.cache_creation_input_tokens +
            tokenUsage.cache_read_input_tokens +
            tokenUsage.reasoning_tokens
        } catch (error) {
          logger.error('Interactions settlement deferred with usage persisted', {
            interactionId: saved.id,
            requestId: saved.meta.requestId,
            error
          })
        }
      }
      saved.settlementUnknown =
        !saved.billed &&
        (terminal(saved.status) || record.settlementUnknown === true || saved.settlementUnknown === true)
      await redis.saveGeminiInteraction(key, saved)
      if (needsRateLimit(saved)) {
        try {
          // DEC_20261026_234532 最终用量计入结算时仍有效的限流窗口，过期窗口不复活。
          await redis.recordGeminiInteractionRateLimit(key, saved.ownerId, saved.rateLimitTokens, saved.ratedCost)
          saved.rateLimitRecorded = true
        } catch (error) {
          logger.error('Interactions rate limit accounting deferred', { interactionId: saved.id, error })
        }
      }
      await redis.scheduleGeminiInteraction(key, needsProcessing(saved))
      return true
    } finally {
      await redis.unlockGeminiInteraction(key, owner)
    }
  }

  _record(req, accountId, version, interaction) {
    const meta = createRequestDetailMeta(req, { stream: req.body?.stream === true })
    delete meta.requestBody
    delete meta.responseBody
    return {
      ownerId: req.apiKey.id,
      id: interaction.id,
      accountId,
      version,
      model: interaction.model ?? req.body?.model ?? req.body?.agent,
      status: interaction.status ?? 'in_progress',
      stored: req.body?.store !== false,
      billed: false,
      trackRateLimit: Boolean(req.rateLimitInfo),
      meta
    }
  }

  async create(req, res, compatibility) {
    let detach = () => {}
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw interactionError('The request body must be a JSON object', 'invalid_argument')
      }
      if (!req.body.model && !req.body.agent && !req.body.previous_interaction_id) {
        throw interactionError('model or agent is required', 'invalid_argument')
      }
      // DEC_20261026_194257 原生后台任务仅允许后付费 Key，预付费保留同步及流式请求。
      if (req.body.background === true && req.apiKey.billingMode === 'prepaid') {
        throw interactionError(
          'Background interactions require a postpaid API key',
          'background_requires_postpaid',
          403
        )
      }
      const version = req.path.includes('/v1beta/') ? 'v1beta' : 'v1'
      const previous = req.body.previous_interaction_id
      const parent = previous ? await this._owned(req, previous) : null
      const model = req.body.model ?? parent?.model ?? req.body.agent ?? null
      assertModelAccess(req.apiKey, model)
      const selection = await trackRequestTiming(req, 'scheduling', () =>
        unifiedGeminiScheduler.selectAccountForApiKey(req.apiKey, null, model, {
          allowApiAccounts: true,
          preferApiAccounts: true,
          pinnedAccountId: parent?.accountId ?? null
        })
      )
      req._crsAccountId = selection.accountId
      req._crsAccountType = selection.accountType
      await assertOutboundModelAccess(req.apiKey, model, selection.accountType)
      if (selection.accountType !== 'gemini-api') {
        assertStatelessInteraction(req.body)
        return await this._compatibility(req, res, selection, compatibility)
      }
      req._crsUsageDetailHandled = true
      detach = onClientDisconnect(
        res,
        () => {
          req._crsDrainForUsage = true
        },
        'Gemini Interactions'
      )
      const response = await this._request(selection.accountId, version, {
        method: 'POST',
        body: req.body,
        stream: req.body.stream === true,
        req
      })
      if (req.body.stream === true) {
        return await this._stream(req, res, response, selection.accountId, version)
      }
      const record = this._record(req, selection.accountId, version, response.data)
      await this._observe(record, response.data)
      noteInteractionResult(req, response.data)
      if (!res.destroyed) {
        res.status(response.status).json(response.data)
      }
    } catch (error) {
      await this._error(req, res, error)
    } finally {
      detach()
      if (req._crsAccountType === 'gemini-api' || res.writableEnded) {
        req._crsDrainForUsage = false
        req.releaseGroupCostHold?.()
      }
    }
  }

  async resource(req, res, action) {
    try {
      req._crsUsageDetailHandled = true
      const record = await this._owned(req, req.params.id)
      const query = action === 'get' ? { stream: req.query.stream, last_event_id: req.query.last_event_id } : undefined
      if (action === 'delete') {
        const current = await this._request(record.accountId, record.version, { id: record.id, req })
        if (!(await this._observe(record, current.data))) {
          throw interactionError('Interaction settlement is busy; retry deletion', 'interaction_busy', 503)
        }
        if (!terminal(current.data.status)) {
          const cancelled = await this._request(record.accountId, record.version, {
            method: 'POST',
            id: record.id,
            cancel: true,
            req
          })
          if (!(await this._observe(record, cancelled.data))) {
            throw interactionError('Interaction settlement is busy; retry deletion', 'interaction_busy', 503)
          }
        }
        // DEC_20261026_194257 取消后用量仍缺失时保留未结算标记并允许删除，缺失不作零费用。
      }
      const stream = action === 'get' && req.query.stream === 'true'
      const response = await this._request(record.accountId, record.version, {
        method: action === 'cancel' ? 'POST' : action === 'delete' ? 'DELETE' : 'GET',
        id: record.id,
        cancel: action === 'cancel',
        query,
        stream,
        req
      })
      if (action === 'delete') {
        const key = RedisKeys.geminiInteraction.record(record.ownerId, record.id)
        record.stored = false
        const saved = await redis.getGeminiInteraction(record.ownerId, record.id)
        await redis.saveGeminiInteraction(key, {
          ...saved,
          stored: false
        })
        await redis.scheduleGeminiInteraction(key, needsProcessing({ ...saved, stored: false }))
        return res.status(response.status).end()
      }
      if (stream) {
        return await this._stream(req, res, response, record.accountId, record.version, record)
      }
      await this._observe(record, response.data)
      return res.status(response.status).json(response.data)
    } catch (error) {
      await this._error(req, res, error)
    }
  }

  async _stream(req, res, response, accountId, version, existing = null) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')
    const parser = new IncrementalSSEParser()
    const backpressure = createStreamBackpressure(response.data, res)
    let record = existing
    let ended = false
    let streamFailure = null
    const imageEvents = new Set()
    const stepTypes = new Map()
    const consume = async (events) => {
      for (const parsed of events) {
        if (parsed.type === 'invalid') {
          throw interactionError('Invalid upstream Interactions event', 'invalid_upstream_response', 502)
        }
        if (parsed.type !== 'data') {
          continue
        }
        const event = parsed.data
        if (event.event_type === 'step.start') {
          stepTypes.set(event.index, event.step?.type)
        }
        const imageParts =
          event.step?.type === 'model_output'
            ? (event.step.content?.filter((part) => part.type === 'image') ?? [])
            : event.delta?.type === 'image' && stepTypes.get(event.index) !== 'user_input'
              ? [event.delta]
              : []
        for (const part of imageParts) {
          if (!part.data && !part.uri) {
            continue
          }
          imageEvents.add(
            createHash('sha256')
              .update(`${event.index}:${part.data ?? part.uri}`)
              .digest('hex')
          )
        }
        const snapshot =
          event.interaction ??
          (event.event_type === 'interaction.status_update' ? { id: event.interaction_id, status: event.status } : null)
        const usage =
          snapshot?.usage ??
          event.usage ??
          event.metadata?.total_usage ??
          (event.event_type === 'interaction.completed' && snapshot?.status !== 'cancelled' ? record?.usage : undefined)
        if (record) {
          record.imageCount = Math.max(record.imageCount ?? 0, imageEvents.size)
        }
        if (snapshot?.id || (record && usage)) {
          const interaction = { ...(snapshot ?? { id: record.id }), ...(usage ? { usage } : {}) }
          record ??= this._record(req, accountId, version, interaction)
          record.imageCount = Math.max(record.imageCount ?? 0, imageEvents.size)
          if (usage) {
            record.usage = projectUpstreamUsage(usage)
          }
          await this._observe(record, interaction)
          noteInteractionResult(req, { ...interaction, usage: record.usage })
        }
        if (event.event_type === 'interaction.completed' || event.event_type === 'error') {
          ended = true
        }
        if (event.event_type === 'error') {
          streamFailure = 'upstream_stream_error'
        }
      }
    }
    try {
      for await (const chunk of response.data) {
        await consume(parser.feed(chunk))
        if (!res.destroyed && !res.write(chunk)) {
          await backpressure.waitForDrain()
        }
      }
      await consume(parser.finish())
      if (!ended) {
        streamFailure = 'upstream_stream_incomplete'
        if (!res.destroyed) {
          res.write(
            writeEvents([
              {
                event_type: 'error',
                error: {
                  code: 'upstream_stream_incomplete',
                  message: 'Upstream stream ended before its terminal event'
                }
              }
            ])
          )
        }
      }
    } catch (error) {
      streamFailure = 'upstream_stream_error'
      if (!res.destroyed && !ended) {
        res.write(
          writeEvents([
            {
              event_type: 'error',
              error: { code: 'upstream_stream_error', message: 'Upstream stream failed before completion' }
            }
          ])
        )
      }
      logger.error('Native Interactions stream failed', {
        requestId: req.requestId,
        code: error.code,
        stack: error.stack
      })
    } finally {
      backpressure.dispose()
      if (streamFailure) {
        noteInteractionResult(req, { status: 'failed', usage: record?.usage }, streamFailure)
      }
      if (record && streamFailure) {
        await this._observe({ ...record, settlementUnknown: true }, { id: record.id }).catch((error) =>
          logger.error('Interrupted Interactions settlement state could not be persisted', {
            interactionId: record.id,
            error
          })
        )
      }
      if (!res.destroyed) {
        res.end()
      }
    }
  }

  async _compatibility(req, res, selection, { generate, stream }) {
    const originalBody = req.body
    const converted = interactionToGenerateContent(originalBody)
    req._crsGeminiSelection = selection
    req.body = converted.request
    req.params = { ...req.params, modelName: converted.model }
    const json = res.json.bind(res)
    if (!originalBody.stream) {
      res.json = (data) => json(data?.error ? data : generateContentToInteraction(data, { model: converted.model }))
      try {
        return await generate(req, res)
      } finally {
        req.body = originalBody
        delete req._crsGeminiSelection
        res.json = json
      }
    }
    const write = res.write.bind(res)
    const end = res.end.bind(res)
    const parser = new IncrementalSSEParser()
    const state = createInteractionStreamState({ model: converted.model })
    const consume = (events) => {
      const result = events.flatMap((event) => {
        if (event.type === 'invalid') {
          return generateContentToInteractionEvents(
            { error: { code: 'invalid_upstream_response', message: 'Invalid Gemini stream event' } },
            state
          )
        }
        return event.type === 'data' ? generateContentToInteractionEvents(event.data.response ?? event.data, state) : []
      })
      if (result.length && !res.destroyed) {
        write(writeEvents(result))
      }
    }
    res.write = (chunk, encoding, callback) => {
      consume(parser.feed(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk))
      if (typeof callback === 'function') {
        callback()
      }
      return true
    }
    res.end = (chunk, encoding, callback) => {
      if (chunk) {
        res.write(chunk, encoding)
      }
      consume(parser.finish())
      const events = finishInteractionStream(state)
      if (events.length && !res.destroyed) {
        write(writeEvents(events))
      }
      res.write = write
      res.end = end
      req.body = originalBody
      delete req._crsGeminiSelection
      return end(null, encoding, callback)
    }
    await stream(req, res)
  }

  async _error(req, res, error) {
    logger.error('Gemini Interactions request failed', {
      requestId: req.requestId,
      accountId: req._crsAccountId,
      code: error.code,
      statusCode: error.statusCode ?? error.response?.status,
      stack: error.stack
    })
    if (res.destroyed || res.writableEnded) {
      return
    }
    const result = buildClientError({
      statusCode: error.statusCode ?? error.response?.status ?? 502,
      protocol: 'gemini',
      upstreamBody: error.response?.data ?? { error: { message: error.message, code: error.code } }
    })
    if (res.headersSent) {
      res.write(
        writeEvents([
          {
            event_type: 'error',
            error: {
              code: error.code ?? 'upstream_error',
              message: result.body.error?.message ?? 'Upstream request failed'
            }
          }
        ])
      )
      res.end()
    } else {
      res.status(result.statusCode).json(result.body)
    }
  }

  start() {
    if (this.timer) {
      return
    }
    this.timer = setInterval(
      () => this.poll().catch((error) => logger.error('Interactions settlement poll failed', error)),
      TTL.geminiInteractionPoll * 1000
    )
    this.timer.unref()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }

  async poll() {
    if (this.polling) {
      return
    }
    this.polling = true
    try {
      for (const key of await redis.getPendingGeminiInteractions()) {
        const raw = await redis.getClientSafe().get(key)
        if (!raw) {
          await redis.scheduleGeminiInteraction(key, false)
          continue
        }
        const record = JSON.parse(raw)
        try {
          const response = hasFinalUsage(record)
            ? { data: { id: record.id, status: record.status, usage: record.usage } }
            : await this._request(record.accountId, record.version, { id: record.id, timeout: 30000 })
          await this._observe(record, response.data)
        } catch (error) {
          if (error.response?.status === 404) {
            await redis.scheduleGeminiInteraction(key, false)
          } else {
            await redis.scheduleGeminiInteraction(key, true)
          }
          logger.warn('Interactions settlement poll failed', {
            interactionId: record.id,
            status: error.response?.status,
            code: error.code
          })
        }
      }
    } finally {
      this.polling = false
    }
  }
}

export const geminiInteractionsService = new GeminiInteractionsService()
