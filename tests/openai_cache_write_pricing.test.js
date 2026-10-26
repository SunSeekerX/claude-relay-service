import { jest, beforeEach, afterEach, expect, test } from '@jest/globals'
import { normalizeOpenAITokenUsage, buildTokenUsagePayload } from '../src/modules/relay/relay_request_detail_helper.js'
import { normalizeKeyTokenStats, normalizeAccountTokenStats } from '../src/common/compat_token_stats.js'

await jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: new Proxy({}, { get: () => jest.fn() }),
}))
await jest.unstable_mockModule('../src/modules/pricing/pricing_model_service.js', () => ({
  modelService: { getInternalBillingModel: () => null },
}))
const { pricingService } = await import('../src/modules/pricing/pricing_service.js')
const { CostCalculator } = await import('../src/modules/pricing/pricing_cost_calculator.js')
const { createUsageRecordCostResolver } = await import('../src/modules/pricing/pricing_usage_record_cost.js')
const { attach } = await import('../src/infra/redis_usage_stats_store.js')
const { RedisKeys } = await import('../src/infra/redis_key.js')
const model = 'fixture-openai'
const originalPricing = pricingService.pricingData
const officialUsage = {
  input_tokens: 12000,
  output_tokens: 0,
  input_tokens_details: {
    cached_tokens: 4000,
    cache_write_tokens: 7000,
    cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
  },
}
beforeEach(() => {
  pricingService.pricingData = {
    [model]: {
      litellm_provider: 'openai',
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      cache_read_input_token_cost: 0.0000001,
      cache_creation_input_token_cost: 0.00000125,
      cache_creation_input_token_cost_above_12hr: 0.0000025,
      input_cost_per_token_priority: 0.000002,
      cache_read_input_token_cost_priority: 0.0000002,
      cache_creation_input_token_cost_priority: 0.0000025,
      cache_creation_input_token_cost_above_12hr_priority: 0.000005,
    },
  }
})
afterEach(() => {
  pricingService.pricingData = originalPricing
})

test('official mixed-lifetime example bills $0.01515 and preserves all four disjoint input buckets', () => {
  const normalized = normalizeOpenAITokenUsage(officialUsage)
  expect(normalized).toMatchObject({ inputTokens: 1000, cacheReadTokens: 4000, cacheCreateTokens: 7000 })
  const payload = buildTokenUsagePayload({ ...normalized, rawUsage: officialUsage })
  expect(payload.cache_write_tokens_details).toEqual({ ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 })
  const result = CostCalculator.calculateCost(payload, model)
  expect(result.costs.total).toBeCloseTo(0.01515, 10)
  expect(result.costs.cacheCreate).toBeCloseTo(0.01375, 10)
  expect(result.costs.cacheWrite30m).toBeCloseTo(0.00375, 10)
  expect(result.costs.cacheWrite12h).toBeCloseTo(0.01, 10)
  expect(result.costs.ephemeral5m).toBe(0)
  expect(result.costs.ephemeral1h).toBe(0)
  expect(CostCalculator.calculateCost(payload, model, 'priority').costs.total).toBeCloseTo(0.0303, 10)
})

test('explicit zero prices and zero lifetime counters are preserved, and missing long price uses the effective input price', () => {
  const payload = buildTokenUsagePayload({ ...normalizeOpenAITokenUsage(officialUsage), rawUsage: officialUsage })
  pricingService.pricingData[model].cache_creation_input_token_cost_above_12hr = 0
  expect(CostCalculator.calculateCost(payload, model).costs.cacheWrite12h).toBe(0)
  pricingService.pricingData[model].cache_creation_input_token_cost_priority = 0
  expect(CostCalculator.calculateCost(payload, model, 'priority').costs.cacheWrite30m).toBe(0)
  delete pricingService.pricingData[model].cache_creation_input_token_cost_above_12hr
  expect(CostCalculator.calculateCost(payload, model).costs.total).toBeCloseTo(0.01515, 10)
  const zero = {
    ...officialUsage,
    input_tokens_details: {
      ...officialUsage.input_tokens_details,
      cache_write_tokens: 0,
      cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 0 },
    },
  }
  expect(
    buildTokenUsagePayload({ ...normalizeOpenAITokenUsage(zero), rawUsage: zero }).cache_write_tokens_details,
  ).toEqual({ ttl_30m_tokens: 0, ttl_12h_tokens: 0 })
})

test('mixed recorded/unrecorded aggregates price only remaining lifetime buckets and retain historical amounts', () => {
  const stats = {
    inputTokens: 1000,
    outputTokens: 0,
    cacheReadTokens: 4000,
    cacheCreateTokens: 7000,
    cacheWrite30mTokens: 3000,
    cacheWrite12hTokens: 4000,
  }
  expect(CostCalculator.resolveModelStatsCost(stats, model).total).toBeCloseTo(0.01515, 10)
  const mixed = {
    ...stats,
    realCostMicro: 10000,
    ratedCostMicro: 20000,
    costedRequests: 1,
    costedInputTokens: 0,
    costedCacheReadTokens: 0,
    costedCacheCreateTokens: 4000,
    costedCacheWrite30mTokens: 0,
    costedCacheWrite12hTokens: 4000,
  }
  expect(CostCalculator.resolveModelStatsCost(mixed, model).real).toBeCloseTo(0.01515, 10)
  expect(CostCalculator.resolveModelStatsCost(mixed, model).rated).toBeCloseTo(0.02515, 10)
  const record = { model, ...stats, cost: 0, realCost: 0, costBreakdown: { total: 0 } }
  expect(createUsageRecordCostResolver()(record, {}, null, true).cost).toBe(0)
  delete record.cost
  delete record.realCost
  expect(createUsageRecordCostResolver()(record, buildTokenUsagePayload(stats), null).cost).toBeCloseTo(0.01515, 10)
})

test('Redis statistics retain independent lifetime counters at key/model/account dimensions without changing token totals', async () => {
  const commands = []
  const pipeline = new Proxy(
    {},
    {
      get: (_target, operation) =>
        operation === 'exec'
          ? async () => []
          : (...args) => {
              commands.push([operation, ...args])
              return pipeline
            },
    },
  )
  const client = new Proxy(
    {},
    {
      get: (_target, operation) =>
        operation === 'pipeline'
          ? () => pipeline
          : async (...args) => {
              commands.push([operation, ...args])
              return 1
            },
    },
  )
  const store = { client, _normalizeModelName: (value) => value }
  attach(store)
  const lifetimes = { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 }
  await store.incrementTokenUsage(
    'fixture-key',
    12000,
    1000,
    0,
    7000,
    4000,
    model,
    0,
    0,
    false,
    0.01515,
    0.01515,
    0,
    false,
    lifetimes,
  )
  expect(commands).toContainEqual(['hincrby', RedisKeys.usage.total('fixture-key'), 'totalCacheWrite12hTokens', 4000])
  expect(
    commands.some((cmd) => cmd[0] === 'hincrby' && cmd[2] === 'costedCacheWrite12hTokens' && cmd[3] === 4000),
  ).toBe(true)
  expect(commands).toContainEqual(['hincrby', RedisKeys.usage.total('fixture-key'), 'totalAllTokens', 12000])
  commands.length = 0
  await store.incrementAccountUsage(
    'fixture-account',
    12000,
    1000,
    0,
    7000,
    4000,
    0,
    0,
    model,
    false,
    0.01515,
    true,
    lifetimes,
  )
  expect(commands).toContainEqual([
    'hincrby',
    RedisKeys.accountUsage.total('fixture-account'),
    'totalCacheWrite12hTokens',
    4000,
  ])
  expect(
    commands.some((cmd) => cmd[0] === 'hincrby' && cmd[2] === 'costedCacheWrite30mTokens' && cmd[3] === 3000),
  ).toBe(true)
})

test('unknown OpenAI lifetime fields preserve Anthropic 1h pricing and legacy statistics shapes', () => {
  pricingService.pricingData['claude-sonnet-fixture'] = {
    litellm_provider: 'anthropic',
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
    cache_creation_input_token_cost: 0.00000125,
    cache_creation_input_token_cost_above_1hr: 0.000002,
    cache_read_input_token_cost: 0.0000001,
  }
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
  }
  const record = { model: 'claude-sonnet-fixture', cacheWrite30mTokens: null, cacheWrite12hTokens: null }
  expect(createUsageRecordCostResolver()(record, usage, null).cost).toBeCloseTo(0.002, 10)
  expect(normalizeKeyTokenStats({ totalTokens: '10' })).toEqual({
    tokens: 10,
    inputTokens: 3,
    outputTokens: 7,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    allTokens: 10,
    requests: 0,
  })
  expect(normalizeAccountTokenStats({ totalTokens: '10' }).inputTokens).toBe(0)
  expect(
    normalizeKeyTokenStats({
      inputTokens: '1000',
      cacheCreateTokens: '7000',
      totalCacheWrite30mTokens: '0',
      totalCacheWrite12hTokens: '4000',
    }),
  ).toMatchObject({ cacheWrite30mTokens: 0, cacheWrite12hTokens: 4000 })
})
