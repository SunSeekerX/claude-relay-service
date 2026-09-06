// Claude Messages body 字段清理（fallbacks 等）
// DEC_20260904_170000 无对应 beta 时剥 fallbacks，避免上游 400 Extra inputs
// Bedrock/console 无条件剥；1P 按 anthropic-beta 条件剥

export const BETA_SERVER_SIDE_FALLBACK = 'server-side-fallback-2026-07-01'
// fallback_credit_token 接受的 beta 集合（与 sub2api 对齐的主 token）
export const BETA_FALLBACK_CREDIT_TOKENS = [BETA_SERVER_SIDE_FALLBACK, 'fallback-credit-2026-07-01']

const parseBetaTokens = (headerValue) => {
  if (typeof headerValue !== 'string' || !headerValue.trim()) {
    return new Set()
  }
  return new Set(
    headerValue
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  )
}

const hasAnyBeta = (betaSet, candidates) => {
  for (const candidate of candidates) {
    if (betaSet.has(String(candidate).toLowerCase())) {
      return true
    }
  }
  return false
}

// vendor: 'anthropic' | 'bedrock' | 'console'
// anthropic: 按 beta 条件 strip
// bedrock/console: 无条件 strip fallbacks 相关 + interface_geo
export const sanitizeClaudeBodyFallbacks = (body, options = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body
  }

  const vendor = options.vendor || 'anthropic'
  const betaHeader = options.anthropicBetaHeader || options.betaHeader || ''
  const betaSet = parseBetaTokens(betaHeader)

  const forceStrip = vendor === 'bedrock' || vendor === 'console' || vendor === 'ccr'
  const stripFallbacks = forceStrip || !betaSet.has(BETA_SERVER_SIDE_FALLBACK.toLowerCase())
  const stripCredit = forceStrip || !hasAnyBeta(betaSet, BETA_FALLBACK_CREDIT_TOKENS)

  if (stripFallbacks && Object.prototype.hasOwnProperty.call(body, 'fallbacks')) {
    delete body.fallbacks
  }
  if (stripCredit && Object.prototype.hasOwnProperty.call(body, 'fallback_credit_token')) {
    delete body.fallback_credit_token
  }
  // Bedrock 等不接受的客户端字段
  if (forceStrip && Object.prototype.hasOwnProperty.call(body, 'interface_geo')) {
    delete body.interface_geo
  }

  return body
}

// 非破坏：clone 后 sanitize
export const sanitizeClaudeBodyFallbacksClone = (body, options = {}) => {
  if (!body || typeof body !== 'object') {
    return body
  }
  const cloned = typeof structuredClone === 'function' ? structuredClone(body) : JSON.parse(JSON.stringify(body))
  return sanitizeClaudeBodyFallbacks(cloned, options)
}
