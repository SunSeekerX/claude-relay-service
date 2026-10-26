import { jest } from '@jest/globals'
import express from 'express'
import { createServer } from 'node:http'

const scanAndGetAllChunked = jest.fn()
const resolveModelStatsCost = jest.fn((usage) => ({
  costs: { total: usage.realCostMicro / 1e6, rated: usage.ratedCostMicro / 1e6 },
  formatted: {},
  pricing: {},
  source: 'stored',
}))
const logger = new Proxy({}, { get: () => jest.fn() })
const mocks = {
  '../src/infra/redis.js': {
    redis: {
      getClientSafe: () => ({}),
      getDateInTimezone: () => new Date(2026, 9, 24, 12),
      getDateStringInTimezone: () => '2026-10-24',
      scanAndGetAllChunked,
    },
  },
  '../src/common/logger.js': { logger },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: {} },
  '../src/modules/pricing/pricing_cost_calculator.js': { CostCalculator: { resolveModelStatsCost } },
  '../src/modules/account/account_claude_service.js': { claudeAccountService: {} },
  '../src/modules/account/account_openai_service.js': {},
  '../src/modules/payment/payment_service_rates_service.js': { serviceRatesService: {} },
  '../config/models.js': { modelsConfig: {} },
  '../src/modules/relay/relay_test_model_config_service.js': { testModelConfigService: {} },
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
    createChatCompletionsTestPayload: jest.fn(),
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
const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

const requestPeriod = async (period, apiIds = [firstId]) => {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/apiStats/api/batch-model-stats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiIds, period }),
    })
    return { status: response.status, body: await response.json() }
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  scanAndGetAllChunked.mockResolvedValue([])
})

it('reads cumulative buckets for every key and derives total tokens without double-counting reasoning', async () => {
  scanAndGetAllChunked.mockImplementation(async (pattern) => [
    {
      key: pattern.replace('*', 'gpt-fixture:long'),
      data: {
        requests: '3',
        inputTokens: '50',
        outputTokens: '60',
        cacheCreateTokens: '70',
        cacheReadTokens: '80',
        thinkingTokens: '5000',
        thinkingInAllTokens: '11',
        allTokens: '999999',
        realCostMicro: '1000000',
        ratedCostMicro: '2000000',
      },
    },
  ])
  const result = await requestPeriod('alltime', [firstId, secondId])
  expect(result.status).toBe(200)
  expect(scanAndGetAllChunked.mock.calls).toEqual([
    [`usage:${firstId}:model:alltime:*`],
    [`usage:${secondId}:model:alltime:*`],
  ])
  expect(result.body.data).toEqual([
    expect.objectContaining({
      model: 'gpt-fixture:long',
      requests: 6,
      allTokens: 542,
      thinkingTokens: 10000,
      costs: { total: 2, rated: 4 },
    }),
  ])
  expect(resolveModelStatsCost).toHaveBeenCalledWith(
    expect.objectContaining({
      realCostMicro: 2000000,
      ratedCostMicro: 4000000,
      inputTokens: 100,
      outputTokens: 120,
      cacheCreateTokens: 140,
      cacheReadTokens: 160,
    }),
    'gpt-fixture:long',
  )
})

it.each([
  ['daily', `usage:${firstId}:model:daily:*:2026-10-24`],
  ['monthly', `usage:${firstId}:model:monthly:*:2026-10`],
])('preserves the %s bucket and total token contract', async (period, expectedPattern) => {
  scanAndGetAllChunked.mockResolvedValue([
    {
      key: expectedPattern.replace('*', 'fixture-model'),
      data: { requests: '2', allTokens: '999', inputTokens: '10' },
    },
  ])
  const result = await requestPeriod(period)
  expect(scanAndGetAllChunked).toHaveBeenCalledWith(expectedPattern)
  expect(result.body.data[0]).toMatchObject({ model: 'fixture-model', requests: 2, allTokens: 999 })
})

it('returns an empty cumulative result without substituting monthly data', async () => {
  const result = await requestPeriod('alltime')
  expect(result.body).toMatchObject({ code: 200, data: [] })
  expect(scanAndGetAllChunked).toHaveBeenCalledTimes(1)
  expect(scanAndGetAllChunked).toHaveBeenCalledWith(`usage:${firstId}:model:alltime:*`)
})
