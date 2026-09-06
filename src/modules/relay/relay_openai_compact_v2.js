// OpenAI Responses compact v2（body-signal）与 service_tier 别名
// DEC_20260904_170000 compaction_trigger + remote_compaction_v2；fast→priority

export const CODEX_REMOTE_COMPACTION_V2 = 'remote_compaction_v2'
export const COMPACTION_TRIGGER_TYPE = 'compaction_trigger'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export const normalizeOpenAIServiceTierAlias = (tier) => {
  if (typeof tier !== 'string') {
    return tier
  }
  const normalized = tier.trim().toLowerCase()
  if (!normalized) {
    return tier
  }
  // Codex/官方：fast 是 priority 的客户端别名
  if (normalized === 'fast') {
    return 'priority'
  }
  return tier.trim()
}

// 对 body.service_tier 做 fast→priority（原地）
export const applyOpenAIServiceTierAlias = (body) => {
  if (!isPlainObject(body)) {
    return body
  }
  if (typeof body.service_tier === 'string') {
    body.service_tier = normalizeOpenAIServiceTierAlias(body.service_tier)
  }
  return body
}

const asInputArray = (input) => {
  if (Array.isArray(input)) {
    return input
  }
  return null
}

export const hasCompactionTrigger = (body) => {
  if (!isPlainObject(body)) {
    return false
  }
  const items = asInputArray(body.input)
  if (!items) {
    return false
  }
  return items.some((item) => isPlainObject(item) && item.type === COMPACTION_TRIGGER_TYPE)
}

// v2 整形：trigger 移到 input 末尾；stream 强制 true
export const normalizeCompactionTriggerBody = (body) => {
  if (!isPlainObject(body)) {
    return { body, isV2: false }
  }
  const items = asInputArray(body.input)
  if (!items || items.length === 0) {
    return { body, isV2: false }
  }

  const triggers = []
  const rest = []
  for (const item of items) {
    if (isPlainObject(item) && item.type === COMPACTION_TRIGGER_TYPE) {
      triggers.push(item)
    } else {
      rest.push(item)
    }
  }
  if (triggers.length === 0) {
    return { body, isV2: false }
  }

  body.input = [...rest, ...triggers]
  body.stream = true
  return { body, isV2: true }
}

// 补 x-codex-beta-features: remote_compaction_v2（不重复）
export const ensureRemoteCompactionV2BetaHeader = (headers = {}) => {
  const out = { ...headers }
  const key = Object.keys(out).find((name) => name.toLowerCase() === 'x-codex-beta-features') || 'x-codex-beta-features'
  const current = typeof out[key] === 'string' ? out[key] : Array.isArray(out[key]) ? out[key].join(',') : ''
  const tokens = current
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
  const has = tokens.some((token) => token.toLowerCase() === CODEX_REMOTE_COMPACTION_V2)
  if (!has) {
    tokens.push(CODEX_REMOTE_COMPACTION_V2)
  }
  out[key] = tokens.join(', ')
  return out
}
