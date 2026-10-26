import { jest } from '@jest/globals'
import {
  calculateGrokToolCost,
  getGrokUpstreamCost,
  GROK_TOOL_UNIT_PRICES,
} from '../src/modules/pricing/pricing_grok_tool_pricing.js'

const redis = {
  getApiKey: jest.fn().mockResolvedValue({ id: 'key', name: 'fixture', serviceRates: '{"grok":3}' }),
  incrementDailyCost: jest.fn(),
  incrementTokenUsage: jest.fn(),
  incrementAccountUsage: jest.fn(),
  addUsageRecord: jest.fn(),
  setApiKeyWithLastUsedIndex: jest.fn(),
  getClientSafe: () => ({ xadd: publish }),
}
const publish = jest.fn().mockResolvedValue('1-0')
const captureRequestDetail = jest.fn().mockResolvedValue()
const mocks = {
  '../src/modules/relay/relay_routing_service.js': { validateKeyRouting: jest.fn() },
  '../config/config.js': { config: { security: { apiKeyPrefix: 'cr_' } } },
  '../config/env.js': { env: { BILLING_EVENTS_ENABLED: 'true' } },
  '../src/infra/redis.js': { redis },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/modules/pricing/pricing_cost_calculator.js': {
    CostCalculator: { calculateCost: jest.fn(() => ({ costs: { input: 1, output: 0, total: 1 } })) },
  },
  '../src/modules/payment/payment_service_rates_service.js': {
    serviceRatesService: {
      getService: () => 'grok',
      getServiceRate: jest.fn().mockResolvedValue(2),
    },
  },
  '../src/modules/pricing/pricing_grok_media_overlay_service.js': {
    grokMediaPricingOverlayService: {
      getEffectiveModelPricing: jest.fn().mockResolvedValue({ xai_tool_costs_per_unit: GROK_TOOL_UNIT_PRICES }),
    },
  },
  '../src/modules/relay/relay_request_detail_service.js': {
    requestDetailService: { captureRequestDetail },
  },
  '../src/modules/apikey/apikey_index_service.js': { apiKeyIndexService: {} },
  '../src/modules/pricing/pricing_cost_rank_service.js': { costRankService: {} },
  '../src/modules/account/account_group_policy.js': {
    extractBoundGroupIdForAccountType: () => null,
    extractBoundGroupIdForService: () => null,
  },
}
for (const [name, exports] of Object.entries(mocks)) {
  jest.unstable_mockModule(name, () => exports)
}
const { apiKeyService } = await import('../src/modules/apikey/apikey_service.js')
const { CostCalculator } = await import('../src/modules/pricing/pricing_cost_calculator.js')
const { buildBillingEvent, billingEventPublisher } =
  await import('../src/modules/payment/payment_billing_event_publisher.js')
const usage = {
  input_tokens: 10,
  output_tokens: 2,
  server_side_tool_usage_details: { web_search_calls: 2, x_posts_fetched: 1, x_users_fetched: 3 },
}
const meta = { requestId: 'turn', billingDedupId: 'business-id', throwOnBillingFailure: true }

beforeEach(() => {
  jest.clearAllMocks()
  redis.incrementDailyCost.mockReset().mockResolvedValue(true)
  publish.mockClear()
})

describe('Grok price table and upstream actual cost', () => {
  it.each(['0', '1', '100000000'])(
    'bills tools using existing rates while retaining independent official ticks %s',
    async (ticks) => {
      const costs = await apiKeyService.recordUsage(
        'key',
        { ...usage, cost_in_usd_ticks: ticks },
        'grok-test',
        'account',
        'grok',
        meta,
      )
      expect(costs.realCost).toBe(Number(ticks) / 1e10)
      expect(costs.ratedCost).toBeCloseTo(1.045 * 6)
      expect(redis.incrementDailyCost.mock.calls[0][3].dedupId).toBe('business-id')
      const record = redis.addUsageRecord.mock.calls[0][1]
      expect(record).toMatchObject({
        realCostSource: 'upstream',
        upstreamCostTicks: ticks,
        baseCost: 1.045,
        toolCost: 0.045,
      })
      expect(captureRequestDetail.mock.calls[0][0].realCost).toBe(Number(ticks) / 1e10)
      const event = JSON.parse(publish.mock.calls[0].at(-1))
      expect(event.context.requestId).toBe('turn')
      expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/)
      expect(event.cost).toMatchObject({
        total: Number(ticks) / 1e10,
        real: Number(ticks) / 1e10,
        base: 1.045,
        tools: 0.045,
      })
      expect(event.cost.rated).toBeCloseTo(6.27)
      expect(event.usage.toolUsage).toEqual(usage.server_side_tool_usage_details)
    },
  )

  it('uses the price table estimate only when official actual cost is absent', async () => {
    const costs = await apiKeyService.recordUsage('key', usage, 'grok-test', 'account', 'grok', meta)
    expect(costs.realCost).toBeCloseTo(1.045)
    expect(redis.addUsageRecord.mock.calls[0][1].realCostSource).toBe('price_table')
  })

  it('skips records and events on a duplicate ledger write while returning the computed amount', async () => {
    redis.incrementDailyCost.mockResolvedValueOnce(false)
    const result = await apiKeyService.recordUsage('key', usage, 'grok-test', 'account', 'grok', meta)
    expect(result).toMatchObject({ duplicate: true, realCost: 1.045 })
    expect(redis.incrementTokenUsage).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('propagates a critical billing failure to turn admission', async () => {
    redis.incrementDailyCost.mockRejectedValueOnce(new Error('ledger offline'))
    await expect(apiKeyService.recordUsage('key', usage, 'grok-test', 'account', 'grok', meta)).rejects.toThrow(
      'ledger offline',
    )
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects corrupt tool counts and actual-cost ticks', () => {
    expect(() =>
      calculateGrokToolCost({ server_side_tool_usage_details: { web_search_calls: -1 } }, GROK_TOOL_UNIT_PRICES),
    ).toThrow()
    expect(() => getGrokUpstreamCost({ cost_in_usd_ticks: 'NaN' })).toThrow()
    expect(getGrokUpstreamCost({ cost_in_usd_ticks: 0 })).toEqual({ ticks: '0', amount: 0 })
  })

  it('publishes ordinary token records and preserves complete event fields in batch mode', async () => {
    await apiKeyService.recordUsage(
      'key',
      { input_tokens: 10, output_tokens: 2 },
      'gpt-test',
      'account',
      'openai',
      'priority',
      meta,
    )
    expect(publish).toHaveBeenCalledTimes(1)
    const event = JSON.parse(publish.mock.calls[0].at(-1))
    expect(event.context.serviceTier).toBe('priority')
    expect(event.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    const eventData = {
      keyId: 'key',
      realCost: 0,
      ratedCost: 1,
      baseCost: 2,
      toolUsage: { web_search_calls: 1 },
      requestId: 'batch',
    }
    const xadd = jest.fn()
    redis.getClientSafe = () => ({
      pipeline: () => ({ xadd, exec: jest.fn().mockResolvedValue([[null, '2-0']]) }),
    })
    await billingEventPublisher.publishBatchBillingEvents([eventData])
    expect(JSON.parse(xadd.mock.calls[0].at(-1))).toMatchObject({
      context: { requestId: 'batch' },
      cost: { total: 0, rated: 1, base: 2 },
      usage: { toolUsage: { web_search_calls: 1 } },
    })
    expect(buildBillingEvent(eventData).cost.real).toBe(0)
    redis.getClientSafe = () => ({ xadd: publish })
  })
})

it.each(['regular', 'details'])(
  'retains new cache lifetimes and actual speed through %s usage settlement',
  async (mode) => {
    const usageObject = {
      input_tokens: 1000,
      output_tokens: 0,
      cache_creation_input_tokens: 7000,
      cache_read_input_tokens: 4000,
      cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
      speed: 'standard',
      request_speed: 'fast',
      request_anthropic_beta: 'fast-mode-2026-02-01',
    }
    CostCalculator.calculateCost.mockReturnValueOnce({
      costs: {
        input: 0.001,
        output: 0,
        cacheRead: 0.0004,
        cacheCreate: 0.01375,
        cacheWrite30m: 0.00375,
        cacheWrite12h: 0.01,
        total: 0.01515,
      },
    })
    if (mode === 'regular') {
      await apiKeyService.recordUsage(
        'key',
        usageObject,
        'fixture-openai',
        'account',
        'openai-responses',
        'default',
        meta,
      )
    } else {
      await apiKeyService.recordUsageWithDetails(
        'key',
        usageObject,
        'fixture-openai',
        'account',
        'openai-responses',
        meta,
      )
    }
    expect(CostCalculator.calculateCost).toHaveBeenCalledWith(
      expect.objectContaining({
        speed: 'standard',
        request_speed: 'fast',
        cache_write_tokens_details: usageObject.cache_write_tokens_details,
      }),
      'fixture-openai',
      mode === 'regular' ? 'default' : null,
    )
    expect(redis.incrementDailyCost).toHaveBeenCalledTimes(1)
    expect(redis.incrementDailyCost.mock.calls[0][2]).toBeCloseTo(0.01515, 10)
    expect(redis.addUsageRecord).toHaveBeenCalledTimes(1)
    expect(redis.addUsageRecord.mock.calls[0][1]).toMatchObject({
      cacheCreateTokens: 7000,
      cacheWrite30mTokens: 3000,
      cacheWrite12hTokens: 4000,
      speed: 'standard',
      requestSpeed: 'fast',
      realCost: 0.01515,
      costBreakdown: { cacheWrite30m: 0.00375, cacheWrite12h: 0.01 },
    })
    expect(captureRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheWrite30mTokens: 3000,
        cacheWrite12hTokens: 4000,
        speed: 'standard',
        requestSpeed: 'fast',
      }),
    )
  },
)
