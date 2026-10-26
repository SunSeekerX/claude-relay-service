import { expect, test } from '@jest/globals'
import {
  buildBillingAudit,
  projectUpstreamUsage
} from '../src/modules/pricing/pricing_billing_audit.js'
import { buildTokenUsagePayload } from '../src/modules/relay/relay_request_detail_helper.js'

test('retains original official usage buckets while excluding bodies, credentials and unknown fields', () => {
  const raw = {
    input_tokens: 100,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 80, secret: 'hidden' },
    cost_in_usd_ticks: '12345678901234567890',
    messages: [{ text: 'private' }],
    token: 'credential',
    prompt: 'private',
    model: 'private'
  }
  expect(projectUpstreamUsage(raw)).toEqual({
    input_tokens: 100,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 80 },
    cost_in_usd_ticks: '12345678901234567890'
  })
  const payload = buildTokenUsagePayload({
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 80,
    rawUsage: raw
  })
  const audit = buildBillingAudit({
    model: 'target',
    serviceTier: 'flex',
    usage: payload,
    pricing: { input: 2, output: 8, cacheRead: 0.2 },
    pricingSource: 'dynamic',
    baseCost: 1,
    ratedCost: 2,
    realCost: 1
  })
  expect(audit.upstreamUsage.input_tokens).toBe(100)
  expect(payload.input_tokens).toBe(20)
  expect(audit).toMatchObject({
    model: 'target',
    serviceTier: 'flex',
    effectiveRate: 2,
    pricingSnapshot: { input: 2, output: 8, cacheRead: 0.2 }
  })
  expect(JSON.stringify(audit)).not.toContain('private')
  expect(JSON.stringify(audit)).not.toContain('credential')
})
test('missing evidence remains unknown and explicit zero is preserved', () => {
  expect(projectUpstreamUsage(null)).toBeNull()
  expect(projectUpstreamUsage({ input_tokens: 0, output_tokens: 0 })).toEqual({
    input_tokens: 0,
    output_tokens: 0
  })
  const audit = buildBillingAudit({
    model: 'm',
    usage: null,
    pricing: null,
    baseCost: 0,
    ratedCost: 0,
    realCost: 0
  })
  expect(audit).toMatchObject({ upstreamUsage: null, pricingSnapshot: null, effectiveRate: null })
})
