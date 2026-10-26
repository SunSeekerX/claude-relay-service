import { jest, beforeEach, describe, it, expect } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { Readable } from 'node:stream'
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
      req._crsRecordRelayResult = outcomes
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
