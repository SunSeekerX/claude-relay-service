import { jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { Readable } from 'node:stream'
const post = jest.fn(async () => ({ status: 200, data: Readable.from(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']) }))

const scanAndGetAllChunked = jest.fn()
const resolveModelStatsCost = jest.fn((usage) => ({
  costs: { total: usage.realCostMicro / 1e6, rated: usage.ratedCostMicro / 1e6 },
  formatted: {},
  pricing: {},
  source: 'stored',
}))
const logger = new Proxy({}, { get: () => jest.fn() })
const mocks = {
  axios: { default: { post } },
  '../src/modules/relay/relay_test_prompt_config_service.js': { testPromptConfigService: { resolvePrompt: async (prompt) => prompt } },
  '../src/modules/relay/relay_routing_service.js': { getPublicKeyRouting: async () => ({}), getLegacyProviderModels: async () => [], resolveKeyModelTestTarget: async () => ({ path: '/openai/native/v1/chat/completions' }) },
  '../src/infra/redis.js': {
    redis: {
      getClientSafe: () => ({}),
      getDateInTimezone: () => new Date(2026, 9, 24, 12),
      getDateStringInTimezone: () => '2026-10-24',
      scanAndGetAllChunked,
    },
  },
  '../src/common/logger.js': { logger },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: { validateApiKeyForStats: async () => ({ valid: true, keyData: { id: 'key' } }), hasPermission: () => true } },
  '../src/modules/pricing/pricing_cost_calculator.js': { CostCalculator: { resolveModelStatsCost } },
  '../src/modules/account/account_claude_service.js': { claudeAccountService: {} },
  '../src/modules/account/account_openai_service.js': {},
  '../src/modules/payment/payment_service_rates_service.js': { serviceRatesService: {} },
  '../config/models.js': { modelsConfig: {} },
  '../src/modules/relay/relay_test_model_config_service.js': { testModelConfigService: { resolveApikeyModel: async (_service, model) => model, getModelDefaults: async () => ({ account: { claude: 'configured-model' }, apikey: { openai: 'configured-model' } }) } },
  '../src/modules/relay/relay_codex_responses_ws.js': {
    CODEX_USER_AGENT: 'fixture',
    CODEX_CLI_VERSION: 'fixture',
    CODEX_ORIGINATOR: 'fixture',
  },
  '../config/config.js': { config: { server: { port: 3000 }, system: { timezoneOffset: 8 } } },
  '../src/common/test_payload_helper.js': {
    sendStreamTestRequest: jest.fn(),
    createGeminiTestPayload: jest.fn(),
    createOpenAITestPayload: jest.fn(),
    createClaudeTestPayload: jest.fn(),
    createChatCompletionsTestPayload: (model) => ({ model, messages: [{ role: 'user', content: 'test' }] }),
    extractErrorMessage: jest.fn(),
    sanitizeErrorMsg: jest.fn(),
  },
  '../src/modules/pricing/pricing_service.js': { pricingService: {} },
  '../src/modules/payment/payment_quota_card_service.js': { quotaCardService: {} },
}
for (const [name, exports] of Object.entries(mocks)) {
  jest.unstable_mockModule(name, () => exports)
}

const { router } = await import('../src/modules/admin/admin_api_stats_routes.js')
const app = express().use(express.json()).use('/apiStats', router)

test('Chat endpoint test requests SSE and reports completion from the stream', async () => {
  const response = await request(app).post('/apiStats/api-key/test-openai-chat').send({ apiKey: 'fixture-key-only', model: 'custom-model', prompt: 'test' })
  expect(response.status).toBe(200)
  expect(post.mock.calls[0][0]).toBe('http://127.0.0.1:3000/openai/native/v1/chat/completions')
  expect(post.mock.calls[0][1]).toMatchObject({ model: 'custom-model', stream: true })
  expect(response.text).toContain('"test_complete","success":true')
})
test('the public default-model endpoint returns only the model defaults envelope', async () => {
  const result = await request(app).get('/apiStats/test-model-defaults')
  expect(result.status).toBe(200)
  expect(result.body.data).toEqual({ account: { claude: 'configured-model' }, apikey: { openai: 'configured-model' } })
})
const handleOpenAIChatRequest = jest.fn(async (req, res) => res.json({ provider: 'openai', model: req.body.model, path: req.path }))
const handleChatCompletion = jest.fn(async (req, res) => res.json({ provider: 'claude' }))
await jest.unstable_mockModule('../src/infra/middleware_auth.js', () => ({ authenticateApiKey: (req, _res, next) => { req.apiKey = { permissions: 'all' }; next() } }))
await jest.unstable_mockModule('../src/modules/relay/relay_openai_routes.js', () => ({ handleOpenAIChatRequest }))
await jest.unstable_mockModule('../src/modules/relay/relay_openai_claude_routes.js', () => ({ handleChatCompletion }))
await jest.unstable_mockModule('../src/modules/relay/relay_grok_relay_service.js', () => ({ grokRelayService: {} }))
await jest.unstable_mockModule('../src/modules/relay/relay_gemini_handlers_routes.js', () => ({ handleStandardGenerateContent: jest.fn(), handleStandardStreamGenerateContent: jest.fn() }))
const { unifiedRoutes } = await import('../src/modules/relay/relay_unified_routes.js')
const relay = express().use(express.json()).use('/openai', unifiedRoutes)
test('the explicit OpenAI entry routes custom names to OpenAI and preserves the former smart path', async () => {
  const input = { model: 'fast-custom', messages: [{ role: 'user', content: 'test' }] }
  const direct = await request(relay).post('/openai/native/v1/chat/completions').send(input)
  expect(direct.body).toEqual({ provider: 'openai', model: 'fast-custom', path: '/v1/chat/completions' })
  const legacy = await request(relay).post('/openai/v1/chat/completions').send(input)
  expect(legacy.body.provider).toBe('claude')
})
