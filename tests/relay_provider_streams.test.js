import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { IncrementalSSEParser } from '../src/modules/relay/relay_sse_parser.js'

const axios = jest.fn()
const logger = new Proxy({}, { get: () => jest.fn() })
const apiKeyService = {
  recordUsage: jest.fn().mockResolvedValue({ realCost: 1, ratedCost: 1 }),
  hasPermission: jest.fn().mockReturnValue(true),
}
const requestDetailService = { captureUnmeteredRequest: jest.fn().mockResolvedValue({ captured: true }) }
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
  axios: { default: axios },
  '../config/config.js': { config: { requestTimeout: 1000, proxy: { timeout: 1000 } } },
  '../src/common/logger.js': { logger },
  '../src/infra/redis.js': { redis: {} },
  '../src/infra/redis_key.js': { RedisKeys: {} },
  '../src/modules/apikey/apikey_service.js': { apiKeyService },
  '../src/modules/account/account_grok_service.js': { grokAccountService },
  '../src/modules/account/account_openai_responses_service.js': { openaiResponsesAccountService },
  '../src/modules/account/account_gemini_service.js': {},
  '../src/modules/account/account_gemini_api_service.js': {
    geminiApiAccountService: { getAccount: jest.fn().mockResolvedValue(geminiAccount) },
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
  '../src/modules/pricing/pricing_service.js': { pricingService: {} },
  '../src/modules/relay/relay_rate_limit_helper.js': { updateRateLimitCounters: jest.fn() },
  '../src/modules/relay/relay_upstream_protocol_guard.js': {
    isNonProtocolUpstreamBody: jest.fn(),
    handleNonProtocolUpstream: jest.fn(),
  },
  '../src/modules/relay/relay_openai_compact_v2.js': { applyOpenAIServiceTierAlias: jest.fn() },
  '../src/modules/relay/relay_openai_model_alias.js': { applyOpenAIPublicModelAlias: jest.fn() },
  '../src/modules/relay/relay_codex_bootstrap_normalize.js': { normalizeCodexBootstrapBody: jest.fn() },
  '../src/modules/relay/relay_gemini_relay_service.js': {
    sendGeminiRequest: jest.fn(),
    getAvailableModels: jest.fn(),
  },
  '../src/modules/relay/relay_antigravity_relay_service.js': { sendAntigravityRequest: jest.fn() },
  '../src/modules/relay/relay_session_helper.js': {
    sessionHelper: { generateSessionHash: () => 'fixture-session' },
  },
  '../src/modules/relay/translator/relay_translator_interactions.js': {},
}
for (const [name, exports] of Object.entries(modules)) {
  jest.unstable_mockModule(name, () => exports)
}

const { grokRelayService } = await import('../src/modules/relay/relay_grok_relay_service.js')
const { CodexToOpenAIConverter } = await import('../src/modules/relay/relay_codex_to_openai.js')
const { openaiResponsesRelayService } = await import('../src/modules/relay/relay_openai_responses_relay_service.js')
const { handleStandardGenerateContent, handleStandardStreamGenerateContent } =
  await import('../src/modules/relay/relay_gemini_handlers_routes.js')

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
  res.end = jest.fn(() => {
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

beforeEach(() => {
  jest.clearAllMocks()
  axios.mockReset()
})

describe('Grok forwarding contracts', () => {
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
