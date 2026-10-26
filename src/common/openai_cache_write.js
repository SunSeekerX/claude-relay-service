// OpenAI 缓存时长独立于 Anthropic 的 ephemeral_5m/ephemeral_1h。
export const getOpenAICacheWriteDetails = (usage, maximum = Infinity) => {
  const details =
    usage?.cache_write_tokens_details ??
    usage?.input_tokens_details?.cache_write_tokens_details ??
    usage?.prompt_tokens_details?.cache_write_tokens_details
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null
  }
  const count = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0)
  const short = Math.min(maximum, count(details.ttl_30m_tokens))
  const long = Math.min(maximum - short, count(details.ttl_12h_tokens))
  return { ttl_30m_tokens: short, ttl_12h_tokens: long }
}
