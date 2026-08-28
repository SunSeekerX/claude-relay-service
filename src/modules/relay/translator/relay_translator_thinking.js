// Thinking / reasoning 跨协议映射（对齐 CLIProxyAPI internal/thinking）
// 规则：
// - redacted_thinking 永不映射为明文 reasoning
// - thinking 文本仅允许出现在 assistant 侧
// - thinking 开启时 temperature 必须为 1 或省略

export const ThinkingLevel = {
  none: 'none',
  auto: 'auto',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

const LEVEL_TO_BUDGET = {
  none: 0,
  auto: -1,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  max: 128000,
}

export const convertLevelToBudget = (level) => {
  if (level === undefined || level === null) {
    return { ok: false, budget: 0 }
  }
  const key = String(level).trim().toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(LEVEL_TO_BUDGET, key)) {
    return { ok: false, budget: 0 }
  }
  return { ok: true, budget: LEVEL_TO_BUDGET[key] }
}

export const convertBudgetToLevel = (budget) => {
  const value = Number(budget)
  if (!Number.isFinite(value) || value < -1) {
    return { ok: false, level: '' }
  }
  if (value === -1) {
    return { ok: true, level: ThinkingLevel.auto }
  }
  if (value === 0) {
    return { ok: true, level: ThinkingLevel.none }
  }
  if (value <= 512) {
    return { ok: true, level: ThinkingLevel.minimal }
  }
  if (value <= 1024) {
    return { ok: true, level: ThinkingLevel.low }
  }
  if (value <= 8192) {
    return { ok: true, level: ThinkingLevel.medium }
  }
  if (value <= 24576) {
    return { ok: true, level: ThinkingLevel.high }
  }
  return { ok: true, level: ThinkingLevel.xhigh }
}

// OpenAI reasoning_effort / Claude output_config.effort → Claude thinking 配置
export const effortToClaudeThinking = (effort, { supportsAdaptive = true } = {}) => {
  if (effort === undefined || effort === null || effort === '') {
    return null
  }
  const level = String(effort).trim().toLowerCase()
  if (level === 'none' || level === 'off' || level === 'disabled') {
    return { thinking: { type: 'disabled' } }
  }
  if (supportsAdaptive && (level === 'auto' || level === 'adaptive' || level === 'max' || level === 'xhigh')) {
    const outputEffort = level === 'auto' || level === 'adaptive' ? 'high' : level === 'xhigh' ? 'max' : level
    return {
      thinking: { type: 'adaptive' },
      output_config: { effort: outputEffort },
    }
  }
  const mapped = convertLevelToBudget(level)
  if (!mapped.ok || mapped.budget <= 0) {
    return {
      thinking: { type: 'enabled', budget_tokens: 1024 },
    }
  }
  return {
    thinking: { type: 'enabled', budget_tokens: mapped.budget },
  }
}

// Claude thinking → OpenAI reasoning_effort
export const claudeThinkingToEffort = (thinking, outputConfig = null) => {
  if (!thinking || typeof thinking !== 'object') {
    return null
  }
  const type = String(thinking.type || '').toLowerCase()
  if (type === 'disabled') {
    return ThinkingLevel.none
  }
  if (type === 'adaptive' || type === 'auto') {
    const effort = outputConfig?.effort
    if (typeof effort === 'string' && effort.trim()) {
      return effort.trim().toLowerCase()
    }
    return ThinkingLevel.xhigh
  }
  if (type === 'enabled') {
    if (Number.isFinite(thinking.budget_tokens)) {
      const mapped = convertBudgetToLevel(thinking.budget_tokens)
      return mapped.ok ? mapped.level : ThinkingLevel.medium
    }
    return ThinkingLevel.auto
  }
  return null
}

// thinking 开启时：去掉 temperature/top_p/top_k 冲突，temperature 固定语义为 1（省略）
export const applyThinkingSamplingRules = (body, thinkingEnabled) => {
  if (!body || !thinkingEnabled) {
    return body
  }
  if (Object.prototype.hasOwnProperty.call(body, 'temperature') && body.temperature !== 1) {
    delete body.temperature
  }
  if (Object.prototype.hasOwnProperty.call(body, 'top_p')) {
    delete body.top_p
  }
  if (Object.prototype.hasOwnProperty.call(body, 'top_k')) {
    delete body.top_k
  }
  return body
}

export const isThinkingEnabled = (thinking) => {
  if (!thinking || typeof thinking !== 'object') {
    return false
  }
  const type = String(thinking.type || '').toLowerCase()
  return type === 'enabled' || type === 'adaptive' || type === 'auto'
}

// 从 assistant content blocks 提取可公开的 reasoning 文本；忽略 redacted_thinking
export const extractAssistantReasoningText = (content) => {
  if (!Array.isArray(content)) {
    return ''
  }
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue
    }
    if (block.type === 'thinking') {
      const text = typeof block.thinking === 'string' ? block.thinking : ''
      if (text.trim()) {
        parts.push(text)
      }
    }
    // redacted_thinking 显式忽略，禁止映射明文
  }
  return parts.join('\n\n')
}

// 模型名后缀解析：-thinking / -nothinking / -high / -medium / -low / -thinking-128
export const parseThinkingModelSuffix = (modelName) => {
  if (!modelName || typeof modelName !== 'string') {
    return { baseModel: modelName || '', effort: null, budget: null, forceOff: false }
  }
  let remaining = modelName.trim()
  let effort = null
  let budget = null
  let forceOff = false

  const budgetMatch = remaining.match(/-thinking-(\d+)$/i)
  if (budgetMatch) {
    budget = Number(budgetMatch[1])
    remaining = remaining.slice(0, -budgetMatch[0].length)
    effort = convertBudgetToLevel(budget).level
  } else if (/-nothinking$/i.test(remaining)) {
    forceOff = true
    remaining = remaining.replace(/-nothinking$/i, '')
  } else if (/-thinking$/i.test(remaining)) {
    effort = ThinkingLevel.high
    remaining = remaining.replace(/-thinking$/i, '')
  }

  const effortMatch = remaining.match(/-(none|minimal|low|medium|high|xhigh|max)$/i)
  if (effortMatch) {
    effort = effortMatch[1].toLowerCase()
    remaining = remaining.slice(0, -effortMatch[0].length)
  }

  return { baseModel: remaining, effort, budget, forceOff }
}
