import { jest, afterEach, expect, test } from '@jest/globals'

jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: new Proxy({}, { get: () => jest.fn() }) }))
jest.unstable_mockModule('../src/modules/pricing/pricing_model_service.js', () => ({
  modelService: { getInternalBillingModel: () => null },
}))
const { pricingService } = await import('../src/modules/pricing/pricing_service.js')
const { CostCalculator } = await import('../src/modules/pricing/pricing_cost_calculator.js')
const { resolveModelFallbackPricing } = await import('../src/modules/pricing/pricing_model_fallback_pricing.js')
const original = pricingService.pricingData
afterEach(() => {
  pricingService.pricingData = original
})

test.each(['claude-fable-5-2', 'anthropic.claude-mythos-5-2'])(
  'prices %s without fuzzy matching an older model',
  (model) => {
    pricingService.pricingData = {}
    const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10000 }
    const result = CostCalculator.calculateCost(usage, model)
    expect(result.costs.total).toBeCloseTo(0.014, 12)
    const fast = CostCalculator.calculateCost({ ...usage, speed: 'fast' }, model)
    expect(fast.costs.total).toBeCloseTo(0.028, 12)
    expect(fast.pricing.cacheWrite1h).toBe(32)
  },
)

test.each([false, true])('Haiku 5.5 switches at 100001 total input tokens, including caches (seed=%s)', (seed) => {
  const model = 'claude-haiku-5-5'
  const pricing = { ...resolveModelFallbackPricing(model) }
  delete pricing.cache_creation_input_token_cost_above_100k_tokens
  delete pricing.cache_creation_input_token_cost_above_1hr_above_100k_tokens
  delete pricing.cache_read_input_token_cost_above_100k_tokens
  pricingService.pricingData = seed ? { [model]: pricing } : {}
  const below = CostCalculator.calculateCost(
    { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 99999 },
    model,
  )
  expect(below.pricing.input).toBeCloseTo(0.1, 12)
  const above = CostCalculator.calculateCost(
    { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100000 },
    model,
  )
  expect(above.costs.total).toBeCloseTo(0.0050255, 12)
  expect(above.pricing).toMatchObject({ input: 0.5, output: 2.5, cacheWrite1h: 1 })
  expect(above.pricing.cacheRead).toBeCloseTo(0.05, 12)
})
