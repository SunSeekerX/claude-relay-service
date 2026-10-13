import { jest } from '@jest/globals'
import express from 'express'
import { createServer } from 'node:http'
import { getDateStringInTimezone, getDateInTimezone } from '../src/common/timezone.js'

const getGlobalModelUsage = jest.fn()
const resolveModelStatsCost = jest.fn((stats) => ({
  costs: { total: stats.ratedCostMicro / 1e6 },
  formatted: { total: String(stats.ratedCostMicro / 1e6) },
  pricing: {},
  source: 'fixture'
}))
const redis = { getGlobalModelUsage, getDateStringInTimezone, getDateInTimezone }
const mocks = {
  '../src/infra/redis.js': { redis },
  '../src/infra/middleware_auth.js': { authenticateAdmin: (_req, _res, next) => next() },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: {} },
  '../src/modules/pricing/pricing_cost_calculator.js': {
    CostCalculator: { resolveModelStatsCost }
  },
  '../src/modules/account/account_claude_service.js': { claudeAccountService: {} },
  '../src/modules/account/account_claude_console_service.js': { claudeConsoleAccountService: {} },
  '../src/modules/account/account_bedrock_service.js': { bedrockAccountService: {} },
  '../src/modules/account/account_ccr_service.js': { ccrAccountService: {} },
  '../src/modules/account/account_gemini_service.js': {},
  '../src/modules/account/account_droid_service.js': { droidAccountService: {} },
  '../src/modules/account/account_grok_service.js': { grokAccountService: {} },
  '../src/modules/account/account_openai_responses_service.js': {
    openaiResponsesAccountService: {}
  },
  '../src/modules/account/account_azure_openai_service.js': {},
  '../src/modules/relay/relay_upstream_error_helper.js': {}
}
for (const [name, exports] of Object.entries(mocks)) {
  jest.unstable_mockModule(name, () => exports)
}
const { router } = await import('../src/modules/admin/admin_dashboard_routes.js')
const app = express().use('/admin', router)
const requestStats = async (query) => {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/admin/model-stats?${new URLSearchParams(query)}`
    const response = await fetch(url)
    return { status: response.status, body: await response.json() }
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  getGlobalModelUsage.mockReset().mockResolvedValue([])
})

it.each(['daily', 'monthly'])('selects the %s index for the default period', async (period) => {
  const response = await requestStats({ period })
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ code: 200, data: [] })
  const date = getDateInTimezone()
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  expect(getGlobalModelUsage).toHaveBeenCalledWith(
    period,
    period === 'daily' ? getDateStringInTimezone() : month
  )
})

it('aggregates custom days including empty days with the existing usage and cost contracts', async () => {
  getGlobalModelUsage.mockImplementation(async (_period, date) =>
    date === '2026-10-12'
      ? []
      : [
          {
            key: `usage:model:daily:claude-test:${date}`,
            data: {
              requests: '2',
              inputTokens: '10',
              outputTokens: '9',
              cacheCreateTokens: '3',
              cacheReadTokens: '4',
              allTokens: '26',
              ephemeral5mTokens: '1',
              ephemeral1hTokens: '2',
              ratedCostMicro: '5',
              realCostMicro: '7',
              costedRequests: '2'
            }
          }
        ]
  )
  const response = await requestStats({
    period: 'monthly',
    startDate: '2026-10-11',
    endDate: '2026-10-13'
  })
  expect(getGlobalModelUsage.mock.calls).toEqual([
    ['daily', '2026-10-11'],
    ['daily', '2026-10-12'],
    ['daily', '2026-10-13']
  ])
  expect(response.body.data).toHaveLength(1)
  expect(response.body.data[0]).toMatchObject({
    model: 'claude-test',
    period: 'custom',
    requests: 4,
    inputTokens: 20,
    outputTokens: 18,
    cacheCreateTokens: 6,
    cacheReadTokens: 8,
    allTokens: 52,
    usage: { totalTokens: 52 },
    costs: { total: 0.00001 },
    costSource: 'fixture'
  })
  expect(resolveModelStatsCost).toHaveBeenCalledWith(
    expect.objectContaining({
      realCostMicro: 14,
      ratedCostMicro: 10,
      ephemeral5mTokens: 2,
      ephemeral1hTokens: 4
    }),
    'claude-test'
  )
})

it.each([
  { startDate: '2026-10-13', endDate: '2026-10-12' },
  { startDate: '2025-01-01', endDate: '2026-10-13' }
])('keeps invalid date-range errors within the existing admin envelope', async (query) => {
  const response = await requestStats(query)
  expect(response.body.code).toBe(400)
  expect(getGlobalModelUsage).not.toHaveBeenCalled()
})
