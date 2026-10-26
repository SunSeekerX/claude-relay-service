import { beforeEach, expect, jest, test } from '@jest/globals'
import { hasPermission } from '../src/common/compat_permissions.js'

let keyData
let route
await jest.unstable_mockModule('../src/modules/apikey/apikey_service.js', () => ({
  apiKeyService: { validateApiKey: async () => ({ valid: true, keyData: { ...keyData } }), hasPermission },
}))
await jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: { getRelayRoute: async (code) => (code === 'grok-entry' ? route : null) },
}))
await jest.unstable_mockModule('../src/modules/account/account_group_service.js', () => ({
  accountGroupService: { getGroup: async (id) => ({ id, platform: 'grok', name: 'Grok 组' }) },
}))
await jest.unstable_mockModule('../src/modules/pricing/pricing_model_service.js', () => ({ modelService: {} }))
await jest.unstable_mockModule('../src/modules/payment/payment_balance_ledger.js', () => ({ balanceLedger: {} }))
await jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: { warn: jest.fn(), security: jest.fn(), error: jest.fn() },
}))
const { validateWsApiKey } = await import('../src/common/gateway_ws_api_key_auth.js')
beforeEach(() => {
  route = {
    code: 'grok-entry',
    name: 'Grok 入口',
    provider: 'grok',
    binding: 'group:g-group',
    formats: ['openai-responses'],
    isActive: true,
  }
  keyData = {
    id: 'key1',
    permissions: ['grok'],
    billingMode: 'postpaid',
    openaiAccountId: 'legacy-openai',
    grokAccountId: 'legacy-grok',
    relayRouting: { allowedRoutes: ['grok-entry'], defaults: { 'openai-responses': 'grok-entry' } },
  }
})
const check = (path, permission) =>
  validateWsApiKey(
    { url: path, headers: { authorization: 'Bearer fixture-api-key' } },
    new URL(path, 'http://localhost'),
    permission,
  )

test('named and default WS routes authorize the actual target service rather than assuming OpenAI', async () => {
  for (const path of ['/r/grok-entry/v1/responses', '/v1/responses']) {
    const result = await check(path)
    expect(result.ok).toBe(true)
    expect(result.keyData).toMatchObject({ id: 'key1', grokAccountId: 'group:g-group', openaiAccountId: '' })
    expect(result.keyData._relayRoute.code).toBe('grok-entry')
  }
  expect(keyData.openaiAccountId).toBe('legacy-openai')
})

test('explicit legacy provider paths retain their binding and do not pick protocol defaults', async () => {
  const result = await check('/grok/v1/responses', 'grok')
  expect(result.ok).toBe(true)
  expect(result.keyData.grokAccountId).toBe('legacy-grok')
  expect(result.keyData._relayRoute).toBeUndefined()
})

test('revoked or disabled WS entry fails before a connection can select an outside account', async () => {
  keyData.relayRouting = { allowedRoutes: [], defaults: {} }
  expect(await check('/r/grok-entry/v1/responses')).toMatchObject({ ok: false, status: 403 })
  keyData.relayRouting = { allowedRoutes: ['grok-entry'], defaults: { 'openai-responses': 'grok-entry' } }
  route.isActive = false
  expect(await check('/v1/responses')).toMatchObject({ ok: false, status: 503 })
})
