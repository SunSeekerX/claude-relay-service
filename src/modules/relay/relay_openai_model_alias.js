// OpenAI / Codex 模型别名归一（对齐 sub2api openai_model_alias）
// gpt-6 / gpt-6-astra → gpt-6-astra；gpt-5.6 → gpt-5.6-sol

const lastModelSegment = (model) => {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  if (!trimmed) {
    return ''
  }
  if (!trimmed.includes('/')) {
    return trimmed
  }
  const parts = trimmed.split('/')
  return String(parts[parts.length - 1] || '').trim()
}

export const canonicalizeOpenAIModelAliasSpelling = (model) => {
  let normalized = lastModelSegment(model).toLowerCase()
  if (!normalized) {
    return ''
  }
  normalized = normalized.replaceAll('_', '-')
  normalized = normalized.split(/\s+/).filter(Boolean).join('-')
  while (normalized.includes('--')) {
    normalized = normalized.replaceAll('--', '-')
  }
  if (normalized.startsWith('gpt5')) {
    normalized = `gpt-5${normalized.slice(4)}`
  }
  if (!normalized.startsWith('gpt-') && !normalized.includes('codex')) {
    return ''
  }
  const replacements = [
    ['gpt-5.4mini', 'gpt-5.4-mini'],
    ['gpt-5.4nano', 'gpt-5.4-nano'],
    ['gpt-5.3-codexspark', 'gpt-5.3-codex-spark'],
    ['gpt-5.3codexspark', 'gpt-5.3-codex-spark'],
    ['gpt-5.3codex', 'gpt-5.3-codex'],
  ]
  for (const [from, to] of replacements) {
    normalized = normalized.replaceAll(from, to)
  }
  return normalized
}

export const isOpenAIGPT6AstraModel = (model) => {
  const normalized = canonicalizeOpenAIModelAliasSpelling(model)
  return normalized === 'gpt-6' || normalized === 'gpt-6-astra' || normalized.startsWith('gpt-6-astra-')
}

export const isOpenAIGPT56Model = (model) => {
  const normalized = canonicalizeOpenAIModelAliasSpelling(model)
  if (!normalized) {
    return false
  }
  if (normalized === 'gpt-5.6') {
    return true
  }
  return (
    normalized === 'gpt-5.6-sol' ||
    normalized.startsWith('gpt-5.6-sol-') ||
    normalized === 'gpt-5.6-terra' ||
    normalized.startsWith('gpt-5.6-terra-') ||
    normalized === 'gpt-5.6-luna' ||
    normalized.startsWith('gpt-5.6-luna-') ||
    normalized.startsWith('gpt-5.6-')
  )
}

// 已知 Codex/ChatGPT 模型归一到目录 slug；未知返回原小写段或空
export const normalizeKnownOpenAICodexModel = (model) => {
  const normalized = canonicalizeOpenAIModelAliasSpelling(model)
  if (!normalized) {
    return ''
  }
  if (isOpenAIGPT6AstraModel(normalized)) {
    return 'gpt-6-astra'
  }
  if (normalized.includes('gpt-5.6-sol')) {
    return 'gpt-5.6-sol'
  }
  if (normalized.includes('gpt-5.6-terra')) {
    return 'gpt-5.6-terra'
  }
  if (normalized.includes('gpt-5.6-luna')) {
    return 'gpt-5.6-luna'
  }
  if (normalized === 'gpt-5.6' || normalized.startsWith('gpt-5.6-')) {
    return 'gpt-5.6-sol'
  }
  return normalized
}

// 出站前把公开别名改成上游真实模型 id（仅已知别名）
// onlyWhenUnmapped=true：已有账户映射结果时不要覆盖（防止 gpt-6→自定义部署 被改成 gpt-6-astra）
export const applyOpenAIPublicModelAlias = (body, options = {}) => {
  if (!body || typeof body !== 'object' || typeof body.model !== 'string') {
    return body
  }
  if (options.onlyWhenUnmapped === true && options.mapped === true) {
    return body
  }
  const original = typeof options.originalModel === 'string' ? options.originalModel : null
  if (original && body.model !== original) {
    // 模型已被账户映射改写，禁止再套公开别名
    return body
  }
  const canonical = normalizeKnownOpenAICodexModel(body.model)
  if (!canonical) {
    return body
  }
  if (canonical === 'gpt-6-astra' || canonical === 'gpt-5.6-sol') {
    if (body.model !== canonical) {
      body.model = canonical
    }
  }
  return body
}

// 选号候选：原始名 + 公开别名归一（不含账户映射；映射由调用方叠加）
export const collectOpenAIModelSelectCandidates = (requestedModel) => {
  if (!requestedModel || typeof requestedModel !== 'string') {
    return []
  }
  const raw = requestedModel.trim()
  if (!raw) {
    return []
  }
  const out = [raw]
  const canonical = normalizeKnownOpenAICodexModel(raw)
  if (canonical && canonical !== raw) {
    out.push(canonical)
  }
  return out
}
