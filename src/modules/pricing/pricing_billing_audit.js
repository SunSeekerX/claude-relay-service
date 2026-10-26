const numericFields = new Set([
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'prompt_tokens',
  'completion_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cached_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'audio_tokens',
  'image_tokens',
  'text_tokens',
  'accepted_prediction_tokens',
  'rejected_prediction_tokens',
  'ephemeral_5m_input_tokens',
  'ephemeral_1h_input_tokens',
  'promptTokenCount',
  'cachedContentTokenCount',
  'candidatesTokenCount',
  'thoughtsTokenCount',
  'totalTokenCount',
  'toolUsePromptTokenCount',
  'web_search',
  'x_search',
  'code_execution',
  'image_count',
  'input_image_count',
  'audio_input_seconds',
  'audio_output_seconds',
  'video_input_seconds',
  'video_output_seconds',
  'total_input_tokens',
  'total_output_tokens',
  'total_thought_tokens',
  'total_cached_tokens',
  'total_tool_use_tokens',
  'ttl_30m_tokens',
  'ttl_12h_tokens',
  'web_search_calls',
  'x_posts_fetched',
  'x_users_fetched',
  'code_interpreter_calls',
  'file_search_calls',
  'document_search_calls'
])
const nestedFields = new Set([
  'input_tokens_details',
  'output_tokens_details',
  'prompt_tokens_details',
  'completion_tokens_details',
  'output_token_details',
  'cache_creation',
  'cache_write_tokens_details',
  'server_side_tool_usage_details',
  'context_details'
])

export const projectUpstreamUsage = (usage) => {
  if (!usage || typeof usage !== 'object') {return null}
  const result = {}
  for (const [key, value] of Object.entries(usage)) {
    if (numericFields.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0)
      {result[key] = value}
    else if (key === 'cost_in_usd_ticks' && /^\d+$/.test(String(value))) {result[key] = String(value)}
    else if (nestedFields.has(key)) {
      const projected = projectUpstreamUsage(value)
      if (projected && Object.keys(projected).length > 0) {result[key] = projected}
    }
  }
  return result
}

export const buildBillingAudit = ({
  model,
  serviceTier,
  usage,
  pricing,
  toolPricing = null,
  pricingSource,
  ratedCost,
  baseCost,
  realCost,
  protocolTerminal
}) => ({
  schemaVersion: 1,
  model,
  serviceTier: serviceTier ?? null,
  protocolTerminal: protocolTerminal ?? null,
  upstreamUsage: projectUpstreamUsage(usage?._upstreamUsage ?? usage),
  pricingSource: pricingSource ?? null,
  pricingSnapshot: pricing
    ? Object.fromEntries(
        Object.entries(pricing).filter(
          ([, value]) => typeof value === 'number' && Number.isFinite(value)
        )
      )
    : null,
  toolPriceSnapshot: toolPricing
    ? Object.fromEntries(
        Object.entries(toolPricing).filter(
          ([, value]) => typeof value === 'number' && Number.isFinite(value)
        )
      )
    : null,
  tokenPriceUnit: 'USD per million tokens',
  baseCost,
  realCost,
  ratedCost,
  effectiveRate: baseCost > 0 ? ratedCost / baseCost : null
})
