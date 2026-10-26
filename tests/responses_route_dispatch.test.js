import { beforeEach, expect, jest, test } from '@jest/globals'
import express from 'express'
import request from 'supertest'
const native = jest.fn(async (req, res) =>
  res.json({
    type: 'message',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'answer' }],
    usage: { input_tokens: 10, output_tokens: 2 }
  })
)
const gemini = jest.fn(async (req, res) =>
  res.json({
    candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 }
  })
)
const openai = jest.fn(async (req, res) => {
  const output = [
    { type: 'function_call', name: req.body.tools[0].name, call_id: 'c1', arguments: '{}' }
  ]
  const response = {
    id: 'resp_1',
    status: 'completed',
    output,
    usage: { input_tokens: 10, output_tokens: 2 }
  }
  if (req.body.stream) {
    res.set('content-type', 'text/event-stream')
    res.write(
      `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: output[0] })}\n\n`
    )
    return res.end(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
  }
  return res.json(response)
})
const auxiliary = jest.fn(async (req, res) =>
  res.json({ body: req.body, method: req.method, operationId: req.params.operationId ?? null })
)
const modules = {
  '../src/modules/relay/relay_openai_input_tokens.js': { handleResponsesInputTokens: jest.fn() },
  '../src/modules/relay/relay_gemini_interactions_service.js': { geminiInteractionsService: {} },
  '../src/infra/middleware_auth.js': { authenticateApiKey: (_req, _res, next) => next() },
  '../src/infra/redis.js': { redis: {} },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/modules/relay/relay_routing_service.js': {
    getRouteModels: async () => [],
    getRouteTarget: async () => null
  },
  '../src/modules/relay/relay_api_routes.js': {
    handleMessagesRequest: native,
    handleCountTokensRequest: jest.fn()
  },
  '../src/modules/relay/relay_openai_routes.js': { handleResponses: openai },
  '../src/modules/relay/relay_unified_routes.js': { handleUnifiedChatRequest: jest.fn() },
  '../src/modules/relay/relay_gemini_handlers_routes.js': Object.fromEntries(
    [
      'handleGenerateContent',
      'handleStreamGenerateContent',
      'handleStandardGenerateContent',
      'handleStandardStreamGenerateContent',
      'handleCountTokens',
      'handleInteractions'
    ].map((name) => [name, gemini])
  ),
  '../src/modules/relay/relay_gemini_code_assist_handlers.js': {
    createCodeAssistHandler: () => auxiliary
  },
  '../src/modules/relay/relay_grok_relay_service.js': { grokRelayService: {} },
  '../src/modules/relay/relay_droid_relay_service.js': { droidRelayService: {} },
  '../src/modules/tokenizer/tokenizer_service.js': {
    countAnthropicEstimate: jest.fn(),
    anthropicEstimateResponse: jest.fn()
  }
}
for (const [name, value] of Object.entries(modules)) jest.unstable_mockModule(name, () => value)
const { dispatchRoutedRequest } = await import('../src/modules/relay/relay_routing_dispatch.js')
let toolMode
const app = express()
  .use(express.json())
  .use('/r/:provider', (req, res) => {
    const provider = req.params.provider
    req.params.routeCode = 'entry'
    req.apiKey = {
      id: 'key',
      permissions: [provider],
      _relayRoute: {
        code: 'entry',
        provider,
        binding: 'account',
        formats: ['openai-responses', 'gemini-generate'],
        converterOptions: toolMode ? { 'openai-responses': { toolMode } } : {}
      }
    }
    if (req.body?.model)
      req._relayRouteModel = { requestedModel: req.body.model, mappedModel: req.body.model }
    return dispatchRoutedRequest(
      req,
      res,
      req.path.includes('v1internal') ? 'gemini-generate' : 'openai-responses'
    )
  })
beforeEach(() => {
  jest.clearAllMocks()
  toolMode = undefined
})
test.each(['claude', 'gemini'])(
  'named %s Responses uses its existing provider once without OpenAI fallback',
  async (provider) => {
    const response = await request(app)
      .post(`/r/${provider}/v1/responses`)
      .send({ model: 'model', input: 'hello', store: false })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      object: 'response',
      status: 'completed',
      output: [{ content: [{ text: 'answer' }] }]
    })
    expect(openai).not.toHaveBeenCalled()
    expect(provider === 'claude' ? native : gemini).toHaveBeenCalledTimes(1)
  }
)
test('named Gemini auxiliary paths are admitted without a model and preserve method/body', async () => {
  const response = await request(app)
    .post('/r/gemini/v1internal:loadCodeAssist')
    .send({ metadata: { empty: false } })
  expect(response.status).toBe(200)
  expect(response.body.body).toEqual({ metadata: { empty: false } })
  expect(native).not.toHaveBeenCalled()
  expect(gemini).not.toHaveBeenCalled()
  const poll = await request(app).get('/r/gemini/v1internal/operations/task1')
  expect(poll.body).toMatchObject({ method: 'GET', operationId: 'task1' })
})
test.each([false, true])(
  'an explicitly compatible OpenAI route restores namespace output (stream=%s)',
  async (stream) => {
    toolMode = 'functions'
    const response = await request(app)
      .post('/r/openai/v1/responses')
      .send({
        model: 'model',
        input: 'hi',
        stream,
        tools: [
          {
            type: 'namespace',
            name: 'fs',
            tools: [{ type: 'function', name: 'read', parameters: {} }]
          }
        ]
      })
    expect(response.status).toBe(200)
    expect(openai).toHaveBeenCalledTimes(1)
    if (stream) expect(response.text).toContain('"namespace":"fs"')
    else
      expect(response.body.output[0]).toMatchObject({
        namespace: 'fs',
        name: 'read',
        call_id: 'c1'
      })
  }
)
test('a default OpenAI route leaves native namespace declarations untouched', async () => {
  const response = await request(app)
    .post('/r/openai/v1/responses')
    .send({
      model: 'model',
      input: 'hi',
      tools: [{ type: 'namespace', name: 'fs', tools: [{ type: 'function', name: 'read' }] }]
    })
  expect(response.status).toBe(200)
  expect(response.body.output[0].name).toBe('fs')
})
