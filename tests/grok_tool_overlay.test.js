import { jest } from '@jest/globals'
import { GROK_TOOL_PRICING_MODEL } from '../src/modules/pricing/pricing_grok_tool_pricing.js'
jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis: {} }))
jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: new Proxy({}, { get: () => jest.fn() })
}))
const { grokMediaPricingOverlayService: service } =
  await import('../src/modules/pricing/pricing_grok_media_overlay_service.js')

describe('Grok tool price overrides', () => {
  it('keeps a zero custom tool price and default prices for the remaining units', () => {
    const builtin = service.getBuiltinDefaults()[GROK_TOOL_PRICING_MODEL]
    const cleaned = service._sanitizeModels({
      [GROK_TOOL_PRICING_MODEL]: { xai_tool_costs_per_unit: { web_search_calls: 0 } }
    })
    const result = service._mergeModelPricing(builtin, cleaned[GROK_TOOL_PRICING_MODEL])
    expect(result.xai_tool_costs_per_unit.web_search_calls).toBe(0)
    expect(result.xai_tool_costs_per_unit.x_users_fetched).toBe(0.01)
    expect(result.mode).toBe('server_tools')
  })
  it.each(['unknown_tool', 'constructor', '__proto__'])(
    'rejects an unknown or inherited unit %s',
    (unit) => {
      expect(() =>
        service._sanitizeModels({
          [GROK_TOOL_PRICING_MODEL]: { xai_tool_costs_per_unit: { [unit]: 1 } }
        })
      ).toThrow('unknown Grok tool billing unit')
    }
  )
})
