import { jest, beforeEach, afterEach, describe, it, expect } from '@jest/globals'

jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: new Proxy({}, { get: () => jest.fn() }),
}))
jest.unstable_mockModule('../src/modules/pricing/pricing_model_service.js', () => ({
  modelService: { getInternalBillingModel: () => null },
}))
const { pricingService } = await import('../src/modules/pricing/pricing_service.js')
const { CostCalculator } = await import('../src/modules/pricing/pricing_cost_calculator.js')
const model = 'claude-opus-5-5'
const originalPricing = pricingService.pricingData

beforeEach(() => {
  pricingService.pricingData = {
    [model]: {
      litellm_provider: 'anthropic',
      input_cost_per_token: 0.000004,
      output_cost_per_token: 0.00002,
      cache_creation_input_token_cost: 0.000005,
      cache_read_input_token_cost: 0.0000004,
      provider_specific_entry: { fast: 2 },
    },
  }
})
afterEach(() => {
  pricingService.pricingData = originalPricing
})

const usage = {
  input_tokens: 100,
  output_tokens: 10,
  cache_creation_input_tokens: 20,
  cache_read_input_tokens: 30,
}

describe('Claude actual speed controls new-request billing', () => {
  it('lets upstream standard override a fast request and its beta header', () => {
    const result = CostCalculator.calculateCost(
      {
        ...usage,
        speed: 'standard',
        request_speed: 'fast',
        request_anthropic_beta: 'fast-mode-2026-02-01',
      },
      model,
    )
    expect(result.costs.total).toBeCloseTo(0.000712, 12)
    expect(result.pricing.input).toBe(4)
    expect(result.pricing.output).toBe(20)
  })

  it('bills confirmed Fast without requiring the obsolete beta header', () => {
    const result = CostCalculator.calculateCost({ ...usage, speed: 'FAST', request_speed: 'standard' }, model)
    expect(result.costs.total).toBeCloseTo(0.001424, 12)
    expect(result.pricing.input).toBe(8)
    expect(result.pricing.output).toBe(40)
    expect(result.costs.cacheCreate).toBeCloseTo(0.0002, 12)
    expect(result.costs.cacheRead).toBeCloseTo(0.000024, 12)
  })

  it('uses an explicit price-table multiplier before the published default', () => {
    pricingService.pricingData[model].provider_specific_entry.fast = 3
    expect(CostCalculator.calculateCost({ ...usage, speed: 'fast' }, model).costs.total).toBeCloseTo(0.000712 * 3, 12)
    delete pricingService.pricingData[model].provider_specific_entry.fast
    expect(CostCalculator.calculateCost({ ...usage, speed: 'fast' }, model).costs.total).toBeCloseTo(0.000712 * 2, 12)
  })

  it('keeps an explicit zero multiplier and does not fabricate premium usage from a beta alone', () => {
    pricingService.pricingData[model].provider_specific_entry.fast = 0
    expect(CostCalculator.calculateCost({ ...usage, speed: 'fast' }, model).costs.total).toBe(0)
    expect(
      CostCalculator.calculateCost({ ...usage, request_anthropic_beta: 'fast-mode-2026-02-01' }, model).costs.total,
    ).toBeCloseTo(0.000712, 12)
  })
})
