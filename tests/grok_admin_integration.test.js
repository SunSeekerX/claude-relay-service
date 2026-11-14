import { expect, jest, test } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const account = { id: 'a', name: 'fixture', authType: 'apikey', apiKey: 'fixture-credential' }
const windows = {
  fiveHour: { cost: 0.125, requests: 2 },
  oneDay: { cost: 0.25 },
  sevenDay: { cost: 1 },
  thirtyDay: { cost: 2 },
}
const recordQuotaObservation = jest.fn().mockResolvedValue()
const post = jest.fn().mockResolvedValue({
  status: 200,
  data: { choices: [{ message: { content: 'fixture' } }] },
  headers: { 'x-ratelimit-limit-tokens': '10' },
})
const pipeline = {
  hgetall: () => pipeline,
  exec: async () => [
    [null, {}],
    [null, { requests: '2' }],
    [null, {}],
  ],
}
const mocks = {
  axios: { default: { post } },
  '../src/modules/account/account_grok_service.js': {
    grokAccountService: {
      getAllAccounts: async () => [{ ...account, apiKey: '***' }],
      ensureFreshToken: async () => account,
      getUpstreamBaseUrl: () => 'https://api.x.ai/v1',
      recordQuotaObservation,
    },
  },
  '../src/infra/redis.js': {
    redis: {
      getClientSafe: () => ({ pipeline: () => pipeline }),
      getDateStringInTimezone: () => '2026-11-14',
      getDateInTimezone: () => new Date('2026-11-14T00:00:00Z'),
      batchGetAccountDailyCost: async () => new Map([['a', 1]]),
      batchGetAccountRollingUsage: async () => new Map([['a', windows]]),
    },
  },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: { getAllApiKeysLite: async () => [] } },
  '../src/modules/account/account_group_service.js': {
    accountGroupService: { batchGetAccountGroupsByIndex: async () => new Map() },
  },
  '../src/infra/middleware_auth.js': { authenticateAdmin: (_req, _res, next) => next() },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/modules/relay/relay_test_model_config_service.js': {
    testModelConfigService: { resolveAccountModel: async () => 'grok-4.7' },
  },
  '../src/modules/relay/relay_test_prompt_config_service.js': {
    testPromptConfigService: { resolvePrompt: async () => 'fixture' },
  },
  '../src/modules/proxy/proxy_helper.js': { ProxyHelper: {} },
  '../src/modules/proxy/proxy_resolver.js': { proxyResolver: {} },
}
for (const [path, exports] of Object.entries(mocks)) {
  jest.unstable_mockModule(path, () => exports)
}
const { router } = await import('../src/modules/account/account_grok_routes.js')
const app = express()
app.use(express.json())
app.use('/admin', router)

test('Grok admin list includes the integrated rolling windows in the existing envelope', async () => {
  const response = await request(app).get('/admin/grok-accounts')
  expect(response.status).toBe(200)
  expect(response.body.code).toBe(200)
  expect(response.body.data[0]).toMatchObject({
    id: 'a',
    apiKey: '***',
    rollingUsage: windows,
    usage: { daily: { requests: 2 } },
  })
})
test('Grok admin account tests retain observed headers and return the existing JSON result contract', async () => {
  const response = await request(app).post('/admin/grok-accounts/a/test').send({ model: 'grok-4.7' })
  expect(response.body).toMatchObject({ code: 200, data: { ok: true, model: 'grok-4.7', status: 200 } })
  expect(recordQuotaObservation).toHaveBeenCalledWith(
    'a',
    { 'x-ratelimit-limit-tokens': '10' },
    { statusCode: 200, model: 'grok-4.7' },
  )
})
