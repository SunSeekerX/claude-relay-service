import { afterAll, jest, expect, test } from '@jest/globals'
jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
afterAll(() => { jest.clearAllTimers(); jest.useRealTimers() })
import { buildTokenUsagePayload, normalizeOpenAITokenUsage } from '../src/modules/relay/relay_request_detail_helper.js'

const redis = Object.fromEntries(
  [
    'incrementDailyCost',
    'incrementTokenUsage',
    'incrementAccountUsage',
    'setApiKeyWithLastUsedIndex',
    'addUsageRecord',
  ].map((name) => [name, jest.fn(async () => true)]),
)
redis.getApiKey = jest.fn(async () => ({ id: 'fixture-key', permissions: ['openai'] }))
redis.getClientSafe = jest.fn(() => ({}))
const captureRequestDetail = jest.fn(async () => {})
await jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis }))
await jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: new Proxy({}, { get: () => jest.fn() }) }))
await jest.unstable_mockModule('../src/modules/relay/relay_request_detail_service.js', () => ({
  requestDetailService: { captureRequestDetail },
}))
await jest.unstable_mockModule('../src/modules/relay/relay_routing_service.js', () => ({
  validateKeyRouting: jest.fn(),
}))
await jest.unstable_mockModule('../src/modules/pricing/pricing_model_service.js', () => ({
  modelService: { getInternalBillingModel: () => null },
}))
const { pricingService } = await import('../src/modules/pricing/pricing_service.js')
const { apiKeyService } = await import('../src/modules/apikey/apikey_service.js')

test('actual usage recording charges once and propagates TTL through quota statistics, records and request details', async () => {
  const originalPricing = pricingService.pricingData
  const rate = jest
    .spyOn(apiKeyService, 'calculateRatedCost')
    .mockImplementation(async (_key, _service, cost) => cost * 2)
  const group = jest.spyOn(apiKeyService, '_recordBoundGroupCost').mockResolvedValue(undefined)
  const publish = jest.spyOn(apiKeyService, '_publishUsageRecordEvent').mockResolvedValue(undefined)
  const opus = jest.spyOn(apiKeyService, 'recordOpusCost').mockResolvedValue(undefined)
  try {
    pricingService.pricingData = {
      'fixture-openai': {
        litellm_provider: 'openai',
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        cache_read_input_token_cost: 0.0000001,
        cache_creation_input_token_cost: 0.00000125,
        cache_creation_input_token_cost_above_12hr: 0.0000025,
      },
    }
    const raw = {
      input_tokens: 12000,
      output_tokens: 0,
      input_tokens_details: {
        cached_tokens: 4000,
        cache_write_tokens: 7000,
        cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
      },
    }
    const payload = buildTokenUsagePayload({ ...normalizeOpenAITokenUsage(raw), rawUsage: raw })
    const result = await apiKeyService.recordUsage(
      'fixture-key',
      payload,
      'fixture-openai',
      'fixture-account',
      'openai',
      'default',
      { requestId: 'fixture-request', endpoint: '/v1/responses', statusCode: 200, stream: true },
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(result.realCost).toBeCloseTo(0.01515, 10)
    expect(result.ratedCost).toBeCloseTo(0.0303, 10)
    expect(redis.incrementDailyCost).toHaveBeenCalledTimes(1)
    expect(redis.incrementDailyCost.mock.calls[0][0]).toBe('fixture-key')
    expect(redis.incrementDailyCost.mock.calls[0][1]).toBeCloseTo(0.0303, 10)
    expect(redis.incrementDailyCost.mock.calls[0][2]).toBeCloseTo(0.01515, 10)
    expect(redis.incrementTokenUsage.mock.calls[0].at(-1)).toEqual({ ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 })
    expect(redis.incrementAccountUsage.mock.calls[0].at(-1)).toEqual({ ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 })
    const record = redis.addUsageRecord.mock.calls[0][1]
    expect(record.billingAudit).toBeUndefined()
    expect(captureRequestDetail.mock.calls[0][0].billingAudit).toMatchObject({
      model: 'fixture-openai', serviceTier: 'default', upstreamUsage: raw,
      pricingSnapshot: { input: 1, output: 2 }, effectiveRate: 2
    })
    expect(record).toMatchObject({
      inputTokens: 1000,
      cacheReadTokens: 4000,
      cacheCreateTokens: 7000,
      totalTokens: 12000,
      cacheWrite30mTokens: 3000,
      cacheWrite12hTokens: 4000,
      cost: 0.0303,
      realCost: 0.01515,
    })
    expect(captureRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'fixture-request',
        cacheWrite30mTokens: 3000,
        cacheWrite12hTokens: 4000,
        cost: 0.0303,
        realCost: 0.01515,
      }),
    )
    redis.addUsageRecord.mockClear()
    redis.incrementTokenUsage.mockClear()
    redis.incrementAccountUsage.mockClear()
    await apiKeyService.recordUsageWithDetails('fixture-key', payload, 'fixture-openai', 'fixture-account', 'openai', {
      requestId: 'fixture-detailed-request',
      statusCode: 200,
    })
    const detailed = redis.addUsageRecord.mock.calls[0][1]
    expect(detailed.realCost).toBeCloseTo(0.01515, 10)
    expect(detailed.realCostBreakdown.cacheWrite12h).toBeCloseTo(0.01, 10)
    expect(redis.incrementTokenUsage.mock.calls[0].at(-1)).toEqual({ ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 })
    expect(redis.incrementAccountUsage.mock.calls[0].at(-1)).toEqual({ ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 })
  } finally {
    pricingService.pricingData = originalPricing
    for (const spy of [rate, group, publish, opus]) {
      spy.mockRestore()
    }
  }
})
