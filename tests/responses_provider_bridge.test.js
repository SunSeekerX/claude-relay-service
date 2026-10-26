import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import {
  buildResponsesProviderRequest,
  ProviderResponsesState
} from '../src/modules/relay/relay_responses_conversion.js'
import { adaptResponsesTools } from '../src/modules/relay/relay_responses_tools.js'

const contexts = new Map()
const save = jest.fn(async (scope, id, value) =>
  contexts.set(`${scope}:${id}`, JSON.parse(JSON.stringify(value)))
)
jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: {
    getResponsesContext: async (scope, id) => contexts.get(`${scope}:${id}`) ?? null,
    saveResponsesContext: save
  }
}))
jest.unstable_mockModule('../src/modules/relay/relay_request_detail_service.js', () => ({
  requestDetailService: { getSettings: async () => ({ retentionHours: 6 }) }
}))
jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
}))
const { relayResponsesViaProvider } =
  await import('../src/modules/relay/relay_responses_gateway.js')
const claude = {
  type: 'message',
  content: [{ type: 'text', text: '你好' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 4,
    output_tokens: 7
  }
}
const gemini = {
  candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }],
  usageMetadata: {
    promptTokenCount: 50,
    cachedContentTokenCount: 30,
    candidatesTokenCount: 7,
    thoughtsTokenCount: 3
  }
}
let handler
const app = express()
  .use(express.json())
  .use('/:provider', (req, res) => {
    const provider = req.params.provider
    req.apiKey = {
      id: req.headers['x-fixture-key'] ?? 'key1',
      permissions: req.headers['x-fixture-deny'] ? ['openai'] : [provider]
    }
    return relayResponsesViaProvider(req, res, { provider, handle: handler })
  })
beforeEach(() => {
  contexts.clear()
  save.mockClear()
  handler = jest.fn(async (req, res) =>
    res.json(req.params.provider === 'gemini' ? gemini : claude)
  )
})
const makeState = (provider = 'claude', tools = []) =>
  new ProviderResponsesState(provider, 'model', adaptResponsesTools({ tools }))

describe('reverse Responses HTTP contracts', () => {
  test.each(['claude', 'gemini'])(
    'converts %s JSON and records the exact retained context without another upstream call',
    async (provider) => {
      const response = await request(app)
        .post(`/${provider}/v1/responses`)
        .send({ model: 'model', input: 'hello' })
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }]
      })
      expect(response.body.usage).toMatchObject(
        provider === 'gemini'
          ? { input_tokens: 50, output_tokens: 10, total_tokens: 60 }
          : { input_tokens: 54, output_tokens: 7, total_tokens: 61 }
      )
      expect(handler).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledWith(
        expect.any(String),
        response.body.id,
        expect.objectContaining({ input: expect.any(Array) }),
        6
      )
    }
  )
  test('continuation is scoped to API key and resolves parent history once', async () => {
    const first = await request(app)
      .post('/claude/v1/responses')
      .send({ model: 'model', input: 'first' })
    const next = await request(app)
      .post('/claude/v1/responses')
      .send({ model: 'model', previous_response_id: first.body.id, input: 'next' })
    expect(next.status).toBe(200)
    const sent = handler.mock.calls[1][0]
    expect(sent.apiKey.id).toBe('key1')
    expect([...contexts.values()].at(-1).input).toHaveLength(4)
    const other = await request(app)
      .post('/claude/v1/responses')
      .set('x-fixture-key', 'key2')
      .send({ model: 'model', previous_response_id: first.body.id, input: 'next' })
    expect(other.status).toBe(400)
    expect(other.body.error.code).toBe('previous_response_not_found')
    expect(handler).toHaveBeenCalledTimes(2)
  })
  test('honors store:false and refuses missing or expired response IDs', async () => {
    const first = await request(app)
      .post('/claude/v1/responses')
      .send({ model: 'model', input: 'first', store: false })
    expect(save).not.toHaveBeenCalled()
    const next = await request(app)
      .post('/claude/v1/responses')
      .send({ model: 'model', previous_response_id: first.body.id, input: 'next' })
    expect(next.status).toBe(400)
  })
  test('compact makes one billed generation and returns a replayable plaintext window', async () => {
    handler = jest.fn(async (req, res) => {
      expect(req.body.stream).toBe(false)
      expect(JSON.stringify(req.body)).toContain('Summarize this conversation')
      res.json(claude)
    })
    const response = await request(app)
      .post('/claude/v1/responses/compact')
      .send({ model: 'model', input: 'context', stream: true })
    expect(response.body.object).toBe('response.compaction')
    expect(response.body.output[0].content[0].text).toBe('你好')
    expect(JSON.stringify(response.body)).not.toContain('encrypted_content')
    expect(response.body.usage.output_tokens).toBe(7)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })
  test('rejects permissions, foreign file IDs and opaque compaction before calling a provider', async () => {
    expect(
      (
        await request(app)
          .post('/claude/v1/responses')
          .set('x-fixture-deny', '1')
          .send({ model: 'm', input: 'x' })
      ).status
    ).toBe(403)
    for (const input of [
      [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_file', file_id: 'file-other-provider' }]
        }
      ],
      [{ type: 'compaction', encrypted_content: 'opaque' }]
    ]) {
      expect(
        (await request(app).post('/claude/v1/responses').send({ model: 'm', input })).status
      ).toBe(400)
    }
    expect(handler).not.toHaveBeenCalled()
  })
  test('streaming survives arbitrary UTF-8 splits and emits one sequenced terminal response', async () => {
    handler = jest.fn(async (_req, res) => {
      res.set('content-type', 'text/event-stream')
      const events = [
        { type: 'message_start', message: { usage: claude.usage } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
        { type: 'message_stop' }
      ]
      const bytes = Buffer.from(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
      )
      for (let index = 0; index < bytes.length; index += 2)
        res.write(bytes.subarray(index, index + 2))
      res.end()
    })
    const response = await request(app)
      .post('/claude/v1/responses')
      .send({ model: 'm', input: 'hello', stream: true })
    const events = response.text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
    expect(events.at(-1).type).toBe('response.completed')
    expect(events.filter((event) => event.type === 'response.completed')).toHaveLength(1)
    expect(
      events
        .filter((event) => event.type === 'response.output_text.delta')
        .map((event) => event.delta)
        .join('')
    ).toBe('你好')
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index))
    expect(handler).toHaveBeenCalledTimes(1)
  })
  test('truncated streaming never emits completed and retains the reported usage', async () => {
    handler = jest.fn(async (_req, res) => {
      res.set('content-type', 'text/event-stream')
      res.end(
        `data: ${JSON.stringify({ type: 'message_start', message: { usage: claude.usage } })}\n\n`
      )
    })
    const response = await request(app)
      .post('/claude/v1/responses')
      .send({ model: 'm', input: 'hello', stream: true })
    expect(response.text).toContain('response.failed')
    expect(response.text).not.toContain('response.completed')
    expect(save).not.toHaveBeenCalled()
  })
})

describe('provider conversion and tool fidelity', () => {
  test.each(['claude', 'gemini'])(
    'preserves PDF/image inputs and structured tool outputs for %s',
    (provider) => {
      const body = {
        model: 'm',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_file',
                file_data: 'data:application/pdf;base64,JVBERg==',
                filename: 'a.pdf'
              },
              { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }
            ]
          },
          { type: 'function_call', call_id: 'call1', name: 'read', arguments: '{}' },
          {
            type: 'function_call_output',
            call_id: 'call1',
            output: [
              { type: 'input_text', text: 'result' },
              { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }
            ]
          }
        ],
        tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }]
      }
      const { request: native } = buildResponsesProviderRequest(body, provider)
      const text = JSON.stringify(native)
      expect(text).toContain('JVBERg==')
      expect(text).toContain('aGVsbG8=')
      expect(text).toContain('call1')
      expect(text).toContain('result')
    }
  )
  test('interleaved tool streams keep distinct call IDs, namespaces and argument ownership', () => {
    const state = makeState('claude', [
      { type: 'namespace', name: 'fs', tools: [{ type: 'function', name: 'read', parameters: {} }] }
    ])
    state.addBlock(0, { type: 'tool_use', id: 'a', name: 'fs__read' })
    state.addBlock(1, { type: 'tool_use', id: 'b', name: 'fs__read' })
    state.delta(1, { partial_json: '{"b":2}' })
    state.delta(0, { partial_json: '{"a":1}' })
    state.close(1)
    state.close(0)
    state.ended = true
    expect(state.finish().response.output).toMatchObject([
      { call_id: 'a', namespace: 'fs', name: 'read', arguments: '{"a":1}' },
      { call_id: 'b', namespace: 'fs', name: 'read', arguments: '{"b":2}' }
    ])
  })
  test('private signatures produced by this bridge survive provider-matching replay', () => {
    const state = makeState()
    state.fromMessage({
      ...claude,
      content: [
        { type: 'thinking', thinking: 'summary', signature: 'native-signature' },
        ...claude.content
      ]
    })
    const output = state.finish().response.output
    const { request: native } = buildResponsesProviderRequest(
      { model: 'model', input: output },
      'claude'
    )
    expect(native.messages[0].content[0]).toEqual({
      type: 'thinking',
      thinking: 'summary',
      signature: 'native-signature'
    })
    const { request: foreign } = buildResponsesProviderRequest(
      { model: 'model', input: output },
      'gemini'
    )
    expect(JSON.stringify(foreign)).not.toContain('native-signature')
    expect(JSON.stringify(foreign)).toContain('summary')
  })
})
