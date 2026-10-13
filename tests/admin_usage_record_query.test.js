import { jest } from '@jest/globals'
import express from 'express'
import { createServer } from 'node:http'

const calculateCost = jest.fn(() => ({ costs: { input: 1, output: 2, total: 3 } }))
const getAllApiKeysFast = jest.fn()
const records = [
  {
    timestamp: '2026-10-13T10:00:00.000Z',
    accountId: 'acct',
    model: 'grok-test',
    accountType: 'grok',
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    cost: 0,
    realCost: 1e-10,
    costBreakdown: { total: 1 },
    realCostBreakdown: { total: 1e-10 },
    upstreamCostTicks: '1',
    realCostSource: 'upstream'
  },
  {
    timestamp: '2026-10-13T11:00:00.000Z',
    accountId: 'acct',
    model: 'gpt-test',
    accountType: 'openai-responses',
    inputTokens: 20,
    outputTokens: 3,
    totalTokens: 23,
    cost: 2,
    realCost: 1,
    costBreakdown: { input: 1, total: 1 }
  },
  {
    timestamp: '2026-10-13T11:30:00.000Z',
    accountId: 'other',
    model: 'gpt-test',
    inputTokens: 100,
    cost: 20,
    realCost: 10,
    costBreakdown: { total: 10 }
  }
]
const redis = {
  scanApiKeyIds: jest.fn().mockResolvedValue(['key']),
  iterateUsageRecordBatches: jest.fn(async function* (ids) {
    yield ids.map((keyId) => ({
      keyId,
      name: 'fixture',
      records: records.map((record) => ({ ...record }))
    }))
  }),
  getApiKey: jest.fn().mockResolvedValue({ name: 'fixture' }),
  getUsageRecords: jest
    .fn()
    .mockImplementation(async () => records.map((record) => ({ ...record })))
}
const account = { id: 'acct', name: 'account', platform: 'openai-responses' }
const modules = {
  '../src/infra/redis.js': { redis },
  '../src/infra/middleware_auth.js': { authenticateAdmin: (_req, _res, next) => next() },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: { getAllApiKeysFast } },
  '../src/modules/pricing/pricing_cost_calculator.js': {
    CostCalculator: { calculateCost, formatCost: (value) => String(value) }
  },
  '../src/modules/pricing/pricing_service.js': { pricingService: {} },
  '../src/modules/account/account_openai_responses_service.js': {
    openaiResponsesAccountService: { getAccount: jest.fn().mockResolvedValue(account) }
  },
  '../src/modules/account/account_claude_service.js': { claudeAccountService: {} },
  '../src/modules/account/account_claude_console_service.js': { claudeConsoleAccountService: {} },
  '../src/modules/account/account_ccr_service.js': { ccrAccountService: {} },
  '../src/modules/account/account_gemini_service.js': {},
  '../src/modules/account/account_gemini_api_service.js': { geminiApiAccountService: {} },
  '../src/modules/account/account_openai_service.js': {},
  '../src/modules/account/account_azure_openai_service.js': {},
  '../src/modules/account/account_droid_service.js': { droidAccountService: {} },
  '../src/modules/account/account_bedrock_service.js': { bedrockAccountService: {} }
}
for (const [name, exports] of Object.entries(modules)) {
  jest.unstable_mockModule(name, () => exports)
}
const { router } = await import('../src/modules/admin/admin_usage_stats_routes.js')
const app = express().use('/admin', router)
const requestApi = async (path, query) => {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}${path}?${new URLSearchParams(query)}`
    const response = await fetch(url)
    return { status: response.status, body: await response.json() }
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

beforeEach(() => jest.clearAllMocks())

it('queries an account without enhancing all keys and preserves summary and pagination', async () => {
  const response = await requestApi('/admin/accounts/acct/usage-records', {
    platform: 'openai-responses',
    pageSize: 1,
    sortOrder: 'asc'
  })
  expect(response.status).toBe(200)
  expect(response.body.data.pagination).toMatchObject({ totalRecords: 2, totalPages: 2 })
  expect(response.body.data.summary).toMatchObject({
    totalRequests: 2,
    totalCost: 2,
    totalTokens: 35
  })
  expect(response.body.data.records[0]).toMatchObject({
    cost: 0,
    realCost: 1e-10,
    upstreamCostTicks: '1',
    realCostSource: 'upstream'
  })
  expect(getAllApiKeysFast).not.toHaveBeenCalled()
  expect(calculateCost).not.toHaveBeenCalled()
})

it('selects the requested key before any global key lookup', async () => {
  const response = await requestApi('/admin/accounts/acct/usage-records', {
    platform: 'openai-responses',
    apiKeyId: 'removed-key',
    model: 'grok-test'
  })
  expect(response.status).toBe(200)
  expect(redis.scanApiKeyIds).not.toHaveBeenCalled()
  expect(redis.iterateUsageRecordBatches).toHaveBeenCalledWith(['removed-key'])
  expect(response.body.data.records).toHaveLength(1)
})

it('API Key timeline preserves stored costs and exact official cost too', async () => {
  const response = await requestApi('/admin/api-keys/key/usage-records', {
    accountId: 'acct',
    model: 'grok-test'
  })
  expect(response.status).toBe(200)
  expect(response.body.data.records[0]).toMatchObject({ realCost: 1e-10, cost: 0 })
  expect(calculateCost).not.toHaveBeenCalled()
})
