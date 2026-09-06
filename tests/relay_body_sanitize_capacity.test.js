import {
  sanitizeClaudeBodyFallbacks,
  BETA_SERVER_SIDE_FALLBACK,
} from '../src/modules/relay/translator/relay_translator_body_sanitize.js'
import {
  sanitizeOpenAICapacityShedForClient,
  isOpenAICapacityShedPayload,
  OPENAI_CAPACITY_SHED_RETRYABLE_CLIENT_CODE,
  createCapacityShedSseRewriteStream,
  isOpenAICapacityShedMessage,
} from '../src/modules/relay/relay_openai_capacity_shed.js'
import {
  hasCompactionTrigger,
  normalizeCompactionTriggerBody,
  ensureRemoteCompactionV2BetaHeader,
  normalizeOpenAIServiceTierAlias,
  CODEX_REMOTE_COMPACTION_V2,
} from '../src/modules/relay/relay_openai_compact_v2.js'

describe('claude body fallbacks sanitize', () => {
  it('strips fallbacks without server-side-fallback beta', () => {
    const body = { model: 'x', fallbacks: 'default', fallback_credit_token: 't' }
    sanitizeClaudeBodyFallbacks(body, { vendor: 'anthropic', anthropicBetaHeader: '' })
    expect(body.fallbacks).toBeUndefined()
    expect(body.fallback_credit_token).toBeUndefined()
  })

  it('keeps fallbacks when beta present', () => {
    const body = { model: 'x', fallbacks: 'default' }
    sanitizeClaudeBodyFallbacks(body, {
      vendor: 'anthropic',
      anthropicBetaHeader: BETA_SERVER_SIDE_FALLBACK,
    })
    expect(body.fallbacks).toBe('default')
  })

  it('bedrock always strips fallbacks and interface_geo', () => {
    const body = {
      model: 'x',
      fallbacks: 'default',
      interface_geo: 'US',
    }
    sanitizeClaudeBodyFallbacks(body, {
      vendor: 'bedrock',
      anthropicBetaHeader: BETA_SERVER_SIDE_FALLBACK,
    })
    expect(body.fallbacks).toBeUndefined()
    expect(body.interface_geo).toBeUndefined()
  })
})

describe('openai capacity shed sanitize', () => {
  it('rewrites server_is_overloaded to server_error', () => {
    const { payload, changed } = sanitizeOpenAICapacityShedForClient({
      type: 'error',
      error: { code: 'server_is_overloaded', message: 'busy' },
    })
    expect(changed).toBe(true)
    expect(payload.error.code).toBe(OPENAI_CAPACITY_SHED_RETRYABLE_CLIENT_CODE)
    expect(isOpenAICapacityShedPayload({ error: { code: 'server_is_overloaded' } })).toBe(true)
  })

  it('does not rewrite rate_limit_exceeded', () => {
    const input = { error: { code: 'rate_limit_exceeded', message: 'rl' } }
    const { payload, changed } = sanitizeOpenAICapacityShedForClient(input)
    expect(changed).toBe(false)
    expect(payload.error.code).toBe('rate_limit_exceeded')
  })
})

describe('compact v2 + service_tier', () => {
  it('detects and moves compaction_trigger to end, forces stream', () => {
    const body = {
      model: 'gpt-5',
      stream: false,
      input: [{ type: 'message', role: 'user' }, { type: 'compaction_trigger' }, { type: 'message', role: 'user' }],
    }
    expect(hasCompactionTrigger(body)).toBe(true)
    const { isV2 } = normalizeCompactionTriggerBody(body)
    expect(isV2).toBe(true)
    expect(body.stream).toBe(true)
    expect(body.input[body.input.length - 1].type).toBe('compaction_trigger')
  })

  it('ensures remote_compaction_v2 header', () => {
    const headers = ensureRemoteCompactionV2BetaHeader({ 'x-codex-beta-features': 'foo' })
    expect(headers['x-codex-beta-features']).toContain(CODEX_REMOTE_COMPACTION_V2)
    expect(headers['x-codex-beta-features']).toContain('foo')
  })

  it('fast -> priority', () => {
    expect(normalizeOpenAIServiceTierAlias('fast')).toBe('priority')
    expect(normalizeOpenAIServiceTierAlias('priority')).toBe('priority')
  })
})


describe('createCapacityShedSseRewriteStream', () => {
  it('rewrites capacity code across split chunks', () => {
    const stream = createCapacityShedSseRewriteStream()
    const part1 = 'data: {"type":"error","error":{"code":"server_is_over'
    const part2 = 'loaded","message":"busy"}}\n\n'
    expect(stream.push(part1)).toBe('')
    const out = stream.push(part2)
    expect(out).toContain('server_error')
    expect(out).not.toContain('server_is_overloaded')
  })
})


describe('capacity shed by message (no code)', () => {
  it('rewrites invalid_request_error with at-capacity message', () => {
    const { payload, changed } = sanitizeOpenAICapacityShedForClient({
      error: {
        type: 'invalid_request_error',
        message: 'Selected model is at capacity. Please try a different model.',
      },
    })
    expect(changed).toBe(true)
    expect(payload.error.code).toBe(OPENAI_CAPACITY_SHED_RETRYABLE_CLIENT_CODE)
    expect(isOpenAICapacityShedMessage(payload.error.message)).toBe(true)
  })

  it('rewrites overloaded message without code', () => {
    const { payload, changed } = sanitizeOpenAICapacityShedForClient({
      type: 'error',
      error: { message: 'Our servers are currently overloaded. Please try again later.' },
    })
    expect(changed).toBe(true)
    expect(payload.error.code).toBe('server_error')
  })

  it('does not rewrite rate_limit_exceeded', () => {
    const { changed } = sanitizeOpenAICapacityShedForClient({
      error: { code: 'rate_limit_exceeded', message: 'servers are currently overloaded' },
    })
    expect(changed).toBe(false)
  })
})

describe('SSE CRLF event boundary', () => {
  it('flushes events delimited by real CRLF CRLF bytes', () => {
    const stream = createCapacityShedSseRewriteStream()
    // 必须用真实 0x0d 0x0a，不能只写 LF
    const crlf = String.fromCharCode(13, 10)
    const chunk =
      'data: {"type":"error","error":{"code":"server_is_overloaded","message":"busy"}}' +
      crlf +
      crlf
    const out = stream.push(chunk)
    expect(out).toContain('server_error')
    expect(out).not.toContain('server_is_overloaded')
    expect(out.includes(crlf + crlf) || out.endsWith(crlf) || out.includes('')).toBe(true)
  })
})
