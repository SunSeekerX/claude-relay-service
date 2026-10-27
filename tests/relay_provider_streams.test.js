import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { IncrementalSSEParser } from '../src/modules/relay/relay_sse_parser.js'
import { adaptResponsesTools } from '../src/modules/relay/relay_responses_tools.js'

const axios = jest.fn()
const videoDb = {
  eval: jest.fn().mockResolvedValue(1),
  hgetall: jest.fn(),
  hset: jest.fn(),
  hdel: jest.fn()
}
const reserveCost = jest.fn().mockResolvedValue()
const releaseCostReservation = jest.fn().mockResolvedValue()
const logger = new Proxy({}, { get: () => jest.fn() })
const apiKeyService = {
  recordUsage: jest.fn().mockResolvedValue({ realCost: 1, ratedCost: 1 }),
  hasPermission: jest.fn().mockReturnValue(true),
  calculateRatedCost: jest.fn(async (_key, _service, base) => base * 2)
}
const requestDetailService = {
  captureUnmeteredRequest: jest.fn().mockResolvedValue({ captured: true }),
  captureRequestDetail: jest.fn().mockResolvedValue({ captured: true })
}
const openaiResponsesAccountService = {
  updateAccountUsage: jest.fn().mockResolvedValue(undefined),
  updateUsageQuota: jest.fn().mockResolvedValue(undefined),
}
const unifiedOpenAIScheduler = { markAccountRateLimited: jest.fn().mockResolvedValue(undefined) }
const grokAccountService = { markAccountRateLimited: jest.fn().mockResolvedValue(undefined) }
const markTempUnavailable = jest.fn().mockResolvedValue(undefined)
const geminiAccount = {
  id: 'gemini-account',
  name: 'fixture',
  baseUrl: 'https://example.invalid',
  apiKey: 'fixture-key',
}

const modules = {
  '../src/modules/relay/relay_routing_service.js': { getLegacyProviderModels: async () => [] },
  '../src/modules/relay/relay_test_prompt_config_service.js': { testPromptConfigService: {} },
  axios: { default: axios },
  '../config/config.js': { config: { requestTimeout: 1000, proxy: { timeout: 1000 } } },
  '../src/common/logger.js': { logger },
  '../src/infra/redis.js': {
    redis: { getClientSafe: () => videoDb, reserveCost, releaseCostReservation }
  },
  '../src/infra/redis_key.js': {
    RedisKeys: { session: { grokVideoTask: (_key, id) => `fixture-video:${id}` } },
    TTL: { grokVideoTask: 172800, grokVideoSettlementLease: 60 },
    LIMITS: { responsesContextBytes: 16 * 1024 * 1024 }
  },
  '../src/modules/apikey/apikey_service.js': { apiKeyService },
  '../src/modules/account/account_grok_service.js': { grokAccountService },
  '../src/modules/account/account_openai_responses_service.js': { openaiResponsesAccountService },
  '../src/modules/account/account_gemini_service.js': {},
  '../src/modules/account/account_gemini_api_service.js': {
    geminiApiAccountService: {
      getAccount: jest.fn().mockResolvedValue(geminiAccount),
      markAccountUsed: jest.fn().mockResolvedValue(undefined)
    },
  },
  '../src/modules/relay/relay_grok_scheduler.js': { grokScheduler: {} },
  '../src/modules/relay/relay_unified_openai_scheduler.js': { unifiedOpenAIScheduler },
  '../src/modules/relay/relay_unified_gemini_scheduler.js': {
    unifiedGeminiScheduler: {
      selectAccountForApiKey: jest.fn().mockResolvedValue({
        accountId: geminiAccount.id,
        accountType: 'gemini-api',
      }),
    },
  },
  '../src/modules/relay/relay_request_detail_service.js': { requestDetailService },
  '../src/modules/relay/relay_upstream_error_helper.js': {
    buildErrorContext: (value) => value,
    markTempUnavailable,
    parseRetryAfter: () => 60,
  },
  '../src/modules/proxy/proxy_resolver.js': {
    proxyResolver: { resolveProxyConfigForAccount: jest.fn().mockReturnValue(undefined) },
  },
  '../src/modules/proxy/proxy_helper.js': { ProxyHelper: {} },
  '../src/common/xai_helper.js': {},
  '../src/common/common_helper.js': { getMappedModelName: jest.fn() },
  '../src/modules/pricing/pricing_cost_calculator.js': { CostCalculator: {} },
  '../src/modules/pricing/pricing_service.js': {
    pricingService: { calculateCost: () => ({ totalCost: 3.25 }) }
  },
  '../src/modules/payment/payment_service_rates_service.js': {
    serviceRatesService: { getService: () => 'grok' }
  },
  '../src/modules/account/account_claude_console_service.js': {
    claudeConsoleAccountService: {
      isAccountRateLimited: jest.fn().mockResolvedValue(false),
      removeAccountRateLimit: jest.fn(),
      isAccountOverloaded: jest.fn().mockResolvedValue(false),
      removeAccountOverload: jest.fn()
    }
  },
  '../src/modules/user/user_message_queue_service.js': { userMessageQueueService: {} },
  '../src/modules/relay/relay_rate_limit_helper.js': { updateRateLimitCounters: jest.fn() },
  '../src/modules/relay/relay_upstream_protocol_guard.js': {
    isNonProtocolUpstreamBody: jest.fn(),
    handleNonProtocolUpstream: jest.fn(),
  },
  '../src/modules/relay/relay_openai_compact_v2.js': { applyOpenAIServiceTierAlias: jest.fn() },
  '../src/modules/relay/relay_openai_model_alias.js': { applyOpenAIPublicModelAlias: jest.fn(), normalizeKnownOpenAICodexModel: () => null },
  '../src/modules/relay/relay_codex_bootstrap_normalize.js': { normalizeCodexBootstrapBody: jest.fn() },
  '../src/modules/relay/relay_gemini_relay_service.js': {
    sendGeminiRequest: jest.fn(),
    getAvailableModels: jest.fn(),
  },
  '../src/modules/relay/relay_antigravity_relay_service.js': { sendAntigravityRequest: jest.fn() },
  '../src/modules/relay/relay_session_helper.js': {
    sessionHelper: { generateSessionHash: () => 'fixture-session' },
  },
  '../src/modules/relay/translator/relay_translator_interactions.js': {}
}
for (const [name, exports] of Object.entries(modules)) {
  jest.unstable_mockModule(name, () => exports)
}

const { claudeConsoleRelayService } =
  await import('../src/modules/relay/relay_claude_console_relay_service.js')
const { grokRelayService } = await import('../src/modules/relay/relay_grok_relay_service.js')
const { CodexToOpenAIConverter } = await import('../src/modules/relay/relay_codex_to_openai.js')
const { openaiResponsesRelayService } = await import('../src/modules/relay/relay_openai_responses_relay_service.js')
const { handleMessages, handleStandardGenerateContent, handleStandardStreamGenerateContent } =
  await import('../src/modules/relay/relay_gemini_handlers_routes.js')
const { relayResponsesViaProvider } = await import('../src/modules/relay/relay_responses_gateway.js')

const makeResponse = () => {
  const res = new EventEmitter()
  res.statusCode = 200
  res.headersSent = false
  res.destroyed = false
  res.writableEnded = false
  res.chunks = []
  res.completion = new Promise((resolve) => {
    res.finishResponse = resolve
  })
  res.setHeader = jest.fn()
  res.status = jest.fn((status) => {
    res.statusCode = status
    return res
  })
  res.write = jest.fn((chunk) => {
    res.headersSent = true
    res.chunks.push(String(chunk))
    return true
  })
  res.end = jest.fn((chunk) => {
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {res.chunks.push(String(chunk))}
    res.writableEnded = true
    res.emit('finish')
    res.finishResponse()
    return res
  })
  res.json = jest.fn((body) => {
    res.body = body
    res.end()
    return res
  })
  return res
}

const makeRequest = (res, body = { model: 'gpt-test', stream: true }) => ({
  body,
  res,
  headers: {},
  apiKey: { id: 'fixture-key-id', permissions: ['openai', 'gemini'] },
  requestId: 'fixture-request',
  requestStartedAt: Date.now(),
  method: 'POST',
  path: '/openai/responses',
  originalUrl: '/openai/responses',
  params: {},
})
const upstream = (events) => ({
  status: 200,
  headers: {},
  data: Readable.from(events.map((event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`))),
})
const account = { id: 'fixture-account', dailyQuota: '0', disableAutoProtection: true }
const usage = { input_tokens: 1000, output_tokens: 40, input_tokens_details: { cached_tokens: 900 } }
const nextTick = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  jest.clearAllMocks()
  axios.mockReset()
  apiKeyService.recordUsage.mockReset().mockResolvedValue({ realCost: 1, ratedCost: 1 })
  videoDb.eval.mockReset().mockResolvedValue(1)
})

describe('Grok forwarding contracts', () => {
  it('restores native Responses namespace calls while billing the raw terminal usage once', async () => {
    const res = makeResponse()
    const req = makeRequest(res, { model: 'grok-test', stream: true })
    const toolAdapter = adaptResponsesTools({ tools: [{ type: 'namespace', name: 'fs', tools: [{ type: 'function', name: 'read', parameters: {} }] }] })
    const item = { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'fs__read', arguments: '{}' }
    await grokRelayService._handleStreamResponse(upstream([
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { model: 'grok-test', status: 'completed', output: [item], usage } }
    ]), res, account, req.apiKey, 'grok-test', req, { endpointKind: 'responses', toolAdapter })
    const parser = new IncrementalSSEParser()
    const events = parser.feed(res.chunks.join('')).filter((event) => event.type === 'data').map((event) => event.data)
    expect(events.at(-1).response.output[0]).toMatchObject({ name: 'read', namespace: 'fs', call_id: 'c1' })
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage.mock.calls[0][1]).toMatchObject({ input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 40 })
  })
  it('keeps a failed non-stream response failed when it also reports usage', async () => {
    const res = makeResponse()
    const req = makeRequest(res, { model: 'grok-test', stream: false })
    await grokRelayService._handleNormalResponse(
      {
        status: 200,
        headers: {},
        data: {
          status: 'failed',
          usage,
          error: { code: 'server_error', message: 'upstream failed' },
        },
      },
      res,
      account,
      req.apiKey,
      'grok-test',
      req,
      { reverseBridgeToClaudeMessages: true },
    )
    expect(res.statusCode).toBe(502)
    expect(res.body.type).toBe('error')
    expect(apiKeyService.recordUsage.mock.calls[0][5]).toMatchObject({ statusCode: 502 })
    expect(apiKeyService.recordUsage.mock.calls[0][5].errorCode).toBe('server_error')
  })

  it('does not turn a conversion failure after completed into a successful DONE', async () => {
    const res = makeResponse()
    const req = makeRequest(res)
    const convert = jest.spyOn(CodexToOpenAIConverter.prototype, 'convertStreamChunk').mockImplementation(() => {
      throw new Error('conversion failed')
    })
    try {
      await grokRelayService._handleStreamResponse(
        upstream([{ type: 'response.completed', response: { usage } }]),
        res,
        account,
        req.apiKey,
        'grok-test',
        req,
        {
          endpointKind: 'responses',
          reverseBridgeToChat: true,
        },
      )
    } finally {
      convert.mockRestore()
    }
    const output = res.chunks.join('')
    expect(output).not.toContain('[DONE]')
    expect(new IncrementalSSEParser().feed(output)[0].data.error).toBeDefined()
    expect(apiKeyService.recordUsage.mock.calls[0][5]).toMatchObject({
      statusCode: 502,
      errorCode: 'protocol_conversion_failed',
    })
  })

  it('converts a non-stream Claude response once and bills the original usage', async () => {
    const originalRelay = grokRelayService._relay
    const res = makeResponse()
    const body = { model: 'grok-test', stream: false, messages: [{ role: 'user', content: 'hello' }] }
    const req = makeRequest(res, body)
    grokRelayService._relay = async () =>
      grokRelayService._handleNormalResponse(
        {
          status: 200,
          headers: {},
          data: {
            id: 'r1',
            model: 'grok-test',
            status: 'completed',
            usage,
            output: [{ type: 'message', content: [{ type: 'output_text', text: '完整响应' }] }],
          },
        },
        res,
        account,
        req.apiKey,
        'grok-test',
        req,
        { reverseBridgeToClaudeMessages: true },
      )
    try {
      await grokRelayService.relayMessages(req, res, req.apiKey)
    } finally {
      grokRelayService._relay = originalRelay
    }
    expect(res.body.content).toEqual([{ type: 'text', text: '完整响应' }])
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage.mock.calls[0][1]).toMatchObject({
      input_tokens: 100,
      cache_read_input_tokens: 900,
      output_tokens: 40,
    })
    expect(req.body).toBe(body)
  })

  it('keeps split UTF-8 bytes intact in a Responses passthrough', async () => {
    const res = makeResponse()
    const req = makeRequest(res)
    const bytes = Buffer.from('data: {"type":"response.output_text.delta","delta":"中文"}\n\n')
    const split = bytes.indexOf(Buffer.from('中')) + 1
    const completed = Buffer.from(`data: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n\n`)
    await grokRelayService._handleStreamResponse(
      {
        status: 200,
        headers: {},
        data: Readable.from([bytes.subarray(0, split), bytes.subarray(split), completed]),
      },
      res,
      account,
      req.apiKey,
      'grok-test',
      req,
      { endpointKind: 'responses' },
    )
    expect(res.chunks.join('')).toBe(bytes.toString() + completed.toString())
    expect(apiKeyService.recordUsage.mock.calls[0][1].input_tokens).toBe(100)
  })
})

describe('OpenAI Responses stream completion', () => {
  it('waits for downstream drain before forwarding another chunk', async () => {
    const res = makeResponse()
    const req = makeRequest(res)
    const { write } = res
    res.write = jest.fn((chunk) => {
      write(chunk)
      return res.chunks.length > 1
    })
    const completion = openaiResponsesRelayService._handleStreamResponse(
      upstream([
        { type: 'response.created', response: { id: 'fixture' } },
        { type: 'response.output_text.delta', delta: 'hello' },
        { type: 'response.completed', response: { usage } }
      ]), res, account, req.apiKey, 'gpt-test', jest.fn(), req
    )
    await nextTick()
    expect(res.chunks).toHaveLength(1)
    expect(apiKeyService.recordUsage).not.toHaveBeenCalled()
    res.emit('drain')
    await completion
    expect(res.chunks).toHaveLength(3)
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
  })

  it('drains usage after a client closes while a write is blocked', async () => {
    const res = makeResponse()
    const req = makeRequest(res)
    res.write.mockImplementation((chunk) => {
      res.chunks.push(String(chunk))
      return false
    })
    const releaseConcurrency = jest.fn()
    const completion = openaiResponsesRelayService._handleStreamResponse(
      upstream([
        { type: 'response.created', response: { id: 'fixture' } },
        { type: 'response.completed', response: { usage } }
      ]), res, account, req.apiKey, 'gpt-test', jest.fn(), req, { releaseConcurrency }
    )
    await nextTick()
    res.destroyed = true
    res.emit('close')
    await completion
    expect(res.chunks).toHaveLength(1)
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(releaseConcurrency).toHaveBeenCalledTimes(1)
    expect(res.listenerCount('drain')).toBe(0)
  })

  it('does not hang when upstream fails while waiting for the client to drain', async () => {
    const source = new PassThrough()
    const res = makeResponse()
    const req = makeRequest(res)
    res.write.mockReturnValueOnce(false)
    const completion = openaiResponsesRelayService._handleStreamResponse(
      { status: 200, headers: {}, data: source }, res, account, req.apiKey,
      'gpt-test', jest.fn(), req
    )
    source.write('data: {"type":"response.created","response":{"id":"fixture"}}\n\n')
    await nextTick()
    source.destroy(new Error('fixture upstream error'))
    await completion
    expect(requestDetailService.captureUnmeteredRequest).toHaveBeenCalled()
    expect(res.listenerCount('drain')).toBe(0)
  })

  it('finishes on a terminal event even if the upstream keeps its socket open', async () => {
    const res = makeResponse()
    const req = makeRequest(res)
    let sent = false
    const source = new Readable({
      read() {
        if (!sent) {
          sent = true
          this.push(`data: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n\n`)
        }
      },
    })
    await openaiResponsesRelayService._handleStreamResponse(
      { status: 200, headers: {}, data: source },
      res,
      account,
      req.apiKey,
      'gpt-test',
      jest.fn(),
      req,
    )
    expect(source.destroyed).toBe(true)
    expect(res.writableEnded).toBe(true)
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
  })

  it('accounts for an incomplete response that reports usage', async () => {
    const res = makeResponse()
    const req = makeRequest(res)
    const releaseConcurrency = jest.fn().mockResolvedValue(undefined)
    const detach = jest.fn()
    await openaiResponsesRelayService._handleStreamResponse(
      upstream([
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage,
          },
        },
      ]),
      res,
      account,
      req.apiKey,
      'gpt-test',
      detach,
      req,
      { releaseConcurrency },
    )
    expect(apiKeyService.recordUsage.mock.calls[0][1]).toMatchObject({
      input_tokens: 100,
      cache_read_input_tokens: 900,
      output_tokens: 40,
    })
    expect(apiKeyService.recordUsage.mock.calls[0][6]).toMatchObject({ errorCode: 'response_incomplete' })
    expect(releaseConcurrency).toHaveBeenCalledTimes(1)
    expect(detach).toHaveBeenCalledTimes(1)
    expect(res.writableEnded).toBe(true)
  })

  it('records unmetered EOF failures and emits a terminal error', async () => {
    const res = makeResponse()
    const req = makeRequest(res)
    await openaiResponsesRelayService._handleStreamResponse(
      upstream([{ type: 'response.created', response: { id: 'r1' } }]),
      res,
      account,
      req.apiKey,
      'gpt-test',
      jest.fn(),
      req,
    )
    expect(apiKeyService.recordUsage).not.toHaveBeenCalled()
    expect(requestDetailService.captureUnmeteredRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        result: expect.objectContaining({ errorCode: 'upstream_stream_incomplete', statusCode: 502 }),
      }),
    )
    const events = new IncrementalSSEParser().feed(res.chunks.join('')).filter((event) => event.type === 'data')
    expect(events.at(-1).data.error).toBeDefined()
    expect(res.writableEnded).toBe(true)
  })

  it('continues metering after the client disconnects', async () => {
    const res = makeResponse()
    res.destroyed = true
    const req = makeRequest(res)
    req._crsClientGone = true
    await openaiResponsesRelayService._handleStreamResponse(
      upstream([{ type: 'response.completed', response: { usage } }]),
      res,
      account,
      req.apiKey,
      'gpt-test',
      jest.fn(),
      req,
    )
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(res.write).not.toHaveBeenCalled()
  })

  it('recognizes a nested rate limit and retains its reset interval', async () => {
    const res = makeResponse()
    const req = makeRequest(res)
    await openaiResponsesRelayService._handleStreamResponse(
      upstream([
        {
          type: 'response.failed',
          response: {
            error: { code: 'rate_limit_exceeded', resets_in_seconds: 45 },
          },
        },
      ]),
      res,
      account,
      req.apiKey,
      'gpt-test',
      jest.fn(),
      req,
    )
    expect(unifiedOpenAIScheduler.markAccountRateLimited).toHaveBeenCalledWith(account.id, 'openai-responses', null, 45)
    expect(markTempUnavailable).toHaveBeenCalled()
  })

  it('ends the client response when concurrency cleanup fails', async () => {
    const res = makeResponse()
    const req = makeRequest(res)
    await expect(
      openaiResponsesRelayService._handleStreamResponse(
        upstream([{ type: 'response.completed', response: { usage } }]),
        res,
        account,
        req.apiKey,
        'gpt-test',
        jest.fn(),
        req,
        {
          releaseConcurrency: jest.fn().mockRejectedValue(new Error('cleanup failed')),
        },
      ),
    ).rejects.toThrow('cleanup failed')
    expect(res.writableEnded).toBe(true)
  })
})

describe('Gemini API Key tool responses', () => {
  it.each([false, true])(
    'conversion errors cannot skip the upstream usage charge (stream=%s)',
    async (stream) => {
      const res = makeResponse()
      const req = makeRequest(res, { model: 'gemini-test', input: 'hello', stream, store: false })
      req.path = '/gemini/v1/responses'
      const data = {
        candidates: [
          {
            content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] },
            finishReason: 'STOP'
          }
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
      }
      axios.mockResolvedValue({
        status: 200,
        headers: {},
        data: stream ? Readable.from([`data: ${JSON.stringify(data)}\n\n`]) : data
      })
      await relayResponsesViaProvider(req, res, {
        provider: 'gemini',
        handle: stream ? handleStandardStreamGenerateContent : handleStandardGenerateContent
      })
      await res.completion
      await nextTick()
      expect(axios).toHaveBeenCalledTimes(1)
      expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
      expect(apiKeyService.recordUsage.mock.calls[0][1]).toMatchObject({
        input_tokens: 10,
        output_tokens: 2
      })
      expect(apiKeyService.recordUsage.mock.calls[0][6]).toMatchObject({
        statusCode: 502,
        errorCode: 'provider_conversion_error',
        protocolTerminal: 'response.failed'
      })
      if (stream) {
        expect(res.chunks.join('')).toContain('response.failed')
      } else {
        expect(res.statusCode).toBe(502)
      }
    }
  )
  it.each([false, true])(
    'reverse Responses bills actual usage once with the failed terminal metadata (stream=%s)',
    async (stream) => {
      const res = makeResponse()
      const req = makeRequest(res, { model: 'gemini-test', input: 'hello', stream, store: false })
      req.path = '/gemini/v1/responses'
      req._crsRecordRelayResult = jest.fn()
      const data = {
        candidates: [
          { content: { parts: [{ text: 'partial output' }] }, finishReason: 'UNEXPECTED_TOOL_CALL' }
        ],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 60,
          candidatesTokenCount: 7,
          thoughtsTokenCount: 3,
          totalTokenCount: 110
        }
      }
      axios.mockResolvedValue({
        status: 200,
        headers: {},
        data: stream ? Readable.from([`data: ${JSON.stringify(data)}\n\n`]) : data
      })
      await relayResponsesViaProvider(req, res, {
        provider: 'gemini',
        handle: stream ? handleStandardStreamGenerateContent : handleStandardGenerateContent
      })
      await res.completion
      await nextTick()
      expect(axios).toHaveBeenCalledTimes(1)
      expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
      const call = apiKeyService.recordUsage.mock.calls[0]
      expect(call[1]).toMatchObject({
        input_tokens: 40,
        cache_read_input_tokens: 60,
        output_tokens: 7,
        reasoning_tokens: 3
      })
      expect(call[6]).toMatchObject({
        statusCode: 502,
        errorCode: 'upstream_unexpected_tool_call',
        protocolTerminal: 'response.failed'
      })
      expect(req._crsRecordRelayResult).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 502,
          errorCode: 'upstream_unexpected_tool_call',
          hasUsage: true,
          final: true
        })
      )
      if (stream) {
        const events = new IncrementalSSEParser()
          .feed(res.chunks.join(''))
          .filter((event) => event.type === 'data')
          .map((event) => event.data)
        expect(events.at(-1)).toMatchObject({
          type: 'response.failed',
          response: {
            status: 'failed',
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
          }
        })
        expect(events.some((event) => event.type === 'response.completed')).toBe(false)
      } else {
        expect(res.body).toMatchObject({
          status: 'failed',
          error: { code: 'upstream_unexpected_tool_call' },
          usage: { total_tokens: 110 }
        })
      }
    }
  )
  it.each([false, true])(
    'reverse Responses preserves filtered partial output and one metered incomplete outcome (stream=%s)',
    async (stream) => {
      const res = makeResponse()
      const req = makeRequest(res, { model: 'gemini-test', input: 'hello', stream, store: false })
      req.path = '/gemini/v1/responses'
      const data = {
        candidates: [
          { content: { parts: [{ text: 'partial output' }] }, finishReason: 'PROHIBITED_CONTENT' }
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
      }
      axios.mockResolvedValue({
        status: 200,
        headers: {},
        data: stream ? Readable.from([`data: ${JSON.stringify(data)}\n\n`]) : data
      })
      await relayResponsesViaProvider(req, res, {
        provider: 'gemini',
        handle: stream ? handleStandardStreamGenerateContent : handleStandardGenerateContent
      })
      await res.completion
      await nextTick()
      expect(axios).toHaveBeenCalledTimes(1)
      expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
      expect(apiKeyService.recordUsage.mock.calls[0][6]).toMatchObject({
        statusCode: 200,
        errorCode: 'response_incomplete',
        protocolTerminal: 'response.incomplete'
      })
      const response = stream
        ? new IncrementalSSEParser()
            .feed(res.chunks.join(''))
            .filter((event) => event.type === 'data')
            .at(-1).data.response
        : res.body
      expect(response).toMatchObject({
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
        output: [{ content: [{ text: 'partial output' }] }],
        usage: { total_tokens: 12 }
      })
    }
  )
  it.each([false, true])('preserves tool IDs and media with stream=%s', async (stream) => {
    const functionResponse = {
      id: 'call_1',
      name: 'read_file',
      response: { output: 'image' },
      parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }],
      willContinue: false,
      scheduling: 'SILENT',
    }
    const res = makeResponse()
    const req = makeRequest(res, { contents: [{ role: 'user', parts: [{ functionResponse }] }] })
    req.params.modelName = 'gemini-test'
    req.path = '/v1beta/models/gemini-test:generateContent'
    axios.mockResolvedValue({ status: 200, headers: {}, data: stream ? Readable.from([]) : { candidates: [] } })
    if (stream) {
      await handleStandardStreamGenerateContent(req, res)
    } else {
      await handleStandardGenerateContent(req, res)
    }
    await res.completion
    expect(res.statusCode).toBe(200)
    expect(axios).toHaveBeenCalledTimes(1)
    expect(axios.mock.calls[0][0].data.contents[0].parts[0]).toEqual({ functionResponse })
  })
})


describe('Gemini UTF-8 success stream', () => {
  it.each([false, true])('normalizes cached input and reasoning, stream=%s', async (stream) => {
    apiKeyService.recordUsage.mockClear()
    const event = {
      candidates: [{ content: { parts: [{ text: '中文' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 900,
        candidatesTokenCount: 100, thoughtsTokenCount: 50, totalTokenCount: 1150 }
    }
    const res = makeResponse()
    const req = makeRequest(res, { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] })
    req.params.modelName = 'gemini-test'
    axios.mockResolvedValue({ status: 200, headers: {},
      data: stream ? Readable.from([Buffer.from(`data: ${JSON.stringify(event)}\n\n`)]) : event })
    await (stream ? handleStandardStreamGenerateContent : handleStandardGenerateContent)(req, res)
    await res.completion
    expect(apiKeyService.recordUsage.mock.calls[0][1]).toMatchObject({
      input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 100,
      reasoning_tokens: 50, reasoning_included_in_output: false
    })
  })

  it('keeps legacy UTF-8 and captures usage at EOF without a newline', async () => {
    apiKeyService.recordUsage.mockClear()
    const event = {
      candidates: [{ content: { parts: [{ text: '中文测试' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 900,
        candidatesTokenCount: 100, totalTokenCount: 1100 }
    }
    const wire = Buffer.from(`data: null\n\ndata: ${JSON.stringify(event)}`)
    const res = makeResponse()
    const bytes = []
    res.write.mockImplementation((chunk) => { bytes.push(Buffer.from(chunk)); return true })
    const req = makeRequest(res, { messages: [{ role: 'user', content: 'hello' }], stream: true })
    axios.mockResolvedValue({ status: 200, headers: {},
      data: Readable.from([...wire].map((byte) => Buffer.from([byte]))) })
    await handleMessages(req, res)
    await res.completion
    expect(res.body).toBeUndefined()
    expect(Buffer.concat(bytes).toString()).toBe(wire.toString())
    expect(apiKeyService.recordUsage.mock.calls[0][1]).toMatchObject({
      input_tokens: 100, cache_read_input_tokens: 900
    })
  })

  it('preserves multibyte content when the network splits every byte', async () => {
    const event = {
      candidates: [{ content: { parts: [{ text: '中文测试' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
    }
    const wire = Buffer.from(`data: ${JSON.stringify(event)}\n\n`)
    const res = makeResponse()
    const req = makeRequest(res, { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] })
    req.params.modelName = 'gemini-test'
    req.path = '/v1beta/models/gemini-test:streamGenerateContent'
    axios.mockResolvedValue({
      status: 200,
      headers: {},
      data: Readable.from([...wire].map((byte) => Buffer.from([byte])))
    })
    await handleStandardStreamGenerateContent(req, res)
    await res.completion
    const parser = new IncrementalSSEParser()
    expect(
      parser
        .feed(res.chunks.join(''))
        .filter((value) => value.type === 'data')
        .map((value) => value.data)
    ).toContainEqual(event)
    expect(res.chunks.join('')).not.toContain('\uFFFD')
  })
})

describe('Claude Console UTF-8 error stream', () => {
  const consoleResponse = () => {
    const res = makeResponse()
    res.req = makeRequest(res)
    res.writeHead = jest.fn(() => { res.headersSent = true })
    res.end = jest.fn((callback) => {
      res.writableEnded = true
      res.emit('finish')
      callback?.()
      res.finishResponse()
    })
    return res
  }
  const consoleEvents = () => Readable.from([
    'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":10}}}\n\n',
    'data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
    'data: {"type":"message_stop"}\n\n'
  ], { highWaterMark: 1 })
  const runConsole = (res, usageCallback) => claudeConsoleRelayService._makeClaudeConsoleStreamRequest(
    { model: 'claude-test', messages: [], stream: true },
    { ...account, apiUrl: 'https://example.invalid', apiKey: 'fixture' },
    null, {}, res, account.id, usageCallback
  )

  it('pauses a Console stream for downstream drain and reports final usage once', async () => {
    const res = consoleResponse()
    const source = consoleEvents()
    axios.mockResolvedValue({ status: 200, headers: {}, data: source })
    const { write } = res
    res.write = jest.fn((chunk) => { write(chunk); return res.chunks.length > 1 })
    const usageCallback = jest.fn()
    const completion = runConsole(res, usageCallback)
    await nextTick()
    expect(res.chunks).toHaveLength(1)
    expect(source.isPaused()).toBe(true)
    res.emit('drain')
    await completion
    expect(usageCallback).toHaveBeenCalledTimes(1)
    expect(usageCallback.mock.calls[0][0]).toMatchObject({ input_tokens: 10, output_tokens: 4 })
    expect(res.listenerCount('drain')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('continues Console usage collection after the blocked client disconnects', async () => {
    const res = consoleResponse()
    axios.mockResolvedValue({ status: 200, headers: {}, data: consoleEvents() })
    res.write.mockReturnValue(false)
    const usageCallback = jest.fn()
    const completion = runConsole(res, usageCallback)
    const rejected = expect(completion).rejects.toThrow('Client disconnected')
    await nextTick()
    res.destroyed = true
    res.emit('close')
    await rejected
    expect(usageCallback).toHaveBeenCalledTimes(1)
    expect(usageCallback.mock.calls[0][0].output_tokens).toBe(4)
    expect(res.listenerCount('drain')).toBe(0)
  })

  it('retains the complete Chinese error and context when every byte is a separate chunk', async () => {
    const message = '中文参数错误'
    const wire = Buffer.from(JSON.stringify({ error: { type: 'invalid_request_error', message } }))
    const res = makeResponse()
    res.writeHead = jest.fn((status) => {
         res.statusCode = status
         return res
       })
    const req = makeRequest(res, { model: 'claude-test', messages: [] })
    res.req = req
    axios.mockResolvedValue({
      status: 400,
      headers: {},
      data: Readable.from([...wire].map((byte) => Buffer.from([byte])))
    })
    await claudeConsoleRelayService._makeClaudeConsoleStreamRequest(
      req.body,
      { id: 'console', apiUrl: 'https://example.invalid', apiKey: 'fixture' },
      null,
      {},
      res,
      'console',
      jest.fn()
    )
    const parser = new IncrementalSSEParser()
    const errors = parser.feed(res.chunks.join('')).filter((event) => event.type === 'data')
    expect(errors[0].data.error.message).toContain(message)
    expect(res.chunks.join('')).not.toContain('\uFFFD')
  })
})

describe('Grok video reservation and settlement', () => {
  it('reserves the price calculation total after the customer rate', async () => {
    const reservation = await grokRelayService._reserveVideoCost(
      { id: 'key', dailyCostLimit: 10 },
      'grok-video',
      { duration: 6 }
    )
    expect(reservation.amount).toBe(6.5)
    expect(reserveCost.mock.calls[0][2]).toBe(6.5)
  })

  it('leaves processing polls unclaimed and unbilled', async () => {
    expect(
      await grokRelayService._claimVideoSettlement('key', 'task', { status: 'processing' })
    ).toBeNull()
    expect(videoDb.eval).not.toHaveBeenCalled()
  })

  it('captures submission without charging its estimate or a completed duplicate poll', async () => {
    const res = makeResponse()
    const req = makeRequest(res, { model: 'grok-video', duration: 6 })
    req._crsVideoTaskId = 'task'
    await grokRelayService._handleNormalResponse(
      { status: 200, headers: {}, data: { request_id: 'task', usage } },
      res,
      account,
      req.apiKey,
      'grok-video',
      req,
      { endpointKind: 'videos_generations' }
    )
    expect(apiKeyService.recordUsage).not.toHaveBeenCalled()
    const pollRes = makeResponse()
    const pollReq = makeRequest(pollRes, {})
    await grokRelayService._handleNormalResponse(
      { status: 200, headers: {}, data: { video: { url: 'fixture', duration: 3 }, usage } },
      pollRes,
      account,
      req.apiKey,
      'grok-video',
      pollReq,
      { endpointKind: 'video_status' }
    )
    expect(apiKeyService.recordUsage).not.toHaveBeenCalled()
  })

  it('retains billing inputs and the reservation when the completion ledger write fails', async () => {
    const res = makeResponse()
    const req = makeRequest(res, {})
    req._crsVideoSettlement = {
      requestId: 'task',
      key: 'fixture-video:task',
      settlementOwner: 'owner',
      model: 'grok-video',
      reservationId: 'reservation',
      billingUsage: '{"video_resolution":"720p","video_input_seconds":4}'
    }
    apiKeyService.recordUsage.mockRejectedValueOnce(new Error('ledger offline'))
    await grokRelayService._handleNormalResponse(
      { status: 200, headers: {}, data: { video: { url: 'fixture', duration: 3 } } },
      res,
      account,
      req.apiKey,
      'grok-video',
      req,
      { endpointKind: 'video_status' }
    )
    expect(apiKeyService.recordUsage.mock.calls[0][1]).toMatchObject({
      video_output_seconds: 3,
      video_input_seconds: 4,
      video_resolution: '720p'
    })
    expect(apiKeyService.recordUsage.mock.calls[0][5]).toMatchObject({
      throwOnBillingFailure: true,
      billingDedupTtl: 172800
    })
    expect(videoDb.hset).not.toHaveBeenCalled()
    expect(releaseCostReservation).not.toHaveBeenCalled()
    expect(videoDb.eval.mock.calls.at(-1).slice(1)).toEqual([1, 'fixture-video:task', 'owner'])
  })
})
