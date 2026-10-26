import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { scopeRouteSession } from '../src/modules/relay/relay_route_context.js'

let keyData
const routes = new Map()
const mockDispatcher = jest.fn(async (req, res) => {
  await Promise.resolve()
  res.json({
    keyId: req.apiKey.id,
    routeCode: req.apiKey._relayRoute.code,
    binding: req.apiKey.claudeAccountId,
    mappedBody: req.body.model,
    session: scopeRouteSession('same-session'),
    mapping: req._relayRouteModel,
  })
})
await jest.unstable_mockModule('../src/modules/relay/relay_routing_dispatch.js', () => ({
  dispatchRoutedRequest: mockDispatcher,
}))
await jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: {
    getRelayRoute: async (code) => routes.get(code) ?? null,
    getNextResetTime: () => new Date(Date.now() + 60000),
    getAccountModelState: async (type, id) =>
      type === 'claude-official'
        ? {
            id,
            supportedModels: ['claude-a'],
            isActive: true,
            accessToken: 'fixture-token',
            expiresAt: '2099-01-01T00:00:00Z',
          }
        : null,
    getAccountModelObservation: async () => ({ temporary: false, overloaded: false, concurrency: 0 }),
  },
}))
await jest.unstable_mockModule('../src/modules/apikey/apikey_service.js', () => ({
  apiKeyService: { validateApiKey: async () => ({ valid: true, keyData: { ...keyData } }) },
}))
await jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: Object.fromEntries(
    ['api', 'error', 'security', 'warn', 'debug', 'info', 'success'].map((name) => [name, jest.fn()]),
  ),
}))
await jest.unstable_mockModule('../src/modules/user/user_service.js', () => ({ userService: {} }))
await jest.unstable_mockModule('../src/modules/account/account_group_service.js', () => ({
  accountGroupService: {
    getGroup: async (id) => ({ id, name: id, platform: 'claude' }),
    getGroupMembers: async () => ['fixture-account'],
  },
}))
await jest.unstable_mockModule('../src/modules/account/account_group_policy.js', () => ({
  collectExclusiveMemberIds: async () => new Set(),
  getGroupSchedulingSnapshot: async () => null,
  releaseGroupCostHolds: jest.fn(),
}))
await jest.unstable_mockModule('../src/modules/pricing/pricing_model_service.js', () => ({
  modelService: { getAllModels: () => [{ id: 'claude-a' }] },
}))
await jest.unstable_mockModule('../src/modules/account/account_claude_service.js', () => ({
  claudeAccountService: { getAccount: async (id) => ({ id, supportedModels: ['claude-a'] }) },
}))
await jest.unstable_mockModule('../src/modules/relay/relay_unified_claude_scheduler.js', () => ({
  unifiedClaudeScheduler: {
    _isModelSupportedByAccount: (account, _type, model) => account.supportedModels.includes(model),
  },
}))
await jest.unstable_mockModule('../src/modules/relay/relay_claude_relay_config_service.js', () => ({
  claudeRelayConfigService: { isClaudeCodeOnlyEnabled: async () => false },
}))
await jest.unstable_mockModule('../src/modules/payment/payment_balance_ledger.js', () => ({ balanceLedger: {} }))
const { authenticateApiKey } = await import('../src/infra/middleware_auth.js')

const app = express()
app.use(express.json())
const named = express.Router({ mergeParams: true })
named.use(authenticateApiKey)
app.use('/r/:routeCode', named)
const legacyApi = express.Router()
legacyApi.get('/v1/models', authenticateApiKey, (_req, res) => res.json({ legacyModels: true }))
app.use('/api', legacyApi)
app.post('/v1/messages', authenticateApiKey, (req, res) =>
  res.json({ legacy: true, binding: req.apiKey.claudeAccountId }),
)

beforeEach(() => {
  routes.clear()
  mockDispatcher.mockClear()
  for (const code of ['a', 'b']) {
    routes.set(code, {
      code,
      name: code,
      provider: 'claude',
      binding: `group:${code}`,
      formats: ['claude-messages'],
      isActive: true,
      modelMapping: { alias: 'claude-a' },
      echoModel: 'upstream',
    })
  }
  keyData = {
    id: 'same-key',
    name: 'test',
    claudeAccountId: 'legacy-account',
    permissions: ['claude'],
    relayRouting: { allowedRoutes: ['a', 'b'], defaults: {} },
    concurrencyLimit: 0,
    rateLimitWindow: 0,
    billingMode: 'postpaid',
    dailyCostLimit: 0,
    totalCostLimit: 0,
    weeklyOpusCostLimit: 0,
  }
})
const invoke = (path, model = 'alias') =>
  request(app)
    .post(path)
    .set('x-api-key', 'test-api-key-at-least-ten-chars')
    .send({ model, messages: [{ role: 'user', content: 'hello' }] })

describe('real HTTP authentication with entry routing', () => {
  test('default model discovery exposes configured aliases instead of the legacy model list', async () => {
    const before = await request(app).get('/api/v1/models').set('x-api-key', 'fixture-long-key')
    expect(before.body.legacyModels).toBe(true)
    keyData.relayRouting.defaults['claude-messages'] = 'b'
    routes.get('b').modelMode = 'mapped-only'
    const after = await request(app).get('/api/v1/models').set('x-api-key', 'fixture-long-key')
    expect(after.status).toBe(200)
    expect(after.body.data.map((model) => model.id)).toEqual(['alias'])
  })
  test('same key explicitly selects different groups with separate session state', async () => {
    const [a, b] = await Promise.all([invoke('/r/a/v1/messages'), invoke('/r/b/v1/messages')])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.body).toMatchObject({
      keyId: 'same-key',
      binding: 'group:a',
      mappedBody: 'claude-a',
      mapping: { requestedModel: 'alias', mappedModel: 'claude-a' },
    })
    expect(b.body).toMatchObject({ keyId: 'same-key', binding: 'group:b' })
    expect(a.body.session).not.toBe(b.body.session)
    expect(keyData.claudeAccountId).toBe('legacy-account')
  })

  test('ordinary address preserves legacy behavior until a protocol default is assigned', async () => {
    const legacy = await invoke('/v1/messages', 'claude-a')
    expect(legacy.body).toMatchObject({ legacy: true, binding: 'legacy-account' })
    keyData.relayRouting.defaults['claude-messages'] = 'b'
    const routed = await invoke('/v1/messages')
    expect(routed.body.routeCode).toBe('b')
  })

  test('ungranted and disabled entries never reach the request handler', async () => {
    keyData.relayRouting.allowedRoutes = ['b']
    expect((await invoke('/r/a/v1/messages')).status).toBe(403)
    routes.get('b').isActive = false
    keyData.relayRouting.defaults['claude-messages'] = 'b'
    expect((await invoke('/v1/messages')).status).toBe(503)
    expect(mockDispatcher).not.toHaveBeenCalled()
  })

  test('mapped aliases cannot bypass a Key model blacklist', async () => {
    keyData.enableModelRestriction = true
    keyData.restrictedModels = ['claude-a']
    expect((await invoke('/r/a/v1/messages')).status).toBe(403)
    expect(mockDispatcher).not.toHaveBeenCalled()
  })

  test('Claude weekly cap is checked against resolved model before dispatch', async () => {
    keyData.weeklyOpusCostLimit = 1
    keyData.weeklyOpusCost = 1
    const response = await invoke('/r/a/v1/messages')
    expect(response.status).toBe(402)
    expect(mockDispatcher).not.toHaveBeenCalled()
  })
})
