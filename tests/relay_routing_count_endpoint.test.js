import { beforeEach, expect, jest, test } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const count = jest.fn(async () => ({
  contentTokens: 2,
  source: 'node-vocabulary',
  precision: 'official-text',
  selection: { tokenizer: 'openai_o200k_base' },
  missing: ['protocol-framing'],
}))
const responsesCount = jest.fn((_req, res) =>
  res.json({ object: 'response.input_tokens', input_tokens: 3, _crs_estimate: true }),
)
await jest.unstable_mockModule('../src/modules/relay/relay_openai_input_tokens.js', () => ({
  handleResponsesInputTokens: responsesCount,
}))
await jest.unstable_mockModule('../src/modules/relay/relay_gemini_interactions_service.js', () => ({
  geminiInteractionsService: {},
}))
await jest.unstable_mockModule('../src/modules/relay/relay_gemini_code_assist_handlers.js', () => ({
  createCodeAssistHandler: () => jest.fn(),
}))
await jest.unstable_mockModule('../src/modules/relay/relay_responses_gateway.js', () => ({
  relayResponsesViaProvider: jest.fn(),
}))
await jest.unstable_mockModule('../src/modules/relay/relay_model_discovery.js', () => ({
  sendModelDiscovery: jest.fn(),
}))
await jest.unstable_mockModule('../src/infra/middleware_auth.js', () => ({
  authenticateApiKey: (_req, _res, next) => next(),
}))
await jest.unstable_mockModule('../src/modules/relay/relay_routing_service.js', () => ({
  getRouteModels: async () => [],
  getRouteTarget: async () => ({ group: { modelWhitelist: ['gpt-4o'] } }),
}))
await jest.unstable_mockModule('../src/modules/relay/relay_api_routes.js', () => ({
  handleMessagesRequest: jest.fn(),
  handleCountTokensRequest: jest.fn(),
}))
await jest.unstable_mockModule('../src/modules/relay/relay_openai_routes.js', () => ({ handleResponses: jest.fn() }))
await jest.unstable_mockModule('../src/modules/relay/relay_unified_routes.js', () => ({
  handleUnifiedChatRequest: jest.fn(),
}))
await jest.unstable_mockModule('../src/modules/relay/relay_gemini_handlers_routes.js', () =>
  Object.fromEntries(
    [
      'handleGenerateContent',
      'handleStreamGenerateContent',
      'handleStandardGenerateContent',
      'handleStandardStreamGenerateContent',
      'handleCountTokens',
      'handleLoadCodeAssist',
      'handleOnboardUser',
      'handleRetrieveUserQuota',
      'handleInteractions',
    ].map((name) => [name, jest.fn()]),
  ),
)
await jest.unstable_mockModule('../src/modules/relay/relay_grok_relay_service.js', () => ({ grokRelayService: {} }))
await jest.unstable_mockModule('../src/modules/relay/relay_droid_relay_service.js', () => ({ droidRelayService: {} }))
await jest.unstable_mockModule('../src/modules/tokenizer/tokenizer_service.js', () => ({
  countAnthropicEstimate: count,
  anthropicEstimateResponse: (result) => ({
    input_tokens: result.contentTokens,
    _crs_estimate: true,
    _crs_estimate_method: result.source,
    _crs_missing: result.missing,
  }),
}))
await jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: { error: jest.fn() } }))
const { dispatchRoutedRequest } = await import('../src/modules/relay/relay_routing_dispatch.js')
const app = express()
app.use(express.json())
app.post('/v1/messages/count_tokens', (req, res) => {
  req.apiKey = {
    id: 'key1',
    _relayRoute: { code: 'a', provider: 'openai', binding: 'group:g', formats: ['claude-messages'] },
  }
  req._relayRouteModel = { mappedModel: req.body.model }
  return dispatchRoutedRequest(req, res, 'claude-messages')
})
beforeEach(() => count.mockClear())

const responsesRouter = express.Router({ mergeParams: true })
responsesRouter.post('/v1/responses/input_tokens', (req, res) => {
  req.apiKey = {
    id: 'key1',
    _relayRoute: { code: 'test', provider: 'openai', binding: 'group:g', formats: ['openai-responses'] },
  }
  req._relayRouteModel = { mappedModel: req.body.model }
  return dispatchRoutedRequest(req, res, 'openai-responses')
})
app.use('/r/:routeCode', responsesRouter)
test('named Responses counting delegates to the dedicated count handler rather than generation', async () => {
  const result = await request(app)
    .post('/r/test/v1/responses/input_tokens')
    .send({ model: 'gpt-4o', input: 'hello' })
    .expect(200)
  expect(result.body.object).toBe('response.input_tokens')
  expect(responsesCount).toHaveBeenCalledTimes(1)
})

test('cross-protocol token counts return explicit estimate body and provenance headers', async () => {
  const response = await request(app)
    .post('/v1/messages/count_tokens')
    .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello world' }] })
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ input_tokens: 2, _crs_estimate: true, _crs_estimate_method: 'node-vocabulary' })
  expect(response.headers['x-crs-token-count-precision']).toBe('request-estimate')
  expect(count).toHaveBeenCalledTimes(1)
})
test('local estimates still enforce bound group model policy', async () => {
  const response = await request(app).post('/v1/messages/count_tokens').send({ model: 'other-model', messages: [] })
  expect(response.status).toBe(403)
  expect(count).not.toHaveBeenCalled()
})
test('malformed Messages count payload is rejected rather than synthesized as success', async () => {
  const response = await request(app)
    .post('/v1/messages/count_tokens')
    .send({ model: 'gpt-4o', messages: 'not-an-array' })
  expect(response.status).toBe(400)
  expect(response.body.type).toBe('error')
  expect(count).not.toHaveBeenCalled()
})
