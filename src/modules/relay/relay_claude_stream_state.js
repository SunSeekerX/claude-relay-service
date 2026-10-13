import {
  buildAnthropicClientErrorBody,
  extractSafeMessage,
  extractUpstreamErrorCode
} from '../../common/client_error_builder.js'

const TOKEN_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens'
]
const CACHE_FIELDS = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']
const isTokenCount = (value) => Number.isSafeInteger(value) && value >= 0

const mergeUsage = (previous, reported, includeOutput) => {
  if (!reported || typeof reported !== 'object' || Array.isArray(reported)) {
    return previous
  }
  const fields = includeOutput
    ? TOKEN_FIELDS
    : TOKEN_FIELDS.filter((field) => field !== 'output_tokens')
  if (
    fields.some(
      (field) =>
        reported[field] !== undefined &&
        !(reported[field] === null && field !== 'output_tokens') &&
        !isTokenCount(reported[field])
    )
  ) {
    return previous
  }
  const cache = reported.cache_creation
  if (
    cache !== undefined &&
    cache !== null &&
    (!cache ||
      typeof cache !== 'object' ||
      Array.isArray(cache) ||
      CACHE_FIELDS.some((field) => cache[field] !== undefined && !isTokenCount(cache[field])))
  ) {
    return previous
  }
  const next = { ...previous }
  for (const field of fields) {
    if (reported[field] !== undefined && reported[field] !== null) {
      next[field] = reported[field]
    }
  }
  if (cache) {
    next.cache_creation = { ...previous.cache_creation }
    for (const field of CACHE_FIELDS) {
      if (cache[field] !== undefined) {
        next.cache_creation[field] = cache[field]
      }
    }
  }
  if (typeof reported.speed === 'string' && reported.speed.trim()) {
    next.speed = reported.speed.trim().toLowerCase()
  }
  return next
}

// Anthropic message_delta 的用量是累计快照；message_start 的初始 output 不用于结算。
export class ClaudeStreamState {
  constructor({ model = null } = {}) {
    this.usage = { model }
    this.hasDeltaUsage = false
    this.terminalType = null
    this.error = null
  }

  observe(event) {
    if (!event || typeof event !== 'object' || this.terminalType) {
      return
    }
    if (event.type === 'message_start') {
      this.usage = mergeUsage(this.usage, event.message?.usage, false)
      if (typeof event.message?.model === 'string' && event.message.model) {
        this.usage.model = event.message.model
      }
    } else if (event.type === 'message_delta') {
      const next = mergeUsage(this.usage, event.usage, true)
      if (next !== this.usage && isTokenCount(event.usage?.output_tokens)) {
        this.hasDeltaUsage = true
      }
      this.usage = next
    } else if (event.type === 'message_stop') {
      this.terminalType = 'message_stop'
    } else if (event.type === 'error') {
      this.terminalType = 'error'
      this.error = event.error ?? { type: 'api_error', message: 'Upstream stream failed' }
    }
  }

  getUsage() {
    if (!this.hasDeltaUsage || !isTokenCount(this.usage.input_tokens)) {
      return null
    }
    return {
      ...this.usage,
      ...(this.usage.cache_creation ? { cache_creation: { ...this.usage.cache_creation } } : {})
    }
  }

  finish(transportError = null) {
    if (!this.terminalType || transportError?.code === 'STREAM_FATAL') {
      this.terminalType = 'error'
      this.error = {
        type: transportError?.code === 'ETIMEDOUT' ? 'timeout_error' : 'api_error',
        code:
          transportError?.code === 'STREAM_FATAL'
            ? 'stream_processing_error'
            : transportError
              ? 'upstream_stream_error'
              : 'upstream_stream_incomplete',
        message: transportError
          ? 'Upstream stream ended with a transport error'
          : 'Upstream stream ended before message_stop'
      }
    }
    return this.result()
  }

  result() {
    if (this.terminalType === 'message_stop') {
      return { statusCode: 200, errorCode: null, errorMessage: null }
    }
    const statusByType = {
      authentication_error: 401,
      permission_error: 403,
      invalid_request_error: 400,
      not_found_error: 404,
      request_too_large: 413,
      rate_limit_error: 429,
      overloaded_error: 529,
      timeout_error: 504
    }
    const statusCode = statusByType[this.error?.type] ?? 502
    const body = { error: this.error }
    const clientError = buildAnthropicClientErrorBody({ statusCode, upstreamBody: body })
    return {
      statusCode,
      errorCode: extractUpstreamErrorCode(body) ?? clientError.error.type,
      errorMessage: extractSafeMessage(body) ?? clientError.error.message
    }
  }
}
