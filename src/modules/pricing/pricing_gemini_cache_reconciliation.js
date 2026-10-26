import { normalizeGeminiTokenUsage } from '../relay/relay_request_detail_helper.js'

export const reconcileGeminiCacheUsage = (record) => {
  const usage = record.upstreamUsage
  const originalUsageAvailable =
    usage &&
    [usage.promptTokenCount, usage.cachedContentTokenCount, record.inputTokens, record.cacheReadTokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  const result = {
    requestId: record.requestId ?? null,
    apiKeyId: record.apiKeyId ?? null,
    timestamp: record.timestamp,
    model: record.model,
    recordedInputTokens: record.inputTokens,
    recordedCacheReadTokens: record.cacheReadTokens,
    recordedCost: record.cost,
    recordedBaseCost: record.baseCost ?? record.realCost,
    expectedInputTokens: null,
    expectedCacheReadTokens: null,
    inputTokenDifference: null,
    cacheReadTokenDifference: null,
    monetaryDifference: null,
    refundReady: false,
    status: 'missing_raw_usage',
  }
  if (!originalUsageAvailable) {
    return result
  }
  const expected = normalizeGeminiTokenUsage(usage)
  result.expectedInputTokens = expected.inputTokens
  result.expectedCacheReadTokens = expected.cacheReadTokens
  result.inputTokenDifference = record.inputTokens - expected.inputTokens
  result.cacheReadTokenDifference = expected.cacheReadTokens - record.cacheReadTokens
  result.status =
    result.inputTokenDifference === 0 && result.cacheReadTokenDifference === 0
      ? 'matched'
      : 'token_difference_requires_historical_pricing'
  return result
}
