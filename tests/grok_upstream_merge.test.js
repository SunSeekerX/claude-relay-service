import { describe, expect, test } from '@jest/globals'
import * as quota from '../src/modules/account/account_grok_quota.js'
import {
  normalizeChatCompletionsBody,
  mapModel,
  defaultModelIds,
  resolveGrokBaseUrl,
  normalizeAuthType,
} from '../src/common/xai_helper.js'
import { isChatBridgeEligible } from '../src/modules/relay/relay_grok_protocol.js'
import { resolveModelFallbackPricing } from '../src/modules/pricing/pricing_model_fallback_pricing.js'

describe('upstream Grok 4.7 integration', () => {
  test('supports regional, custom and existing OAuth endpoints using the current auth vocabulary', () => {
    expect(normalizeAuthType('api_key')).toBe('apikey')
    expect(resolveGrokBaseUrl({ authType: 'api_key', baseUrlMode: 'us' })).toBe('https://us.api.x.ai/v1')
    expect(resolveGrokBaseUrl({ authType: 'oauth', baseUrl: 'https://api.x.ai/v1' })).toBe(
      'https://cli-chat-proxy.grok.com/v1',
    )
    expect(resolveGrokBaseUrl({ authType: 'oauth', baseUrl: 'https://relay.example.com/xai/v1' })).toBe(
      'https://relay.example.com/xai/v1',
    )
    expect(
      resolveGrokBaseUrl({ authType: 'oauth', baseUrl: 'https://relay.example.com/v1', customUpstream: false }),
    ).toBe('https://cli-chat-proxy.grok.com/v1')
    expect(
      resolveGrokBaseUrl({ authType: 'apikey', baseUrlMode: 'custom', baseUrl: 'https://relay.example.com/v1' }),
    ).toBe('https://relay.example.com/v1')
    expect(() =>
      resolveGrokBaseUrl({ authType: 'apikey', baseUrlMode: 'custom', baseUrl: 'https://127.0.0.1' }),
    ).toThrow()
  })
  test.each(['grok-4.7', 'grok-4.7-latest', 'xai/grok-4.7', 'grok-4.6-latest'])(
    'normalizes xhigh for %s without mutating messages/tools',
    (model) => {
      const body = {
        model,
        messages: [{ role: 'user', content: 'fixture' }],
        tools: [{ type: 'function', function: { name: 'read' } }],
        reasoning_effort: 'x-high',
        stream: true,
        stream_options: { fixture: true },
      }
      const result = normalizeChatCompletionsBody(body, true)
      expect(result).toMatchObject({
        reasoning_effort: 'xhigh',
        stream_options: { fixture: true, include_usage: true },
      })
      expect(result.messages).toBe(body.messages)
      expect(result.tools).toBe(body.tools)
      expect(body.reasoning_effort).toBe('x-high')
    },
  )
  test('keeps custom backend parameters and the existing bridge choice', () => {
    expect(
      normalizeChatCompletionsBody({ model: 'custom', prompt_cache_key: 'p', reasoning_effort: 'custom' }, false),
    ).toMatchObject({ prompt_cache_key: 'p', reasoning_effort: 'custom' })
    expect(isChatBridgeEligible({ model: 'grok-4.7', messages: [{ role: 'user', content: 'hi' }] }).ok).toBe(true)
    expect(isChatBridgeEligible({ model: 'grok-4.7', messages: [], reasoning_effort: 'high' }).ok).toBe(false)
  })
  test('keeps generic aliases while adding the exact model and independent official pricing', () => {
    expect(mapModel('grok')).toBe('grok-4.6')
    expect(mapModel('grok-4.7-latest')).toBe('grok-4.7')
    expect(defaultModelIds()).toContain('grok-4.7')
    expect(resolveModelFallbackPricing('grok-4.7')).toMatchObject({
      input_cost_per_token: 2e-6,
      output_cost_per_token: 6e-6,
      cache_read_input_token_cost: 0.5e-6,
      input_cost_per_token_above_200k_tokens: 4e-6,
      output_cost_per_token_above_200k_tokens: 12e-6,
    })
  })
})

describe('observed Grok quota', () => {
  const now = new Date('2026-11-14T12:00:00Z')
  test('reads numeric JWT tiers and preserves explicit subscription claims', () => {
    const token = `e30.${Buffer.from(JSON.stringify({ tier: 5 })).toString('base64url')}.fixture`
    expect(quota.subscriptionTierFromJWT(token)).toBe('supergrok_heavy')
    expect(quota.subscriptionTierFromClaims({ xai_subscription_tier: 'SuperGrok Plus' })).toBe('supergrok_plus')
  })
  test('parses mixed-case response headers and exposes quota inference separately', () => {
    const snapshot = quota.parseQuotaHeaders(
      {
        'X-RateLimit-Limit-Tokens': '53000000',
        'X-Ratelimit-Remaining-Tokens': '52000000',
        'X-RateLimit-Limit-Requests': '8300',
        'X-RateLimit-Remaining-Requests': '8000',
        'X-Ratelimit-Reset-Tokens': '3600',
      },
      { now, model: 'grok-4.7' },
    )
    const usage = quota.buildGrokUsageSnapshot({ grokQuotaSnapshot: JSON.stringify(snapshot) }, now)
    expect(usage).toMatchObject({
      plan: 'supergrok_heavy',
      planSource: 'quota',
      headersObserved: true,
      tokens: { used: 1000000, remainingSeconds: 3600 },
      requests: { used: 300 },
    })
    expect(quota.canonicalPlan({ subscriptionTier: 'free', snapshot })).toBe('free')
  })
  test('a reset-only observation retains unknown counts rather than showing a fully used quota', () => {
    const snapshot = quota.parseQuotaHeaders({ 'x-ratelimit-reset-tokens': '3600' }, { now })
    expect(quota.buildGrokUsageSnapshot({ grokQuotaSnapshot: JSON.stringify(snapshot) }, now)).toBeNull()
    expect(quota.parseQuotaHeaders({})).toBeNull()
  })
  test('expired windows display reset counts without changing entitlement', () => {
    const snapshot = quota.parseQuotaHeaders(
      { 'x-ratelimit-limit-tokens': '10', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '3600' },
      { now },
    )
    const usage = quota.buildGrokUsageSnapshot(
      { subscriptionTier: 'free', grokQuotaSnapshot: JSON.stringify(snapshot) },
      new Date(now.getTime() + 7200000),
    )
    expect(usage).toMatchObject({ plan: 'free', tokens: { used: 0, remainingSeconds: 0 } })
  })
})
