// Claude anthropic-beta 分账号类型精选套件（对齐 sub2api claude/constants）
// OAuth 伪装走完整 mimic 集；API Key 不含 oauth；Haiku 精简；count_tokens 另套
import {
  buildClaudeCliUserAgent,
  CLAUDE_CLI_BASELINE_VERSION,
  getClaudeCliVersion,
} from './relay_claude_cli_version.js'

export const ClaudeBeta = {
  oauth: 'oauth-2025-04-20',
  claudeCode: 'claude-code-20250219',
  interleavedThinking: 'interleaved-thinking-2025-05-14',
  fineGrainedToolStreaming: 'fine-grained-tool-streaming-2025-05-14',
  tokenCounting: 'token-counting-2024-11-01',
  context1m: 'context-1m-2025-08-07',
  fastMode: 'fast-mode-2026-02-01',
  promptCachingScope: 'prompt-caching-scope-2026-01-05',
  effort: 'effort-2025-11-24',
  redactThinking: 'redact-thinking-2026-02-12',
  contextManagement: 'context-management-2025-06-27',
  extendedCacheTtl: 'extended-cache-ttl-2025-04-11',
  advancedToolUse: 'advanced-tool-use-2025-11-20',
  structuredOutputs: 'structured-outputs-2025-12-15',
  taskBudgets: 'task-budgets-2026-03-13',
}

// OAuth mimic 默认集（不默认 redact-thinking，避免抹掉 thinking；客户端显式带则保留）
export const FULL_CLAUDE_CODE_MIMICRY_BETAS = [
  ClaudeBeta.claudeCode,
  ClaudeBeta.oauth,
  ClaudeBeta.interleavedThinking,
  ClaudeBeta.fineGrainedToolStreaming,
  ClaudeBeta.promptCachingScope,
  ClaudeBeta.effort,
  ClaudeBeta.contextManagement,
  ClaudeBeta.extendedCacheTtl,
]

export const OAUTH_HAIKU_DEFAULT_BETAS = [ClaudeBeta.oauth, ClaudeBeta.interleavedThinking]

export const API_KEY_DEFAULT_BETAS = [
  ClaudeBeta.claudeCode,
  ClaudeBeta.interleavedThinking,
  ClaudeBeta.fineGrainedToolStreaming,
]

export const API_KEY_HAIKU_DEFAULT_BETAS = [ClaudeBeta.interleavedThinking]

export const COUNT_TOKENS_BETAS = [
  ClaudeBeta.claudeCode,
  ClaudeBeta.oauth,
  ClaudeBeta.interleavedThinking,
  ClaudeBeta.tokenCounting,
]

// 转发时默认不剥；如需剥客户端噪声可在此登记
export const DROPPED_BETAS = []

const splitBetas = (headerOrList) => {
  if (!headerOrList) {
    return []
  }
  if (Array.isArray(headerOrList)) {
    return headerOrList.map((item) => String(item).trim()).filter(Boolean)
  }
  return String(headerOrList)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

const uniqueMerge = (baseList, extraList) => {
  const seen = new Set()
  const result = []
  for (const beta of [...baseList, ...extraList]) {
    if (!beta || seen.has(beta) || DROPPED_BETAS.includes(beta)) {
      continue
    }
    seen.add(beta)
    result.push(beta)
  }
  return result
}

const isHaikuModel = (modelId) => typeof modelId === 'string' && modelId.toLowerCase().includes('haiku')

const isOauthAccountType = (accountType) => {
  const type = String(accountType || '').toLowerCase()
  // claude-official = OAuth；console/api-key 类走 API Key 套件
  return type === 'claude-official' || type === 'claude' || type === 'oauth' || type === 'official'
}

// 按 body 特征补 beta（客户端未带时）
export const inferFeatureBetasFromBody = (body = {}) => {
  const extras = []
  if (!body || typeof body !== 'object') {
    return extras
  }

  const model = String(body.model || '')
  if (/1m|context-1m/i.test(model)) {
    extras.push(ClaudeBeta.context1m)
  }

  if (body.speed && String(body.speed).toLowerCase() === 'fast') {
    extras.push(ClaudeBeta.fastMode)
  }

  if (
    body.output_config &&
    (body.output_config.effort || body.output_config.task_budget || body.output_config.format)
  ) {
    extras.push(ClaudeBeta.effort)
    if (body.output_config.task_budget) {
      extras.push(ClaudeBeta.taskBudgets)
    }
    if (body.output_config.format) {
      extras.push(ClaudeBeta.structuredOutputs)
    }
  }

  if (body.context_management) {
    extras.push(ClaudeBeta.contextManagement)
  }

  if (Array.isArray(body.tools)) {
    const hasDeferred = body.tools.some((tool) => tool && (tool.defer_loading || tool.eager_input_streaming))
    if (hasDeferred) {
      extras.push(ClaudeBeta.advancedToolUse)
    }
    const hasStrict = body.tools.some((tool) => tool && tool.strict)
    if (hasStrict) {
      extras.push(ClaudeBeta.structuredOutputs)
    }
  }

  // 扫描 cache_control.ttl / scope
  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return
    }
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (node.cache_control && typeof node.cache_control === 'object') {
      if (node.cache_control.ttl === '1h') {
        extras.push(ClaudeBeta.extendedCacheTtl)
      }
      if (node.cache_control.scope) {
        extras.push(ClaudeBeta.promptCachingScope)
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        visit(value)
      }
    }
  }
  visit(body)

  return extras
}

/**
 * 组装最终 anthropic-beta header
 * @param {object} options
 * @param {string} [options.modelId]
 * @param {string} [options.accountType] claude-official | claude-console | bedrock | ccr | api-key
 * @param {string|string[]} [options.clientBetaHeader]
 * @param {object} [options.body]
 * @param {boolean} [options.isCountTokens]
 * @param {boolean} [options.isRealClaudeCode] 真实 CC 客户端：以客户端为准，仅 merge 保底
 * @param {boolean} [options.oauthMimic] 非 CC 走 OAuth 伪装
 */
export const buildClaudeBetaHeader = (options = {}) => {
  const {
    modelId = '',
    accountType = 'claude-official',
    clientBetaHeader = '',
    body = null,
    isCountTokens = false,
    isRealClaudeCode = false,
    oauthMimic = !isRealClaudeCode,
  } = options

  const clientBetas = splitBetas(clientBetaHeader)
  const featureBetas = inferFeatureBetasFromBody(body || {})
  const haiku = isHaikuModel(modelId)
  const oauth = isOauthAccountType(accountType)

  let base
  if (isCountTokens) {
    base = oauth
      ? COUNT_TOKENS_BETAS
      : [ClaudeBeta.claudeCode, ClaudeBeta.interleavedThinking, ClaudeBeta.tokenCounting]
  } else if (oauth && (oauthMimic || !isRealClaudeCode)) {
    base = [...FULL_CLAUDE_CODE_MIMICRY_BETAS]
  } else if (oauth && isRealClaudeCode) {
    // 真实 CC：保底最小集，其余信任客户端
    base = haiku ? OAUTH_HAIKU_DEFAULT_BETAS : FULL_CLAUDE_CODE_MIMICRY_BETAS.slice(0, 4)
  } else if (haiku) {
    base = API_KEY_HAIKU_DEFAULT_BETAS
  } else {
    base = API_KEY_DEFAULT_BETAS
  }

  // Bedrock/CCR：不强制 oauth beta
  if (accountType === 'bedrock' || accountType === 'ccr') {
    base = base.filter((beta) => beta !== ClaudeBeta.oauth)
    if (base.length === 0) {
      base = [ClaudeBeta.interleavedThinking]
    }
  }

  return uniqueMerge(base, [...featureBetas, ...clientBetas]).join(',')
}

// 兼容旧名：实际生效版本走 getClaudeCliVersion()（含 env 覆盖）
export const CLAUDE_CLI_DEFAULT_VERSION = getClaudeCliVersion()
export { CLAUDE_CLI_BASELINE_VERSION, getClaudeCliVersion }

export const DEFAULT_CLAUDE_CODE_HEADERS = {
  'x-stainless-retry-count': '0',
  'x-stainless-timeout': '600',
  'x-stainless-lang': 'js',
  'x-stainless-package-version': '0.94.0',
  'x-stainless-os': 'Linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v24.3.0',
  'anthropic-dangerous-direct-browser-access': 'true',
  'x-app': 'cli',
  'user-agent': buildClaudeCliUserAgent(),
  'accept-language': '*',
  'sec-fetch-mode': 'cors',
}
