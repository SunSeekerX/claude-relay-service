const parseModels = (value) => {
  if (typeof value !== 'string') return value ?? []
  try {
    return JSON.parse(value)
  } catch {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }
}
export const getAccountModelConfiguration = (account) => {
  if (!account) return { models: [], mappings: [], ready: true }
  const mapped = ['claude-console', 'ccr', 'openai-responses'].includes(account.platform)
  const supported = parseModels(account.supportedModels)
  const mappings =
    mapped && supported && !Array.isArray(supported)
      ? Object.entries(supported)
          .filter(([from, to]) => from !== to)
          .map(([from, to]) => ({ from, to }))
      : []
  const range =
    mapped && Object.hasOwn(account, 'allowedModels')
      ? parseModels(account.allowedModels)
      : supported
  return {
    models: Array.isArray(range) ? [...range] : Object.keys(range ?? {}),
    mappings,
    ready: mapped || Object.hasOwn(account, 'supportedModels')
  }
}
