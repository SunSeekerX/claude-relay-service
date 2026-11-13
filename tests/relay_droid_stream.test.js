import { jest, expect, test } from '@jest/globals'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { IncrementalSSEParser } from '../src/modules/relay/relay_sse_parser.js'
import { ClaudeStreamState } from '../src/modules/relay/relay_claude_stream_state.js'
import { ResponsesStreamState } from '../src/modules/relay/relay_responses_stream_state.js'
import { onClientDisconnect } from '../src/common/client_disconnect.js'
import { createStreamBackpressure } from '../src/common/stream_helper.js'
import { buildClientError } from '../src/common/client_error_builder.js'
import { createRequestDetailMeta, resolveOpenAIServiceTier } from '../src/modules/relay/relay_request_detail_helper.js'

test.each([
  ['comm', true],
  ['openai', true],
  ['anthropic', true],
  ['openai', false],
])(
  'Droid %s reads fragmented native SSE once and preserves its real terminal (complete=%s)',
  async (dialect, complete) => {
    let events
    if (dialect === 'anthropic') {
      events = [
        { type: 'message_start', message: { usage: { input_tokens: 2, cache_read_input_tokens: 8 } } },
        { type: 'message_delta', usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
    } else if (dialect === 'openai') {
      events = [
        { type: 'response.created', response: { model: 'test' } },
        {
          type: 'response.completed',
          response: {
            model: 'test',
            service_tier: 'priority',
            usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 8 }, output_tokens: 1 },
          },
        },
      ]
    } else {
      events = [
        { choices: [{ delta: { content: '你好' }, finish_reason: null }] },
        {
          usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens: 1 },
          choices: [{ finish_reason: 'stop' }],
        },
      ]
    }
    if (!complete) {
      events.pop()
    }
    const wire = Buffer.from(events.map((event) => `data:${JSON.stringify(event)}\r\n\r\n`).join(''))
    const source = fs.readFileSync(
      new URL('../src/modules/relay/relay_droid_relay_service.js', import.meta.url),
      'utf8',
    )
    const start = source.indexOf('  async _handleStreamRequest(')
    const method = source.slice(start, source.indexOf('  async _recordUsageFromStreamData(', start))
    const upstream = Readable.from([...wire].map((byte) => Buffer.from([byte])))
    upstream.statusCode = 200
    upstream.complete = true
    const service = new vm.Script(`({${method}})`).runInNewContext({
      Buffer,
      URL,
      AbortController,
      IncrementalSSEParser,
      ClaudeStreamState,
      ResponsesStreamState,
      onClientDisconnect,
      createStreamBackpressure,
      buildClientError,
      createRequestDetailMeta,
      resolveOpenAIServiceTier,
      logger: new Proxy({}, { get: () => () => {} }),
      https: {
        request: (_options, accept) => {
          const request = new EventEmitter()
          request.end = () => queueMicrotask(() => accept(upstream))
          request.destroy = () => {}
          return request
        },
      },
    })
    service._recordUsageFromStreamData = jest.fn(async () => ({ normalizedUsage: {}, costs: {} }))
    service._applyRateLimitTracking = jest.fn().mockResolvedValue()
    const chunks = []
    const target = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk))
        done()
      },
    })
    target.setHeader = () => {}
    const result = await service._handleStreamRequest(
      'https://fixture.invalid',
      {},
      {},
      null,
      {},
      target,
      { id: 'account' },
      { id: 'key' },
      { model: 'test', ...(dialect !== 'anthropic' ? { service_tier: 'priority' } : {}) },
      dialect,
    )
    expect(result.statusCode).toBe(complete ? 200 : 502)
    expect(service._recordUsageFromStreamData).toHaveBeenCalledTimes(1)
    expect(service._recordUsageFromStreamData.mock.calls[0][5]).toBe(dialect)
    expect(Buffer.concat(chunks).subarray(0, wire.length).equals(wire)).toBe(true)
    if (dialect === 'openai' && complete) {
      expect(service._recordUsageFromStreamData.mock.calls[0][0].input_tokens).toBe(10)
      expect(service._recordUsageFromStreamData.mock.calls[0][4].serviceTier).toBe('priority')
    }
  },
)
