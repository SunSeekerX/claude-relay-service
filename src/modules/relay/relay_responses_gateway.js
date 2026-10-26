import crypto from 'node:crypto'
import { redis } from '../../infra/redis.js'
import { LIMITS } from '../../infra/redis_key.js'
import { hasPermission } from '../../common/compat_permissions.js'
import { logger } from '../../common/logger.js'
import { IncrementalSSEParser } from './relay_sse_parser.js'
import {
  buildResponsesProviderRequest,
  ProviderResponsesState,
  responsesConversionError
} from './relay_responses_conversion.js'

const compactPrompt =
  'Summarize this conversation so another assistant can continue it. Preserve the user requests, decisions, facts, file paths, tool results, unresolved errors, and pending work. Return only a concise factual summary; do not execute tools or continue the task.'
const sse = (events) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
export const responsesContextScope = (req, provider) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        req.apiKey.id,
        provider,
        req.apiKey._relayRoute?.code ?? null,
        req.apiKey._relayRoute?.binding ??
          (provider === 'gemini'
            ? req.apiKey.geminiAccountId
            : [
                req.apiKey.claudeAccountId,
                req.apiKey.claudeConsoleAccountId,
                req.apiKey.bedrockAccountId,
                req.apiKey.ccrAccountId
              ])
      ])
    )
    .digest('hex')

export const relayResponsesViaProvider = async (req, res, { provider, handle }) => {
  const originalBody = req.body
  const originalParams = req.params
  const originalProvider = req._crsResponsesProvider
  const originalJson = res.json.bind(res)
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)
  let restored = false
  let activeState = null
  const restore = () => {
    if (restored) {
      return
    }
    restored = true
    req.body = originalBody
    req.params = originalParams
    req._crsResponsesProvider = originalProvider
    res.json = originalJson
    res.write = originalWrite
    res.end = originalEnd
  }
  const logFailure = (error) =>
    logger.error('Responses provider bridge failed', { error, requestId: req.requestId, provider })
  const sendError = (error) => {
    logFailure(error)
    restore()
    if (res.destroyed || res.writableEnded) {
      return
    }
    if (res.headersSent) {
      return originalEnd(
        sse([
          activeState.event('response.failed', {
            response: {
              id: activeState.id,
              object: 'response',
              created_at: activeState.created,
              model: activeState.model,
              status: 'failed',
              output: [],
              usage: activeState.usage,
              error: { code: 'provider_bridge_error', message: 'Provider response failed' }
            }
          })
        ])
      )
    }
    return res.status(error.statusCode ?? error.status ?? 502).json({
      error: {
        type:
          (error.statusCode ?? error.status ?? 502) < 500 ? 'invalid_request_error' : 'api_error',
        code: error.code ?? 'provider_bridge_error',
        message:
          (error.statusCode ?? error.status ?? 502) < 500
            ? error.message
            : 'Provider response failed'
      }
    })
  }
  try {
    if (!hasPermission(req.apiKey.permissions, provider)) {
      throw Object.assign(
        new Error('This API key does not have permission for the target provider'),
        { statusCode: 403 }
      )
    }
    const source = { ...originalBody }
    if (typeof source.model !== 'string' || !source.model.trim()) {
      throw responsesConversionError('model is required', 'invalid_request')
    }
    for (const field of ['store', 'stream']) {
      if (source[field] !== undefined && typeof source[field] !== 'boolean') {
        throw responsesConversionError(`${field} must be a boolean`, 'invalid_request')
      }
    }
    const scope = responsesContextScope(req, provider)
    let parent = null
    if (source.previous_response_id) {
      if (
        typeof source.previous_response_id !== 'string' ||
        !/^resp_[A-Za-z0-9_-]{1,200}$/.test(source.previous_response_id)
      ) {
        throw responsesConversionError('Invalid previous_response_id')
      }
      parent = await redis.getResponsesContext(scope, source.previous_response_id)
      if (!parent) {
        throw responsesConversionError(
          'Previous response is unavailable; resend the full input context',
          'previous_response_not_found'
        )
      }
    }
    const delta =
      typeof source.input === 'string'
        ? [{ role: 'user', content: source.input }]
        : (source.input ?? [])
    if (!Array.isArray(delta)) {
      throw responsesConversionError('input must be text or an array')
    }
    source.input = [...(parent?.input ?? []), ...delta]
    if (source.tools === undefined && parent?.tools) {
      source.tools = parent.tools
    }
    if (
      source.store !== false &&
      Buffer.byteLength(JSON.stringify(source)) > LIMITS.responsesContextBytes
    ) {
      throw Object.assign(
        new Error('Responses context exceeds the storage budget; use store:false with full input'),
        { statusCode: 413 }
      )
    }
    const compact = /\/responses\/compact\/?$/.test(req.path)
    if (compact) {
      source.input.push({ role: 'user', content: compactPrompt })
      source.stream = false
      source.tools = []
      delete source.tool_choice
    }
    const { request, adapter } = buildResponsesProviderRequest(source, provider)
    const state = new ProviderResponsesState(provider, source.model, adapter)
    activeState = state
    req.body = request
    req._crsResponsesProvider = provider
    req.params = { ...req.params, ...(provider === 'gemini' ? { modelName: source.model } : {}) }
    req._crsProtocolBridge = `openai-responses->${provider === 'claude' ? 'claude-messages' : 'gemini-generate'}`
    const persist = async (response) => {
      if (compact || source.store === false || response.status === 'failed') {
        return
      }
      const { requestDetailService } = await import('./relay_request_detail_service.js')
      const settings = await requestDetailService.getSettings()
      await redis.saveResponsesContext(
        scope,
        state.id,
        {
          input: [...source.input, ...response.output],
          ...(source.tools ? { tools: source.tools } : {})
        },
        settings.retentionHours
      )
    }
    const renderCompact = (response) => {
      if (response.status !== 'completed') {
        throw Object.assign(new Error('Compaction did not complete'), { statusCode: 502 })
      }
      const text = response.output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content)
        .map((part) => part.text ?? '')
        .join('\n')
      if (!text) {
        throw Object.assign(new Error('Compaction returned no summary'), { statusCode: 502 })
      }
      return {
        id: `cmp_${crypto.randomUUID().replaceAll('-', '')}`,
        object: 'response.compaction',
        created_at: state.created,
        output: [
          {
            id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }]
          }
        ],
        usage: response.usage
      }
    }
    let writingJson = false
    let ended = false
    const parser = new IncrementalSSEParser()
    const consume = (events) =>
      events.flatMap((event) => {
        if (event.type === 'invalid') {
          throw new Error('Invalid provider SSE')
        }
        return event.type === 'data' ? state.observe(event.data) : []
      })
    res.json = (data) => {
      writingJson = true
      if (res.statusCode >= 400 || data?.error || data?.type === 'error') {
        restore()
        if (res.statusCode < 400) {
          res.statusCode = 502
        }
        return originalJson({
          error: {
            type: res.statusCode < 500 ? 'invalid_request_error' : 'api_error',
            code: 'provider_request_failed',
            message: 'Provider request failed'
          }
        })
      }
      const finish = async () => {
        state.fromMessage(data)
        const { response } = state.finish()
        await persist(response)
        restore()
        return originalJson(compact ? renderCompact(response) : response)
      }
      finish().catch(sendError)
      return res
    }
    if (source.stream === true) {
      res.write = (chunk, encoding, callback) => {
        const done = typeof encoding === 'function' ? encoding : callback
        try {
          const events = consume(parser.feed(chunk))
          const output = sse(events)
          if (!output) {
            done?.()
            return true
          }
          return originalWrite(output, 'utf8', done)
        } catch (error) {
          logFailure(error)
          state.error = { code: 'provider_conversion_error' }
          req._crsBridgeFailure = {
            statusCode: 502,
            errorCode: 'provider_conversion_error',
            errorMessage: 'Provider output could not be converted'
          }
          done?.()
          return true
        }
      }
      let started = false
      const writeEvents = res.write
      res.write = (chunk, encoding, callback) => {
        if (!started) {
          started = true
          originalWrite(sse(state.start()))
        }
        return writeEvents(chunk, encoding, callback)
      }
      res.end = (chunk, encoding, callback) => {
        if (writingJson || ended) {
          return res
        }
        ended = true
        const done =
          typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback
        const finish = async () => {
          if (!started) {
            started = true
            originalWrite(sse(state.start()))
          }
          if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
            originalWrite(sse(consume(parser.feed(chunk))))
          }
          originalWrite(sse(consume(parser.finish())))
          const { response, events } = state.finish()
          await persist(response)
          restore()
          return originalEnd(sse(events), 'utf8', done)
        }
        finish().catch(sendError)
        return res
      }
    }
    return await handle(req, res)
  } catch (error) {
    return sendError(error)
  }
}
