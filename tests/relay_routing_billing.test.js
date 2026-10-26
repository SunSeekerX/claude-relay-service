import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { runWithRelayRoute } from '../src/modules/relay/relay_route_context.js'

const groups = { legacy: 10, a: 2, b: 3, free: 0 }
const recordGroupUsageCost = jest.fn()
const getGroup = jest.fn(async (id) => ({ id, rateMultiplier: groups[id] }))
await jest.unstable_mockModule('../src/modules/relay/relay_request_detail_service.js', () => ({
  requestDetailService: {},
}))
await jest.unstable_mockModule('../src/modules/pricing/pricing_model_service.js', () => ({
  modelService: { getAllModels: () => [] },
}))
await jest.unstable_mockModule('../src/modules/pricing/pricing_cost_calculator.js', () => ({
  CostCalculator: class {},
}))
await jest.unstable_mockModule('../src/modules/pricing/pricing_cost_rank_service.js', () => ({ costRankService: {} }))
await jest.unstable_mockModule('../src/modules/payment/payment_billing_event_publisher.js', () => ({
  billingEventPublisher: {},
}))
await jest.unstable_mockModule('../src/modules/pricing/pricing_grok_media_overlay_service.js', () => ({
  grokMediaPricingOverlayService: {},
}))
await jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: { getApiKey: async () => ({ claudeAccountId: 'group:legacy', serviceRates: '{"claude":4}' }) },
}))
await jest.unstable_mockModule('../src/modules/payment/payment_service_rates_service.js', () => ({
  serviceRatesService: { getServiceRate: async () => 5 },
}))
await jest.unstable_mockModule('../src/modules/account/account_group_service.js', () => ({
  accountGroupService: { getGroup },
}))
await jest.unstable_mockModule('../src/modules/account/account_group_policy.js', () => ({
  collectExclusiveMemberIds: async () => new Set(),
  getGroupSchedulingSnapshot: async () => null,
  extractBoundGroupIdForAccountType: () => 'legacy',
  extractBoundGroupIdForService: () => 'legacy',
  recordGroupUsageCost,
}))
await jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: Object.fromEntries(
    ['warn', 'error', 'debug', 'info', 'api', 'success', 'security', 'database'].map((name) => [name, jest.fn()]),
  ),
}))
jest.useFakeTimers()
const { apiKeyService } = await import('../src/modules/apikey/apikey_service.js')
afterAll(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
})
beforeEach(() => {
  getGroup.mockClear()
  recordGroupUsageCost.mockClear()
})
const key = (binding) => ({ id: 'key1', _relayRoute: { code: binding, provider: 'claude', binding } })

describe('actual selected entry owns group multiplier and usage', () => {
  test('different named groups use their own multiplier, same original Key rate', async () => {
    const [a, b] = await Promise.all([
      runWithRelayRoute(key('group:a'), () => apiKeyService.calculateRatedCost('key1', 'claude', 1, 'claude-official')),
      runWithRelayRoute(key('group:b'), () => apiKeyService.calculateRatedCost('key1', 'claude', 1, 'claude-official')),
    ])
    expect(a).toBe(40)
    expect(b).toBe(60)
  })

  test('single-account entries do not inherit an old bound group and zero group rates survive', async () => {
    expect(
      await runWithRelayRoute(key('account1'), () =>
        apiKeyService.calculateRatedCost('key1', 'claude', 1, 'claude-official'),
      ),
    ).toBe(20)
    expect(
      await runWithRelayRoute(key('group:free'), () =>
        apiKeyService.calculateRatedCost('key1', 'claude', 1, 'claude-official'),
      ),
    ).toBe(0)
    expect(await apiKeyService.calculateRatedCost('key1', 'claude', 1, 'claude-official')).toBe(200)
  })

  test('explicit request metadata preserves the group across deferred billing', async () => {
    expect(await apiKeyService.calculateRatedCost('key1', 'claude', 1, 'claude-official', { groupId: 'b' })).toBe(60)
    await apiKeyService._recordBoundGroupCost('key1', 7, 'claude-official', null, { groupId: 'b' })
    expect(recordGroupUsageCost).toHaveBeenCalledWith('b', 7)
    recordGroupUsageCost.mockClear()
    await apiKeyService._recordBoundGroupCost('key1', 7, 'claude-official', null, { groupId: null })
    expect(recordGroupUsageCost).not.toHaveBeenCalled()
  })
})
