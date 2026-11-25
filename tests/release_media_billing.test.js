import { expect, it, jest } from '@jest/globals'
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: new Proxy({}, { get: () => jest.fn() }) }))
jest.unstable_mockModule('../src/modules/pricing/pricing_model_service.js', () => ({
  modelService: { getInternalBillingModel: () => null },
}))
jest.unstable_mockModule('../src/modules/pricing/pricing_grok_media_overlay_service.js', () => ({
  grokMediaPricingOverlayService: { getEffectiveModelPricingSync: () => null },
}))
const { pricingService } = await import('../src/modules/pricing/pricing_service.js')

it.each([
  ['grok-imagine-image', { image_count: 2, input_image_count: 1, resolution: '1k' }, 0.042],
  ['grok-imagine-image-quality', { image_count: 2, resolution: '2k' }, 0.14],
  ['grok-imagine-image-2.0', { image_count: 2, resolution: '2k', quality: 'medium' }, 0.16],
  ['grok-imagine-video', { video_output_seconds: 5, video_resolution: '1080p' }, 0.35],
])('charges media units through the actual pricing service: %s %j', (model, usage, total) => {
  const original = pricingService.pricingData
  try {
    pricingService.pricingData = {}
    expect(pricingService.calculateCost(usage, model).totalCost).toBeCloseTo(total, 8)
  } finally {
    pricingService.pricingData = original
  }
})
