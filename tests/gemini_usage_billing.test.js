import { describe, expect, it } from '@jest/globals'
import {
  buildGeminiTokenUsagePayload,
  extractThinkingTokens,
  isThinkingAlreadyInOutput,
  normalizeGeminiTokenUsage
} from '../src/modules/relay/relay_request_detail_helper.js'
import { mapGeminiUsageToOpenAI } from '../src/modules/relay/relay_gemini_to_openai.js'
import { reconcileGeminiCacheUsage } from '../src/modules/pricing/pricing_gemini_cache_reconciliation.js'

describe('Gemini official usage accounting', () => {
  const usage = {
    promptTokenCount: 1000,
    cachedContentTokenCount: 900,
    candidatesTokenCount: 100,
    thoughtsTokenCount: 50,
    totalTokenCount: 1150
  }

  it('charges disjoint input buckets and includes thoughts exactly once in billable output', () => {
    const payload = buildGeminiTokenUsagePayload(usage)
    expect(payload.input_tokens).toBe(100)
    expect(payload.cache_read_input_tokens).toBe(900)
    expect(payload.output_tokens).toBe(100)
    expect(extractThinkingTokens(payload)).toBe(50)
    expect(isThinkingAlreadyInOutput(payload)).toBe(false)
    expect(
      payload.input_tokens +
        payload.cache_read_input_tokens +
        payload.output_tokens +
        payload.reasoning_tokens
    ).toBe(1150)
  })

  it('preserves OpenAI wire totals while reporting cache and reasoning as subsets', () => {
    expect(mapGeminiUsageToOpenAI(usage)).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 150,
      total_tokens: 1150,
      prompt_tokens_details: { cached_tokens: 900 },
      completion_tokens_details: { reasoning_tokens: 50 }
    })
  })

  it('preserves explicit zero and does not invent cache creation', () => {
    expect(
      buildGeminiTokenUsagePayload({ promptTokenCount: 0, cachedContentTokenCount: 0 })
    ).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_tokens: 0
    })
    expect(normalizeGeminiTokenUsage({ cachedContentTokenCount: 900 })).toMatchObject({
      inputTokens: 0,
      cacheReadTokens: 900
    })
  })

  it('does not infer historical refunds from normalized or missing usage', () => {
    const record = { inputTokens: 1000, cacheReadTokens: 0, cost: 1, realCost: 1 }
    expect(reconcileGeminiCacheUsage(record)).toMatchObject({
      status: 'missing_raw_usage',
      monetaryDifference: null,
      refundReady: false
    })
    expect(reconcileGeminiCacheUsage({ ...record, upstreamUsage: usage })).toMatchObject({
      status: 'token_difference_requires_historical_pricing',
      inputTokenDifference: 900,
      cacheReadTokenDifference: 900,
      monetaryDifference: null,
      refundReady: false
    })
    expect(
      reconcileGeminiCacheUsage({
        ...record,
        inputTokens: 100,
        cacheReadTokens: 900,
        upstreamUsage: usage
      })
    ).toMatchObject({ status: 'matched' })
  })
})
