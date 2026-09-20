import { buildClientError, extractSafeMessage, extractUpstreamErrorCode } from '../../common/client_error_builder.js'

const TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.done',
  'response.incomplete',
  'response.failed',
  'response.cancelled',
  'response.canceled',
  'error',
])
const RATE_LIMIT_CODES = new Set(['rate_limit_error', 'rate_limit_exceeded', 'usage_limit_reached', 'slow_down'])

export const isResponsesRateLimitError = (error) =>
  Boolean(error && (RATE_LIMIT_CODES.has(error.code) || RATE_LIMIT_CODES.has(error.type)))

export const hasReportedTokenUsage = (usage) =>
  Boolean(
    usage &&
    ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens'].some(
      (key) =>
        (typeof usage[key] === 'number' || (typeof usage[key] === 'string' && usage[key].trim() !== '')) &&
        Number.isFinite(Number(usage[key])) &&
        Number(usage[key]) >= 0,
    ),
  )

export const getResponsesTerminalType = (data) => {
  if (data?.error || data?.response?.error) {
    return 'response.failed'
  }
  if (!TERMINAL_EVENTS.has(data?.type)) {
    return null
  }
  const status = data.response?.status
  if (['failed', 'incomplete', 'cancelled', 'canceled'].includes(status)) {
    return `response.${status}`
  }
  return data.type === 'error' ? 'response.failed' : data.type
}

// 每个 HTTP 请求独立观察原始事件；出站转换不能改变计费和失败判定。
export class ResponsesStreamState {
  constructor({ model = null, protocol = 'responses' } = {}) {
    this.model = model
    this.protocol = protocol
    this.usage = null
    this.serviceTier = null
    this.terminalType = null
    this.error = null
    this.incompleteReason = null
    this.chatFinished = false
    this.sawDone = false
  }

  observe(event) {
    if (!event || typeof event !== 'object' || this.terminalType) {
      return
    }
    const response = event.response ?? event
    if (typeof response.model === 'string' && response.model) {
      this.model = response.model
    }
    if (typeof response.service_tier === 'string' && response.service_tier) {
      this.serviceTier = response.service_tier
    }
    if (hasReportedTokenUsage(response.usage)) {
      this.usage = response.usage
    }
    if (Array.isArray(event.choices)) {
      this.chatFinished ||= event.choices.some(
        (choice) => choice.finish_reason !== null && choice.finish_reason !== undefined,
      )
    }
    const upstreamError = event.response?.error ?? event.error
    if (upstreamError) {
      this.error = typeof upstreamError === 'object' ? upstreamError : { message: String(upstreamError) }
    }
    const terminalType = getResponsesTerminalType(event)
    if (terminalType) {
      this.terminalType = terminalType
      this.incompleteReason = response.incomplete_details?.reason ?? null
    }
  }

  finish(transportError = null) {
    if (!this.terminalType) {
      if (this.protocol === 'chat' && !transportError && (this.chatFinished || this.sawDone)) {
        this.terminalType = 'response.completed'
      } else {
        this.terminalType = 'response.failed'
        this.error = {
          code: transportError ? 'upstream_stream_error' : 'upstream_stream_incomplete',
          message: transportError
            ? 'Upstream stream ended with a transport error'
            : 'Upstream stream ended before a terminal response event',
        }
      }
    }
    return this.result()
  }

  result() {
    const completed = this.terminalType === 'response.completed' || this.terminalType === 'response.done'
    if (completed) {
      return { statusCode: 200, errorCode: null, errorMessage: null, clientError: null }
    }
    if (this.terminalType === 'response.incomplete') {
      const limited = this.incompleteReason === 'max_output_tokens' || this.incompleteReason === 'max_tokens'
      return {
        statusCode: limited ? 200 : 502,
        errorCode: 'response_incomplete',
        errorMessage: `Response incomplete: ${extractSafeMessage(String(this.incompleteReason ?? 'unknown'))}`,
        clientError: null,
      }
    }
    const statusCode = isResponsesRateLimitError(this.error) ? 429 : 502
    const clientError = buildClientError({
      statusCode,
      protocol: 'openai',
      upstreamBody: { error: this.error },
    })
    return {
      statusCode,
      errorCode: extractUpstreamErrorCode({ error: this.error }) || 'response_failed',
      errorMessage: extractSafeMessage({ error: this.error }) || 'Upstream response failed',
      clientError: clientError.body,
    }
  }
}
