export const modelInterfaceSupport = (model, format) => {
  const name = model.toLowerCase().replace(/^models\//, '')
  if (
    /^(?:text-embedding|embedding|whisper|tts-|dall-e|gpt-image|sora|omni-moderation|text-moderation|gemini-embedding|imagen|veo-|grok-imagine|grok-.*(?:image|video))/.test(
      name,
    ) ||
    /(?:^|[-_])(?:realtime|transcribe|tts)(?:[-_]|$)/.test(name)
  ) {
    return 'unsupported'
  }
  if (format === 'gemini-generate') {
    return /^(?:gemini-|claude-)/.test(name) ? 'supported' : 'unknown'
  }
  return /^(?:(?:(?:us|eu|apac|global)\.)?anthropic\.)?(?:claude-|gemini-|gpt-|chatgpt-|codex-|o[134](?:-|$)|grok-|composer)/.test(
    name,
  )
    ? 'supported'
    : 'unknown'
}
