import { jest, beforeEach, describe, it, expect } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { Readable } from 'node:stream'
import { httpRequestStats } from '../src/common/http_request_stats.js'
import { buildOpenAIChatGeminiRequest } from '../src/modules/relay/relay_openai_gemini_request.js'
import { GeminiToOpenAIConverter } from '../src/modules/relay/relay_gemini_to_openai.js'

const recordUsage = jest.fn().mockResolvedValue({})
const unmetered = jest.fn().mockResolvedValue({})
const generate = jest.fn()
const stream = jest.fn()
const account = { id: 'account-fixture', oauthProvider: 'gemini-cli', projectId: 'fixture-project' }
const outcomes = jest.fn()
const key = { id: 'key-fixture', permissions: ['gemini'], enableModelRestriction: false }
const mocks = {
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/infra/middleware_auth.js': {
    authenticateApiKey: (req, _res, next) => {
      req.apiKey = key
      httpRequestStats.observe(req, _res)
      const recordResult = req._crsRecordRelayResult
      req._crsRecordRelayResult = (result) => {
        outcomes(result)
        recordResult(result)
      }
      next()
    },
  },
  '../src/modules/account/account_gemini_service.js': {
    getAccount: async () => account,
    markAccountUsed: jest.fn().mockResolvedValue(),
    getOauthClient: async () => ({}),
    generateContent: generate,
    generateContentStream: stream,
  },
  '../src/modules/relay/relay_unified_gemini_scheduler.js': {
    unifiedGeminiScheduler: { selectAccountForApiKey: async () => ({ accountId: account.id }) },
  },
  '../src/modules/relay/relay_gemini_relay_service.js': { getAvailableModels: () => [] },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: { hasPermission: () => true, recordUsage } },
  '../src/modules/relay/relay_antigravity_client.js': { ensureAntigravityProjectId: () => 'fixture-project' },
  '../src/modules/relay/relay_request_detail_service.js': {
    requestDetailService: { captureUnmeteredRequest: unmetered },
  },
}
for (const [name, exports] of Object.entries(mocks)) {
  jest.unstable_mockModule(name, () => exports)
}
const { router } = await import('../src/modules/relay/relay_openai_gemini_routes.js')
const app = express()
app.use(express.json())
app.use('/openai/gemini', router)
const endpoint = '/openai/gemini/v1/chat/completions'
const wireUsage = {
  promptTokenCount: 20,
  cachedContentTokenCount: 5,
  candidatesTokenCount: 3,
  thoughtsTokenCount: 2,
  totalTokenCount: 25,
}
const events = (items) => items.map((item) => `data:${JSON.stringify(item)}\r\n\r\n`).join('')
const parse = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(5)))

beforeEach(() => {
  jest.clearAllMocks()
  httpRequestStats.reset()
  account.oauthProvider = 'gemini-cli'
  generate.mockResolvedValue({
    response: {
      candidates: [{ content: { parts: [{ text: '一' }, { text: '二' }] }, finishReason: 'STOP' }],
      usageMetadata: wireUsage,
    },
  })
})

describe('OpenAI Chat to Gemini protocol conversion', () => {
  it('preserves parallel tool identities, arguments, signatures and out-of-order tool results', () => {
    const result = buildOpenAIChatGeminiRequest({
      messages: [
        { role: 'developer', content: 'policy' },
        { role: 'user', content: 'weather' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'one',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"Taipei"}' },
              extra_content: { google: { thought_signature: 'signature-one' } },
            },
            { id: 'two', type: 'function', function: { name: 'clock', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'two', content: '{"hour":0}' },
        { role: 'tool', tool_call_id: 'one', content: 'sunny' },
      ],
      temperature: 0,
      max_tokens: 0,
      tools: [
        {
          type: 'function',
          function: {
            name: 'weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'weather' } },
    })
    expect(result.systemInstruction.parts).toEqual([{ text: 'policy' }])
    expect(result.generationConfig).toMatchObject({ temperature: 0, maxOutputTokens: 0 })
    expect(result.contents[1].parts[0]).toMatchObject({
      functionCall: { id: 'one', name: 'weather', args: { city: 'Taipei' } },
      thoughtSignature: 'signature-one',
    })
    expect(result.contents[2].parts.map((part) => part.functionResponse)).toEqual([
      { id: 'two', name: 'clock', response: { hour: 0 } },
      { id: 'one', name: 'weather', response: { output: 'sunny' } },
    ])
    expect(result.tools[0].functionDeclarations[0].parametersJsonSchema.required).toEqual(['city'])
    expect(result.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['weather'] })
  })

  it('enables mixed built-in tools for Gemini while excluding the unsupported Antigravity flag', () => {
    const body = {
      messages: [{ role: 'user', content: 'search' }],
      tools: [
        { type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: {} } } },
        { type: 'web_search' },
      ],
    }
    expect(buildOpenAIChatGeminiRequest(body).toolConfig.includeServerSideToolInvocations).toBe(true)
    expect(
      buildOpenAIChatGeminiRequest(body, { vendor: 'antigravity' }).toolConfig?.includeServerSideToolInvocations,
    ).toBeUndefined()
  })

  it('preserves native parts and generation settings without fabricating Chat defaults', () => {
    const body = {
      contents: [
        { role: 'model', parts: [{ functionCall: { id: 'x', name: 'x', args: {} }, thoughtSignature: 'original' }] },
      ],
      generationConfig: { temperature: 0 },
      cachedContent: 'cachedContents/fixture',
      tools: [],
    }
    expect(buildOpenAIChatGeminiRequest(body)).toEqual(body)
    expect(
      buildOpenAIChatGeminiRequest({ messages: [{ role: 'user', content: 'hi' }] }).generationConfig,
    ).toBeUndefined()
  })

  it('rejects malformed tool arguments rather than sending a blank model turn', () => {
    expect(() =>
      buildOpenAIChatGeminiRequest({
        messages: [
          { role: 'assistant', tool_calls: [{ id: 'x', type: 'function', function: { name: 'x', arguments: '{' } }] },
        ],
      }),
    ).toThrow('valid JSON')
    expect(() =>
      buildOpenAIChatGeminiRequest({ messages: [{ role: 'tool', tool_call_id: 'missing', content: 'x' }] }),
    ).toThrow('No matching')
  })
})

describe('legacy endpoint uses the shared converters and one usage settlement', () => {
  it('returns every text part and bills Gemini thoughts exactly once', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ model: 'gemini-fixture', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.body.choices[0].message.content).toBe('一二')
    expect(res.body.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 })
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0][1]).toMatchObject({
      input_tokens: 15,
      cache_read_input_tokens: 5,
      output_tokens: 3,
      reasoning_tokens: 2,
      reasoning_included_in_output: false,
    })
  })

  it('handles UTF-8 splits, no-space SSE, tool calls and a separate usage event', async () => {
    const bytes = Buffer.from(
      events([
        {
          response: {
            responseId: 'native-response',
            candidates: [
              {
                content: {
                  parts: [
                    { text: '中文' },
                    {
                      functionCall: { id: 'native-tool', name: 'weather', args: { city: 'Taipei' } },
                      thoughtSignature: 'original',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          },
        },
        { response: { usageMetadata: wireUsage } },
      ]),
    )
    stream.mockResolvedValue(Readable.from([...bytes].map((byte) => Buffer.from([byte]))))
    const res = await request(app)
      .post(endpoint)
      .send({ model: 'gemini-fixture', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    const chunks = parse(res.text)
    expect(
      chunks
        .flatMap((chunk) => chunk.choices)
        .map((choice) => choice.delta.content ?? '')
        .join(''),
    ).toBe('中文')
    expect(
      chunks.flatMap((chunk) => chunk.choices).flatMap((choice) => choice.delta.tool_calls ?? [])[0],
    ).toMatchObject({
      id: 'native-tool',
      function: { name: 'weather' },
      extra_content: { google: { thought_signature: 'original' } },
    })
    expect(chunks.filter((chunk) => chunk.choices[0]?.finish_reason === 'tool_calls')).toHaveLength(1)
    expect(chunks.at(-1).choices).toEqual([])
    expect(res.text.match(/data: \[DONE\]/g)).toHaveLength(1)
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(unmetered).not.toHaveBeenCalled()
  })

  it('marks EOF before a finish reason as failure while settling the last reported usage once', async () => {
    stream.mockResolvedValue(
      Readable.from([
        Buffer.from(
          events([
            { response: { candidates: [{ content: { parts: [{ text: 'partial' }] } }], usageMetadata: wireUsage } },
          ]),
        ),
      ]),
    )
    const res = await request(app)
      .post(endpoint)
      .send({ model: 'gemini-fixture', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(parse(res.text).some((item) => item.error)).toBe(true)
    expect(outcomes).toHaveBeenLastCalledWith(
      expect.objectContaining({ statusCode: 502, errorCode: 'upstream_stream_incomplete', hasUsage: true }),
    )
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0][6]).toMatchObject({ statusCode: 502, errorCode: 'upstream_stream_incomplete' })
  })

  it('records unmetered completion when the upstream omits usage', async () => {
    stream.mockResolvedValue(
      Readable.from([
        Buffer.from(events([{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }])),
      ]),
    )
    await request(app)
      .post(endpoint)
      .send({ model: 'gemini-fixture', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(recordUsage).not.toHaveBeenCalled()
    expect(unmetered).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'returns a blocked prompt as content_filter and bills reported usage once, stream=%s',
    async (streaming) => {
      const promptFeedback = {
        blockReason: 'SAFETY',
        safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }],
      }
      const usageMetadata = { promptTokenCount: 10, totalTokenCount: 10 }
      generate.mockResolvedValue({ response: { promptFeedback, usageMetadata } })
      stream.mockResolvedValue(
        Readable.from([Buffer.from(events([{ response: { promptFeedback } }, { response: { usageMetadata } }]))]),
      )
      const res = await request(app)
        .post(endpoint)
        .send({
          model: 'gemini-fixture',
          stream: streaming,
          messages: [{ role: 'user', content: 'fixture' }],
        })
      expect(res.status).toBe(200)
      const chunks = streaming ? parse(res.text) : [res.body]
      expect(chunks.some((chunk) => chunk.error)).toBe(false)
      expect(chunks.filter((chunk) => chunk.choices[0]?.finish_reason === 'content_filter')).toHaveLength(1)
      expect(chunks.find((chunk) => chunk.prompt_feedback)?.prompt_feedback).toEqual(promptFeedback)
      expect(recordUsage).toHaveBeenCalledTimes(1)
      expect(recordUsage.mock.calls[0][1]).toMatchObject({ input_tokens: 10, output_tokens: 0 })
      expect(recordUsage.mock.calls[0][6]).toMatchObject({
        statusCode: 200,
        errorCode: null,
        errorMessage: 'Gemini prompt blocked: SAFETY',
        protocolTerminal: 'content_filter',
      })
      expect(outcomes).toHaveBeenLastCalledWith(
        expect.objectContaining({ statusCode: 200, errorCode: null, hasUsage: true }),
      )
      expect(httpRequestStats.getStats().relay).toMatchObject({ completed: 1, failed: 0, unmetered: 0 })
      expect(unmetered).not.toHaveBeenCalled()
      if (streaming) {
        expect(res.text.match(/data: \[DONE\]/g)).toHaveLength(1)
      }
    },
  )

  it.each([false, true])(
    'preserves a blocked prompt with missing usage without inventing charges, stream=%s',
    async (streaming) => {
      const payload = { response: { candidates: [], promptFeedback: { blockReason: 'BLOCKLIST' } } }
      generate.mockResolvedValue(payload)
      stream.mockResolvedValue(Readable.from([Buffer.from(events([payload]))]))
      const res = await request(app)
        .post(endpoint)
        .send({
          model: 'gemini-fixture',
          stream: streaming,
          messages: [{ role: 'user', content: 'fixture' }],
        })
      expect(res.status).toBe(200)
      const chunks = streaming ? parse(res.text) : [res.body]
      expect(chunks[0].choices[0].finish_reason).toBe('content_filter')
      expect(chunks[0].prompt_feedback.blockReason).toBe('BLOCKLIST')
      expect(recordUsage).not.toHaveBeenCalled()
      expect(unmetered).toHaveBeenCalledTimes(1)
      expect(unmetered.mock.calls[0][1].result).toMatchObject({
        statusCode: 200,
        errorMessage: 'Gemini prompt blocked: BLOCKLIST',
        protocolTerminal: 'content_filter',
      })
      expect(httpRequestStats.getStats().relay).toMatchObject({ completed: 1, failed: 0, unmetered: 1 })
    },
  )

  it('does not treat an unspecified block reason as a completed stream', async () => {
    stream.mockResolvedValue(
      Readable.from([
        Buffer.from(
          events([{ promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' }, usageMetadata: wireUsage }]),
        ),
      ]),
    )
    await request(app)
      .post(endpoint)
      .send({
        model: 'gemini-fixture',
        stream: true,
        messages: [{ role: 'user', content: 'fixture' }],
      })
    expect(outcomes).toHaveBeenLastCalledWith(
      expect.objectContaining({
        statusCode: 502,
        errorCode: 'upstream_stream_incomplete',
      }),
    )
  })

  it('uses the shared framing at every byte split including the last unterminated event', () => {
    const bytes = Buffer.from(
      'event: message\r\ndata:{"candidates":[{"content":{"parts":[{"text":"中文"}]},"finishReason":"STOP"}]}',
    )
    const converter = new GeminiToOpenAIConverter()
    for (let split = 0; split <= bytes.length; split++) {
      const state = converter.createStreamState()
      const output =
        (converter.convertStreamChunk(bytes.subarray(0, split), 'fixture', state) ?? '') +
        (converter.convertStreamChunk(bytes.subarray(split), 'fixture', state) ?? '') +
        (converter.finishStream('fixture', state) ?? '')
      expect(
        parse(output)
          .map((item) => item.choices[0].delta.content ?? '')
          .join(''),
      ).toBe('中文')
    }
  })
})

describe('Gemini SSE keepalive conversion', () => {
  it.each(['\n', '\r\n', Buffer.from('\n'), Buffer.from('\r\n')])(
    'forwards standalone heartbeat %p immediately',
    (heartbeat) => {
      const converter = new GeminiToOpenAIConverter()
      const state = converter.createStreamState()
      expect(converter.convertStreamChunk(heartbeat, 'fixture', state)).toBe(heartbeat.toString())
      expect(converter.finishStream('fixture', state)).toBeNull()
    },
  )

  it('preserves comment heartbeats across every network byte split', () => {
    const bytes = Buffer.from(': keep-alive\r\n\r\n')
    const converter = new GeminiToOpenAIConverter()
    for (let split = 0; split <= bytes.length; split++) {
      const state = converter.createStreamState()
      const output =
        (converter.convertStreamChunk(bytes.subarray(0, split), 'fixture', state) ?? '') +
        (converter.convertStreamChunk(bytes.subarray(split), 'fixture', state) ?? '') +
        (converter.finishStream('fixture', state) ?? '')
      expect(output).toBe(bytes.toString())
    }
  })

  it('keeps whitespace in a pending SSE frame until the frame is complete', () => {
    const converter = new GeminiToOpenAIConverter()
    const state = converter.createStreamState()
    expect(
      converter.convertStreamChunk('data:{"candidates":[{"content":{"parts":[{"text":"one"}]}}]}', 'fixture', state),
    ).toBeNull()
    expect(converter.convertStreamChunk('\n', 'fixture', state)).toBeNull()
    const output = converter.convertStreamChunk('\n', 'fixture', state)
    expect(parse(output)[0].choices[0].delta.content).toBe('one')
    expect(converter.convertStreamChunk('\n', 'fixture', state)).toBe('\n')
  })
})
