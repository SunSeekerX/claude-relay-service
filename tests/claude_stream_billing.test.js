import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { gzipSync, deflateSync } from 'node:zlib'
import { ClaudeStreamState } from '../src/modules/relay/relay_claude_stream_state.js'
import { IncrementalSSEParser } from '../src/modules/relay/relay_sse_parser.js'
import { httpRequestStats } from '../src/common/http_request_stats.js'
import {
  createRequestDetailMeta,
  finalizeRequestDetailMeta
} from '../src/modules/relay/relay_request_detail_helper.js'

const axios = jest.fn()
const httpsRequest = jest.fn()
const logger = new Proxy({}, { get: () => jest.fn() })
const captureUnmeteredRequest = jest.fn().mockResolvedValue({ captured: true })
const claudeAccountService = {
  getAccount: jest.fn().mockResolvedValue({ id: 'account', name: 'fixture' }),
  clearInternalErrors: jest.fn().mockResolvedValue(),
  isAccountOverloaded: jest.fn().mockResolvedValue(false),
  removeAccountOverload: jest.fn().mockResolvedValue(),
  updateSessionWindowStatus: jest.fn().mockResolvedValue(),
  markAccountModelRateLimited: jest.fn().mockResolvedValue()
}
const claudeConsoleAccountService = {
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  removeAccountRateLimit: jest.fn().mockResolvedValue(),
  isAccountOverloaded: jest.fn().mockResolvedValue(false),
  removeAccountOverload: jest.fn().mockResolvedValue()
}
const scheduler = {
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  removeAccountRateLimit: jest.fn().mockResolvedValue(),
  markAccountRateLimited: jest.fn().mockResolvedValue()
}
const recordErrorHistory = jest.fn().mockResolvedValue()
const mocks = {
  axios: { default: axios },
  'node:https': { default: { request: httpsRequest } },
  '../config/config.js': {
    config: { requestTimeout: 1000, claude: { apiVersion: '2023-06-01' } }
  },
  '../src/common/logger.js': { logger },
  '../src/infra/redis.js': { redis: { client: { del: jest.fn().mockResolvedValue(1) } } },
  '../src/common/performance_optimizer.js': {
    getHttpsAgentForStream: () => null,
    getHttpsAgentForNonStream: () => null,
    getPricingData: () => null
  },
  '../src/modules/account/account_claude_service.js': { claudeAccountService },
  '../src/modules/account/account_claude_console_service.js': { claudeConsoleAccountService },
  '../src/modules/relay/relay_unified_claude_scheduler.js': { unifiedClaudeScheduler: scheduler },
  '../src/modules/relay/relay_claude_code_headers_service.js': { claudeCodeHeadersService: {} },
  '../src/modules/relay/relay_request_detail_service.js': {
    requestDetailService: { captureUnmeteredRequest }
  },
  '../src/modules/relay/relay_upstream_error_helper.js': {
    buildErrorContext: (context) => context,
    recordErrorHistory,
    markTempUnavailable: jest.fn().mockResolvedValue(),
    parseRetryAfter: () => null
  },
  '../src/modules/proxy/proxy_resolver.js': { proxyResolver: {} },
  '../src/modules/proxy/proxy_helper.js': { ProxyHelper: {} },
  '../src/modules/user/user_message_queue_service.js': { userMessageQueueService: {} },
  '../src/common/test_payload_helper.js': {
    createClaudeTestPayload: jest.fn(),
    sendStreamTestRequest: jest.fn()
  }
}
for (const [name, exports] of Object.entries(mocks)) {
  jest.unstable_mockModule(name, () => exports)
}
const { claudeRelayService } = await import('../src/modules/relay/relay_claude_relay_service.js')
const { claudeConsoleRelayService } =
  await import('../src/modules/relay/relay_claude_console_relay_service.js')
const { openaiToClaude } = await import('../src/modules/relay/relay_openai_to_claude.js')
const { createClaudeStreamFinalizer } =
  await import('../src/modules/relay/relay_claude_stream_usage.js')
const nextTick = () => new Promise((resolve) => setImmediate(resolve))
const start = {
  type: 'message_start',
  message: { model: 'claude-test', usage: { input_tokens: 10, output_tokens: 1 } }
}
const delta = (output, usage = {}) => ({
  type: 'message_delta',
  usage: { output_tokens: output, ...usage }
})
const stop = { type: 'message_stop' }
const wire = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
const sourceFrom = (events) => Readable.from([Buffer.from(wire(events))])

const makeResponse = () => {
  const res = new EventEmitter()
  Object.assign(res, {
    statusCode: 200,
    headersSent: false,
    destroyed: false,
    writableEnded: false
  })
  res.chunks = []
  res.req = { apiKey: { id: 'key' }, _crsRecordRelayResult: jest.fn() }
  res.writeHead = jest.fn((status) => {
    res.statusCode = status
    res.headersSent = true
  })
  res.write = jest.fn((chunk) => {
    res.headersSent = true
    res.chunks.push(String(chunk))
    return true
  })
  res.end = jest.fn((callback) => {
    res.writableEnded = true
    res.emit('finish')
    callback?.()
  })
  return res
}

const run = (provider, res, source, usageCallback, transformer = null, encoding = null) => {
  const headers = encoding ? { 'content-encoding': encoding } : {}
  if (provider === 'console') {
    axios.mockResolvedValue({ status: 200, headers, data: source })
    return claudeConsoleRelayService._makeClaudeConsoleStreamRequest(
      { model: 'claude-test', messages: [], stream: true },
      { apiUrl: 'https://example.invalid', apiKey: 'fixture', disableAutoProtection: true },
      null,
      {},
      res,
      'account',
      usageCallback,
      transformer
    )
  }
  httpsRequest.mockImplementation((_options, onResponse) => {
    const req = new EventEmitter()
    req.write = jest.fn()
    req.destroy = jest.fn(() => {
      source.destroy()
    })
    req.end = jest.fn(() => {
      source.statusCode = 200
      source.headers = headers
      source.on('end', () => {
        source.complete = true
      })
      queueMicrotask(() => {
        void onResponse(source)
      })
    })
    return req
  })
  return claudeRelayService._makeClaudeStreamRequestWithUsageCapture(
    { model: 'claude-test', messages: [], stream: true },
    'fixture-token',
    null,
    {},
    res,
    usageCallback,
    'account',
    'claude-official',
    null,
    transformer
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  httpRequestStats.reset()
  axios.mockReset()
  jest.spyOn(claudeRelayService, '_prepareRequestHeadersAndPayload').mockResolvedValue({
    bodyString: '{}',
    headers: {},
    toolNameMap: new Map()
  })
})
afterEach(() => {
  jest.restoreAllMocks()
  openaiToClaude.streamUsage.clear()
})

for (const provider of ['official', 'console']) {
  describe(`${provider} Claude stream accounting`, () => {
    it('bills the last cumulative snapshot exactly once, including corrected input and caches', async () => {
      const res = makeResponse()
      const callback = jest.fn()
      await run(
        provider,
        res,
        sourceFrom([
          start,
          delta(4),
          delta(9, {
            input_tokens: 20,
            cache_creation_input_tokens: 11,
            cache_read_input_tokens: 30,
            cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 6 },
            speed: 'fast'
          }),
          stop,
          delta(99),
          stop
        ]),
        callback
      )
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          input_tokens: 20,
          output_tokens: 9,
          cache_creation_input_tokens: 11,
          cache_read_input_tokens: 30,
          speed: 'fast',
          model: 'claude-test',
          accountId: 'account',
          cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 6 }
        }),
        { statusCode: 200, errorCode: null, errorMessage: null, protocolTerminal: 'message_stop' },
      )
      expect(res.req._crsRecordRelayResult).toHaveBeenLastCalledWith(
        expect.objectContaining({
          statusCode: 200,
          hasUsage: true,
          final: true
        })
      )
      expect(res.chunks.join('')).not.toContain('99')
    })

    it('meters an explicit zero output without treating initial output as final', async () => {
      const callback = jest.fn()
      await run(provider, makeResponse(), sourceFrom([start, delta(0), stop]), callback)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][0]).toMatchObject({ input_tokens: 10, output_tokens: 0 })
    })

    it('accepts nullable official delta fields while retaining previously reported input and caches', async () => {
      const callback = jest.fn()
      await run(
        provider,
        makeResponse(),
        sourceFrom([
          {
            ...start,
            message: {
              ...start.message,
              usage: {
                input_tokens: 10,
                output_tokens: 1,
                cache_creation_input_tokens: 3,
                cache_read_input_tokens: 4,
                cache_creation: null
              }
            }
          },
          delta(4),
          delta(9, {
            input_tokens: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null
          }),
          stop
        ]),
        callback
      )
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][0]).toMatchObject({
        input_tokens: 10,
        output_tokens: 9,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4
      })
    })

    it.each([true, false])(
      'does not bill message_start alone, with message_stop=%s',
      async (hasStop) => {
        const res = makeResponse()
        const callback = jest.fn()
        await run(provider, res, sourceFrom(hasStop ? [start, stop] : [start]), callback)
        expect(callback).not.toHaveBeenCalled()
        expect(captureUnmeteredRequest).toHaveBeenCalledTimes(1)
        expect(captureUnmeteredRequest.mock.calls[0][1]).toMatchObject({
          accountId: 'account',
          apiKeyId: 'key',
          result: { statusCode: hasStop ? 200 : 502 }
        })
      }
    )

    it('bills reported usage at truncated EOF and emits one protocol failure', async () => {
      const res = makeResponse()
      const callback = jest.fn()
      await run(provider, res, sourceFrom([start, delta(4), delta(9)]), callback)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][0].output_tokens).toBe(9)
      expect(callback.mock.calls[0][1]).toMatchObject({
        statusCode: 502,
        errorCode: 'upstream_stream_incomplete',
        protocolTerminal: 'error',
      })
      const errors = new IncrementalSSEParser()
        .feed(res.chunks.join(''))
        .filter((event) => event.type === 'data' && event.data.type === 'error')
      expect(errors).toHaveLength(1)
      expect(claudeAccountService.clearInternalErrors).not.toHaveBeenCalled()
      expect(claudeConsoleAccountService.removeAccountRateLimit).not.toHaveBeenCalled()
    })

    it('keeps HTTP 200 separate from a sanitized overloaded stream failure', async () => {
      const res = makeResponse()
      const callback = jest.fn()
      await run(
        provider,
        res,
        sourceFrom([
          start,
          delta(4),
          delta(9),
          {
            type: 'error',
            error: { type: 'overloaded_error', message: 'Busy sk-ant-secret-12345678' }
          },
          stop
        ]),
        callback
      )
      expect(res.statusCode).toBe(200)
      expect(callback.mock.calls[0][0].output_tokens).toBe(9)
      expect(callback.mock.calls[0][1]).toMatchObject({
        statusCode: 529,
        errorCode: 'overloaded_error'
      })
      expect(res.req._crsRecordRelayResult).toHaveBeenLastCalledWith(
        expect.objectContaining({
          statusCode: 529,
          hasUsage: true,
          final: true
        })
      )
      expect(res.chunks.join('')).not.toContain('sk-ant-secret-12345678')
      expect(res.chunks.join('')).not.toContain('message_stop')
    })

    it('carries the failed terminal through request-detail metadata and HTTP monitoring', async () => {
      const res = makeResponse()
      res.req.originalUrl = '/api/v1/messages'
      res.req.res = res
      httpRequestStats.observe(res.req, res)
      const callback = jest.fn((_usage, result) => {
        const meta = createRequestDetailMeta(res.req, { stream: true, ...result })
        expect(meta).toMatchObject({ statusCode: 529, errorCode: 'overloaded_error', protocolTerminal: 'error' })
        finalizeRequestDetailMeta(meta)
      })
      await run(
        provider,
        res,
        sourceFrom([
          start,
          delta(9),
          { type: 'error', error: { type: 'overloaded_error', message: 'Busy' } }
        ]),
        callback
      )
      expect(callback).toHaveBeenCalledTimes(1)
      expect(httpRequestStats.getStats()).toMatchObject({
        requests: 1,
        http: { completed: 1, disconnected: 0, status2xx: 1 },
        relay: { total: 1, completed: 0, failed: 1, unmetered: 0 }
      })
    })

    it('recognizes typed rate-limit errors without requiring a particular message', async () => {
      const callback = jest.fn()
      await run(
        provider,
        makeResponse(),
        sourceFrom([
          start,
          delta(9),
          { type: 'error', error: { type: 'rate_limit_error', message: 'Retry later' } }
        ]),
        callback
      )
      expect(callback.mock.calls[0][1]).toMatchObject({
        statusCode: 429,
        errorCode: 'rate_limit_error'
      })
      expect(scheduler.removeAccountRateLimit).not.toHaveBeenCalled()
      if (provider === 'official') {
        expect(recordErrorHistory).toHaveBeenCalledWith(
          'account',
          'claude-official',
          429,
          'rate_limit',
          expect.any(Object)
        )
      }
    })

    it('meters the last reported usage when the transport fails and releases the Promise', async () => {
      const res = makeResponse()
      const source = new PassThrough()
      const callback = jest.fn()
      const completion = run(provider, res, source, callback)
      const rejected = expect(completion).rejects.toThrow('fixture transport error')
      await nextTick()
      source.write(wire([start, delta(4), delta(9)]))
      source.destroy(new Error('fixture transport error'))
      await rejected
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][0].output_tokens).toBe(9)
      expect(callback.mock.calls[0][1]).toMatchObject({
        statusCode: 502,
        errorCode: 'upstream_stream_error'
      })
      expect(res.writableEnded).toBe(true)
      expect(res.listenerCount('close')).toBe(0)
    })

    it('drains usage after the client disconnects instead of estimating or double billing', async () => {
      const res = makeResponse()
      const source = new PassThrough()
      const callback = jest.fn()
      const completion = run(provider, res, source, callback)
      const settled =
        provider === 'console'
          ? expect(completion).rejects.toThrow('Client disconnected')
          : completion
      await nextTick()
      source.write(wire([start, delta(4)]))
      res.destroyed = true
      res.emit('close')
      source.end(wire([delta(9), stop]))
      await settled
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][0].output_tokens).toBe(9)
      expect(callback.mock.calls[0][1].statusCode).toBe(200)
      expect(res.chunks.join('')).not.toContain('message_stop')
    })

    it('settles at message_stop without waiting for upstream EOF and awaits billing', async () => {
      const res = makeResponse()
      const source = new PassThrough()
      let finishBilling
      const callback = jest.fn(
        () =>
          new Promise((resolve) => {
            finishBilling = resolve
          })
      )
      const completion = run(provider, res, source, callback)
      await nextTick()
      source.write(wire([start, delta(4), delta(9), stop]))
      await nextTick()
      expect(callback).toHaveBeenCalledTimes(1)
      expect(res.writableEnded).toBe(false)
      finishBilling()
      await completion
      expect(source.destroyed).toBe(true)
      expect(res.writableEnded).toBe(true)
    })

    it('handles UTF-8, CRLF and multiline data across arbitrary byte boundaries', async () => {
      const res = makeResponse()
      const content = JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '中文' }
      })
      const text = [
        wire([start]),
        `event: content_block_delta\r\ndata:${content}\r\n\r\n`,
        'event: message_delta\ndata:{"type":"message_delta",\ndata:"usage":{"output_tokens":9}}\n\n',
        wire([stop])
      ].join('')
      const callback = jest.fn()
      await run(
        provider,
        res,
        Readable.from([...Buffer.from(text)].map((byte) => Buffer.from([byte]))),
        callback
      )
      expect(callback.mock.calls[0][0].output_tokens).toBe(9)
      expect(res.chunks.join('')).toContain('中文')
      expect(res.chunks.join('')).not.toContain('\uFFFD')
    })

    it('returns an OpenAI error envelope without DONE when the Claude stream fails', async () => {
      const res = makeResponse()
      const callback = jest.fn()
      const transformer = (chunk) =>
        openaiToClaude.convertStreamChunk(chunk, 'claude-test', provider)
      await run(
        provider,
        res,
        sourceFrom([
          start,
          delta(9),
          { type: 'error', error: { type: 'overloaded_error', message: 'Busy' } }
        ]),
        callback,
        transformer
      )
      const events = new IncrementalSSEParser().feed(res.chunks.join(''))
      expect(events.at(-1).data.error).toMatchObject({ message: expect.any(String) })
      expect(events.at(-1).data.type).toBeUndefined()
      expect(res.chunks.join('')).not.toContain('[DONE]')
      expect(callback.mock.calls[0][1].statusCode).toBe(529)
    })

    it('records conversion errors as failures even if the upstream terminal was complete', async () => {
      const res = makeResponse()
      const callback = jest.fn()
      await expect(
        run(provider, res, sourceFrom([start, delta(9), stop]), callback, () => {
          throw new Error('fixture conversion error')
        })
      ).rejects.toThrow('fixture conversion error')
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][1]).toMatchObject({
        statusCode: 502,
        errorCode: 'stream_processing_error'
      })
    })
  })
}

describe('native Claude backpressure', () => {
  it('pauses generation reads until the client drains, then bills the last cumulative usage', async () => {
    const res = makeResponse()
    const source = new PassThrough()
    const callback = jest.fn()
    const { write } = res
    res.writableNeedDrain = true
    res.write = jest.fn((chunk) => { write(chunk); return false })
    const completion = run('official', res, source, callback)
    await nextTick()
    source.write(wire([start, delta(4)]))
    expect(source.isPaused()).toBe(true)
    source.write(wire([delta(9), stop]))
    await nextTick()
    expect(callback).not.toHaveBeenCalled()
    res.writableNeedDrain = false
    res.write = jest.fn((chunk) => { write(chunk); return true })
    res.emit('drain')
    await completion
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0].output_tokens).toBe(9)
    expect(res.listenerCount('drain')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('resumes paused upstream reads when the client disconnects and still settles once', async () => {
    const res = makeResponse()
    const source = new PassThrough()
    const callback = jest.fn()
    res.writableNeedDrain = true
    res.write.mockReturnValue(false)
    const completion = run('official', res, source, callback)
    await nextTick()
    source.write(wire([start, delta(4)]))
    source.write(wire([delta(9), stop]))
    expect(source.isPaused()).toBe(true)
    res.destroyed = true
    res.emit('close')
    await completion
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0].output_tokens).toBe(9)
    expect(res.listenerCount('drain')).toBe(0)
  })

  it('releases a paused stream after upstream failure without waiting for client drain', async () => {
    const res = makeResponse()
    const source = new PassThrough()
    const callback = jest.fn()
    res.writableNeedDrain = true
    res.write.mockReturnValue(false)
    const completion = run('official', res, source, callback)
    const rejected = expect(completion).rejects.toThrow('fixture failure')
    await nextTick()
    source.write(wire([start, delta(4)]))
    source.destroy(new Error('fixture failure'))
    await rejected
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0].output_tokens).toBe(4)
    expect(res.listenerCount('drain')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })
})

describe('Claude stream state validation and shared finalization', () => {
  it('passes message_stop through billing metadata and preserves once-only finalization', async () => {
    const state = new ClaudeStreamState()
    state.observe(start)
    state.observe(delta(9))
    state.observe(stop)
    const req = { requestId: 'terminal-fixture' }
    const callback = jest.fn((_usage, result) => {
      expect(createRequestDetailMeta(req, result).protocolTerminal).toBe('message_stop')
    })
    const finalize = createClaudeStreamFinalizer({
      state,
      usageCallback: callback,
      clientRequest: req,
      accountId: 'account',
    })
    await finalize()
    await finalize(new Error('late close'))
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][1]).toMatchObject({ statusCode: 200, protocolTerminal: 'message_stop' })
    expect(req._crsProtocolTerminal).toBe('message_stop')
  })
  it.each([null, -1, '9', 1.5, Number.NaN])('rejects invalid output snapshot %s', (invalid) => {
    const state = new ClaudeStreamState()
    state.observe(start)
    state.observe(delta(4))
    state.observe(delta(invalid, { input_tokens: 99 }))
    state.observe(stop)
    expect(state.getUsage()).toMatchObject({ input_tokens: 10, output_tokens: 4 })
  })

  it('does not invent input usage when only an output count was reported', () => {
    const state = new ClaudeStreamState({ model: 'claude-test' })
    state.observe(delta(9))
    state.observe(stop)
    expect(state.getUsage()).toBeNull()
  })

  it('shares one finalization Promise across terminal, EOF and transport callbacks', async () => {
    const state = new ClaudeStreamState()
    state.observe(start)
    state.observe(delta(9))
    state.observe(stop)
    const callback = jest.fn()
    const finalize = createClaudeStreamFinalizer({
      state,
      usageCallback: callback,
      accountId: 'account'
    })
    const first = finalize()
    expect(finalize(new Error('late close'))).toBe(first)
    await first
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('retains speed and cache buckets from the start when later cumulative deltas omit them', () => {
    const state = new ClaudeStreamState()
    state.observe({
      ...start,
      message: {
        ...start.message,
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 11,
          cache_read_input_tokens: 30,
          cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 6 },
          speed: 'fast'
        }
      }
    })
    state.observe(delta(4))
    state.observe(delta(9))
    expect(state.getUsage()).toMatchObject({
      input_tokens: 10,
      output_tokens: 9,
      speed: 'fast',
      cache_creation_input_tokens: 11,
      cache_read_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 6 }
    })
  })

  it('converts multiline Claude data to Chat chunks with one terminal DONE', () => {
    const text =
      `${wire([start])}data:{"type":"content_block_delta",` +
      `\ndata:"delta":{"type":"text_delta","text":"中文"}}\n\n${wire([delta(9), stop])}`
    const converted = openaiToClaude.convertStreamChunk(text, 'claude-test', 'multiline')
    expect(converted).toContain('中文')
    expect(converted.match(/\[DONE\]/g)).toHaveLength(1)
    expect(openaiToClaude.streamUsage.has('multiline')).toBe(false)
  })

  it.each(['gzip', 'deflate'])(
    'meters native %s responses using the decoded events',
    async (encoding) => {
      const res = makeResponse()
      const callback = jest.fn()
      const bytes = Buffer.from(wire([start, delta(4), delta(9), stop]))
      const compressed = encoding === 'gzip' ? gzipSync(bytes) : deflateSync(bytes)
      await run('official', res, Readable.from([compressed]), callback, null, encoding)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][0].output_tokens).toBe(9)
    }
  )
})
