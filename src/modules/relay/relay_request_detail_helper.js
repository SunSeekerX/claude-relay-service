const SENSITIVE_KEY_PATTERN =
  /(authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|set-cookie|client_secret|private[_-]?key|proxy)/i
const DEFAULT_MAX_STRING_CHARS = 80
const DEFAULT_MAX_ARRAY_ITEMS = 24
const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_TOTAL_CHARS = 12000
const ENCRYPTED_CONTENT_KEY = 'encrypted_content'
const TOOLS_KEY = 'tools'
const PREVIEW_TRUNCATION_SUFFIX_PATTERN = /\.\.\.\[(?:truncated )?(\d+) chars\]$/
const OPENAI_RELATED_ACCOUNT_TYPES = new Set(['openai', 'openai-responses', 'azure-openai'])
export const CACHE_HIT_FORMULA = 'cacheReadTokens / (inputTokens + cacheReadTokens + cacheCreateTokens)'

const toFiniteNumber = function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const num = Number(value)
  if (!Number.isFinite(num)) {
    return null
  }

  return num
}

const maskSensitiveValue = function maskSensitiveValue(value) {
  if (value === null || value === undefined) {
    return value
  }

  const str = String(value)
  if (str.length <= 8) {
    return '[REDACTED]'
  }

  return `${str.slice(0, 3)}***${str.slice(-3)}`
}

const truncateString = function truncateString(value, maxChars = DEFAULT_MAX_STRING_CHARS) {
  if (typeof value !== 'string') {
    return value
  }

  if (value.length <= maxChars) {
    return value
  }

  return `${value.slice(0, maxChars)}...[${value.length - maxChars} chars]`
}

const getValueCharLength = function getValueCharLength(value) {
  if (value === null || value === undefined) {
    return 0
  }

  if (typeof value === 'string') {
    return value.length
  }

  try {
    const json = JSON.stringify(value)
    if (typeof json === 'string') {
      return json.length
    }
  } catch (error) {
    // Fall back to String(value) below when JSON serialization fails.
  }

  return String(value).length
}

const createOmittedValue = function createOmittedValue(value) {
  return `...[${getValueCharLength(value)} chars]`
}

const normalizeNonEmptyString = function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

const normalizeInteger = function normalizeInteger(value) {
  const num = toFiniteNumber(value)
  if (num === null) {
    return null
  }

  return Math.trunc(num)
}

const formatReasoningBudget = function formatReasoningBudget(value) {
  return `budget:${value}`
}

const createReasoningInfo = function createReasoningInfo(reasoningDisplay = null, reasoningSource = null) {
  return {
    reasoningDisplay: reasoningDisplay || null,
    reasoningSource: reasoningSource || null,
  }
}

const summarizeToolEntry = function summarizeToolEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return sanitizeValue(value, {
      seen: new WeakSet(),
      keyPath: '',
      depth: 0,
    })
  }

  const summary = {}
  if (typeof value.type === 'string' && value.type) {
    summary.type = value.type
  }

  const name =
    typeof value.name === 'string' ? value.name : typeof value.function?.name === 'string' ? value.function.name : null

  if (name) {
    summary.name = name
  }

  return summary
}

const extractOpenAIReasoningInfo = function extractOpenAIReasoningInfo(payload) {
  const effort = normalizeNonEmptyString(payload?.reasoning?.effort)
  if (effort) {
    return createReasoningInfo(effort, 'reasoning.effort')
  }

  const rootEffort = normalizeNonEmptyString(payload?.reasoning_effort)
  if (rootEffort) {
    return createReasoningInfo(rootEffort, 'reasoning_effort')
  }

  return createReasoningInfo()
}

const extractAnthropicReasoningInfo = function extractAnthropicReasoningInfo(payload) {
  const outputEffort = normalizeNonEmptyString(payload?.output_config?.effort)
  if (outputEffort) {
    return createReasoningInfo(outputEffort, 'output_config.effort')
  }

  const thinking = payload?.thinking

  if (thinking === true) {
    return createReasoningInfo('enabled', 'thinking')
  }

  const thinkingString = normalizeNonEmptyString(thinking)
  if (thinkingString) {
    return createReasoningInfo(thinkingString, 'thinking')
  }

  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) {
    return createReasoningInfo()
  }

  const thinkingType = normalizeNonEmptyString(thinking.type)
  const thinkingEnabled = typeof thinking.enabled === 'boolean' ? thinking.enabled : null
  const thinkingBudget = normalizeInteger(thinking.budget_tokens)

  if (thinkingType === 'disabled' || thinkingType === 'none' || thinkingEnabled === false) {
    return createReasoningInfo('none', 'thinking')
  }

  if (thinkingType && thinkingBudget !== null) {
    return createReasoningInfo(
      `${thinkingType} / ${formatReasoningBudget(thinkingBudget)}`,
      'thinking.type,thinking.budget_tokens',
    )
  }

  if (thinkingType) {
    return createReasoningInfo(thinkingType, 'thinking.type')
  }

  if (thinkingEnabled === true && thinkingBudget !== null) {
    return createReasoningInfo(
      `enabled / ${formatReasoningBudget(thinkingBudget)}`,
      'thinking.enabled,thinking.budget_tokens',
    )
  }

  if (thinkingEnabled === true) {
    return createReasoningInfo('enabled', 'thinking.enabled')
  }

  if (thinkingBudget !== null) {
    return createReasoningInfo(formatReasoningBudget(thinkingBudget), 'thinking.budget_tokens')
  }

  return createReasoningInfo()
}

const extractGeminiReasoningInfo = function extractGeminiReasoningInfo(payload) {
  const thinkingConfig = payload?.generationConfig?.thinkingConfig
  if (!thinkingConfig || typeof thinkingConfig !== 'object' || Array.isArray(thinkingConfig)) {
    return createReasoningInfo()
  }

  const thinkingLevel = normalizeNonEmptyString(thinkingConfig.thinkingLevel || thinkingConfig.thinking_level)
  if (thinkingLevel) {
    return createReasoningInfo(thinkingLevel, 'generationConfig.thinkingConfig.thinkingLevel')
  }

  const thinkingBudget = normalizeInteger(thinkingConfig.thinkingBudget ?? thinkingConfig.thinking_budget)
  if (thinkingBudget === -1) {
    return createReasoningInfo('dynamic', 'generationConfig.thinkingConfig.thinkingBudget')
  }

  if (thinkingBudget === 0) {
    return createReasoningInfo('none', 'generationConfig.thinkingConfig.thinkingBudget')
  }

  if (thinkingBudget !== null) {
    return createReasoningInfo(formatReasoningBudget(thinkingBudget), 'generationConfig.thinkingConfig.thinkingBudget')
  }

  if (thinkingConfig.includeThoughts === false || thinkingConfig.include_thoughts === false) {
    return createReasoningInfo('none', 'generationConfig.thinkingConfig.includeThoughts')
  }

  return createReasoningInfo()
}

export const extractRequestReasoningInfo = function extractRequestReasoningInfo(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return createReasoningInfo()
  }

  const extractors = [extractOpenAIReasoningInfo, extractAnthropicReasoningInfo, extractGeminiReasoningInfo]

  for (const extractor of extractors) {
    const result = extractor(payload)
    if (result.reasoningDisplay) {
      return result
    }
  }

  return createReasoningInfo()
}

const parsePreviewJson = function parsePreviewJson(preview) {
  if (typeof preview !== 'string' || !preview) {
    return null
  }

  const directCandidate = preview.trim()
  try {
    return JSON.parse(directCandidate)
  } catch (error) {
    // fall through to suffix stripping below
  }

  const suffixMatch = directCandidate.match(PREVIEW_TRUNCATION_SUFFIX_PATTERN)
  if (!suffixMatch) {
    return null
  }

  const withoutSuffix = directCandidate.slice(0, -suffixMatch[0].length)
  try {
    return JSON.parse(withoutSuffix)
  } catch (error) {
    return null
  }
}

const extractPreviewReasoningInfo = function extractPreviewReasoningInfo(preview) {
  if (typeof preview !== 'string' || !preview) {
    return createReasoningInfo()
  }

  const parsed = parsePreviewJson(preview)
  if (parsed) {
    return extractRequestReasoningInfo(parsed)
  }

  const openAIEffort = preview.match(/"reasoning"\s*:\s*\{[\s\S]{0,240}?"effort"\s*:\s*"([^"]+)"/)
  if (openAIEffort?.[1]) {
    return createReasoningInfo(openAIEffort[1], 'reasoning.effort')
  }

  const legacyOpenAIEffort = preview.match(/"reasoning_effort"\s*:\s*"([^"]+)"/)
  if (legacyOpenAIEffort?.[1]) {
    return createReasoningInfo(legacyOpenAIEffort[1], 'reasoning_effort')
  }

  const anthropicOutputEffort = preview.match(/"output_config"\s*:\s*\{[\s\S]{0,240}?"effort"\s*:\s*"([^"]+)"/)
  if (anthropicOutputEffort?.[1]) {
    return createReasoningInfo(anthropicOutputEffort[1], 'output_config.effort')
  }

  const thinkingSegmentIndex = preview.indexOf('"thinking"')
  if (thinkingSegmentIndex >= 0) {
    const thinkingSegment = preview.slice(thinkingSegmentIndex, thinkingSegmentIndex + 320)
    const thinkingType = thinkingSegment.match(/"type"\s*:\s*"([^"]+)"/)?.[1] || null
    const thinkingBudget = thinkingSegment.match(/"budget_tokens"\s*:\s*(-?\d+)/)?.[1] || null

    if (thinkingType && thinkingBudget !== null) {
      return createReasoningInfo(
        `${thinkingType} / ${formatReasoningBudget(Number(thinkingBudget))}`,
        'thinking.type,thinking.budget_tokens',
      )
    }
    if (thinkingType) {
      return createReasoningInfo(thinkingType, 'thinking.type')
    }
    if (thinkingBudget !== null) {
      return createReasoningInfo(formatReasoningBudget(Number(thinkingBudget)), 'thinking.budget_tokens')
    }
  }

  const geminiSegmentIndex = preview.indexOf('"thinkingConfig"')
  if (geminiSegmentIndex >= 0) {
    const geminiSegment = preview.slice(geminiSegmentIndex, geminiSegmentIndex + 320)
    const thinkingLevel = geminiSegment.match(/"thinkingLevel"\s*:\s*"([^"]+)"/)?.[1] || null
    const thinkingBudget = geminiSegment.match(/"thinkingBudget"\s*:\s*(-?\d+)/)?.[1] || null

    if (thinkingLevel) {
      return createReasoningInfo(thinkingLevel, 'generationConfig.thinkingConfig.thinkingLevel')
    }
    if (thinkingBudget !== null) {
      const budgetValue = Number(thinkingBudget)
      const display = budgetValue === -1 ? 'dynamic' : budgetValue === 0 ? 'none' : formatReasoningBudget(budgetValue)
      return createReasoningInfo(display, 'generationConfig.thinkingConfig.thinkingBudget')
    }
  }

  return createReasoningInfo()
}

export const resolveRequestDetailReasoning = function resolveRequestDetailReasoning(detail = {}) {
  const storedDisplay = normalizeNonEmptyString(detail.reasoningDisplay)
  const storedSource = normalizeNonEmptyString(detail.reasoningSource)
  if (storedDisplay) {
    return createReasoningInfo(storedDisplay, storedSource)
  }

  const snapshot = detail.requestBodySnapshot
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    if (typeof snapshot.preview === 'string') {
      const previewResult = extractPreviewReasoningInfo(snapshot.preview)
      if (previewResult.reasoningDisplay) {
        return previewResult
      }
    }

    return extractRequestReasoningInfo(snapshot)
  }

  return createReasoningInfo()
}

const sanitizeValue = function sanitizeValue(value, ctx) {
  const {
    keyPath = '',
    seen,
    depth = 0,
    maxDepth = DEFAULT_MAX_DEPTH,
    maxArrayItems = DEFAULT_MAX_ARRAY_ITEMS,
    maxStringChars = DEFAULT_MAX_STRING_CHARS,
  } = ctx

  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'string') {
    if (SENSITIVE_KEY_PATTERN.test(keyPath)) {
      return maskSensitiveValue(value)
    }
    return truncateString(value, maxStringChars)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'function') {
    return '[Function]'
  }

  if (depth >= maxDepth) {
    if (Array.isArray(value)) {
      return `[Array(${value.length})]`
    }
    return '[Object]'
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]'
    }
    seen.add(value)

    if (Array.isArray(value)) {
      const result = value.slice(0, maxArrayItems).map((item, index) =>
        sanitizeValue(item, {
          ...ctx,
          keyPath: `${keyPath}[${index}]`,
          depth: depth + 1,
        }),
      )

      if (value.length > maxArrayItems) {
        result.push(`...[${value.length - maxArrayItems} more items]`)
      }

      return result
    }

    const result = {}
    for (const [key, childValue] of Object.entries(value)) {
      const childPath = keyPath ? `${keyPath}.${key}` : key
      if (key === ENCRYPTED_CONTENT_KEY) {
        result[key] = createOmittedValue(childValue)
        continue
      }

      if (key === TOOLS_KEY) {
        if (Array.isArray(childValue)) {
          result[key] = childValue.slice(0, maxArrayItems).map((item) => summarizeToolEntry(item))

          if (childValue.length > maxArrayItems) {
            result[key].push(`...[${childValue.length - maxArrayItems} more items]`)
          }
        } else if (childValue && typeof childValue === 'object') {
          result[key] = summarizeToolEntry(childValue)
        } else {
          result[key] = sanitizeValue(childValue, {
            ...ctx,
            keyPath: childPath,
            depth: depth + 1,
          })
        }
        continue
      }

      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = maskSensitiveValue(childValue)
        continue
      }

      result[key] = sanitizeValue(childValue, {
        ...ctx,
        keyPath: childPath,
        depth: depth + 1,
      })
    }

    return result
  }

  return String(value)
}

const enforceTotalSize = function enforceTotalSize(snapshot, maxTotalChars = DEFAULT_MAX_TOTAL_CHARS) {
  let json
  try {
    json = JSON.stringify(snapshot)
  } catch (error) {
    return {
      error: 'snapshot_stringify_failed',
      message: error?.message || String(error),
    }
  }

  if (json.length <= maxTotalChars) {
    return snapshot
  }

  return {
    summary: 'request body snapshot truncated',
    originalChars: json.length,
    maxChars: maxTotalChars,
    preview: truncateString(json, maxTotalChars),
  }
}

export const sanitizeRequestBodySnapshot = function sanitizeRequestBodySnapshot(body, options = {}) {
  if (body === undefined) {
    return null
  }

  const seen = new WeakSet()
  const sanitized = sanitizeValue(body, {
    seen,
    maxDepth: options.maxDepth || DEFAULT_MAX_DEPTH,
    maxArrayItems: options.maxArrayItems || DEFAULT_MAX_ARRAY_ITEMS,
    maxStringChars: options.maxStringChars || DEFAULT_MAX_STRING_CHARS,
    keyPath: '',
    depth: 0,
  })

  return enforceTotalSize(sanitized, options.maxTotalChars || DEFAULT_MAX_TOTAL_CHARS)
}

const getRequestEndpoint = function getRequestEndpoint(req) {
  if (!req) {
    return null
  }

  const originalUrl = req.originalUrl || req.url || req.path || null
  if (!originalUrl) {
    return null
  }

  const queryIndex = originalUrl.indexOf('?')
  return queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl
}

const toTimestampMs = function toTimestampMs(value) {
  const numericValue = toFiniteNumber(value)
  if (numericValue !== null) {
    return numericValue
  }

  if (value instanceof Date) {
    const dateValue = value.getTime()
    return Number.isFinite(dateValue) ? dateValue : null
  }

  if (typeof value !== 'string') {
    return null
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const createRequestDetailMeta = function createRequestDetailMeta(req, overrides = {}) {
  const nowMs = Date.now()
  const statusCode = toFiniteNumber(overrides.statusCode)
  const durationMs = toFiniteNumber(overrides.durationMs)
  const requestStartedAt = toFiniteNumber(overrides.requestStartedAt)
  const reqStartedAt = toFiniteNumber(req?.requestStartedAt)
  const effectiveStart = requestStartedAt ?? reqStartedAt
  const requestBody = overrides.requestBody !== undefined ? overrides.requestBody : req?.body

  const firstTokenMsOverride = toFiniteNumber(overrides.firstTokenMs)
  const meta = {
    requestId: overrides.requestId || req?.requestId || null,
    endpoint: overrides.endpoint || getRequestEndpoint(req),
    method: overrides.method || req?.method || null,
    statusCode: statusCode ?? req?.res?.statusCode ?? 200,
    stream:
      typeof overrides.stream === 'boolean' ? overrides.stream : Boolean(requestBody && requestBody.stream === true),
    durationMs: durationMs ?? (effectiveStart ? Math.max(0, nowMs - effectiveStart) : null),
    requestStartedAt: effectiveStart ? new Date(effectiveStart).toISOString() : null,
    requestBody,
  }
  const groupCostHoldGroupId = overrides.groupCostHoldGroupId || req?.apiKey?.groupCostHoldGroupId
  if (groupCostHoldGroupId) {
    meta.groupCostHoldGroupId = String(groupCostHoldGroupId)
  }
  // firstTokenMs 用 getter：流式可能在 create 之后才写出首包，finalize/spread 时再读 req 实时值
  // [人工决策] 对齐 new-api：TTFT 取「首次内容写出」而非 create 时刻快照
  Object.defineProperty(meta, 'firstTokenMs', {
    enumerable: true,
    configurable: true,
    get() {
      if (firstTokenMsOverride !== null) {
        return firstTokenMsOverride
      }
      return toFiniteNumber(req?.firstTokenMs)
    },
  })
  // 计费附加量（按图张数/音频秒等），仅透传给 recordUsage → calculateCost，不进请求体快照语义
  if (overrides.billingUsage && typeof overrides.billingUsage === 'object') {
    meta.billingUsage = overrides.billingUsage
  }
  // 跨协议桥 / token 估算标记（管理端请求详情展示）
  const protocolBridge = overrides.protocolBridge || req?._crsProtocolBridge
  if (protocolBridge) {
    meta.protocolBridge = String(protocolBridge)
  }
  if (overrides.tokenCountEstimate === true) {
    meta.tokenCountEstimate = true
  }
  if (overrides.tokenCountEstimateMethod) {
    meta.tokenCountEstimateMethod = String(overrides.tokenCountEstimateMethod)
  }
  return meta
}

export const finalizeRequestDetailMeta = function finalizeRequestDetailMeta(requestMeta = null) {
  if (!requestMeta || typeof requestMeta !== 'object') {
    return null
  }

  const requestStartedAtMs = toTimestampMs(requestMeta.requestStartedAt)
  const durationMs =
    requestStartedAtMs !== null ? Math.max(0, Date.now() - requestStartedAtMs) : toFiniteNumber(requestMeta.durationMs)
  // finalize 时再读一遍 req 上可能刚打上的首包点（通过 overrides 传入）
  const firstTokenMs = toFiniteNumber(requestMeta.firstTokenMs)

  return {
    ...requestMeta,
    durationMs,
    firstTokenMs,
  }
}

// 解析实际生效的 OpenAI service_tier：上游回包是唯一事实源，请求体仅在回包「没有该字段」时兜底。
//
// [人工决策-2026-08-24 11:33:43] 上游回传的档位一律照收，包括 default 与 auto——官方定义
// response.service_tier 是「实际用于服务本次请求的处理档位」，且明确「可能与请求参数不同」，
// default 即标准定价。请求 fast 但因无资格/容量回退时上游就回 default/auto，此时若按请求的
// fast 收费就是多收。
//
// 判定边界只有一条：回包「有没有这个字段」，而不是「字段值像不像结论」。
// 把某些回传值（曾是 default，后是 auto）当成「未回传」再回落请求意图，就是按请求意图
// 覆盖上游结果 —— 这是同一个多收缺陷的两次发作，故不再对回包值做任何豁免。
// 反向漏收由回包本身覆盖：请求 auto 而上游实际按 priority 服务时，回包就是 priority。
//
// 回落请求体时仍排除 auto/default：它们不是价格档，等价于「按基础价」。
export const resolveOpenAIServiceTier = function resolveOpenAIServiceTier(responseTier, requestTier) {
  const normalize = (value) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '')

  // 回包有值就是权威结论，原样返回，绝不回落请求值
  const fromResponse = normalize(responseTier)
  if (fromResponse) {
    return fromResponse
  }

  const fromRequest = normalize(requestTier)
  if (fromRequest && fromRequest !== 'auto' && fromRequest !== 'default') {
    return fromRequest
  }
  return null
}

export const extractOpenAICacheReadTokens = function extractOpenAICacheReadTokens(usage = {}) {
  if (!usage || typeof usage !== 'object') {
    return 0
  }

  const candidates = [
    usage.input_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_token,
    usage.prompt_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_token,
  ]

  for (const value of candidates) {
    if (value === undefined || value === null || value === '') {
      continue
    }

    const parsed = Number(value)
    if (!Number.isNaN(parsed)) {
      return Math.max(0, parsed)
    }
  }

  return 0
}

// 提取思考/reasoning tokens（OpenAI/Codex/Gemini/Grok 字段名不一）
export const extractThinkingTokens = function extractThinkingTokens(usage = {}) {
  if (!usage || typeof usage !== 'object') {
    return 0
  }

  const candidates = [
    usage.thinking_tokens,
    usage.thinkingTokens,
    usage.reasoning_tokens,
    usage.reasoningTokens,
    usage.thoughtsTokenCount,
    usage.output_tokens_details?.reasoning_tokens,
    usage.output_token_details?.reasoning_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
  ]

  for (const value of candidates) {
    if (value === undefined || value === null || value === '') {
      continue
    }

    const parsed = Number(value)
    if (!Number.isNaN(parsed)) {
      return Math.max(0, Math.floor(parsed))
    }
  }

  return 0
}

// 思考是否已计入 output/completion（决定计费与 allTokens 是否再加一遍）
// 官方口径：
// - OpenAI Chat/Codex Responses/Azure/Grok：reasoning 是 output/completion 的子集（details 字段）
// - Gemini 原生 usageMetadata：thoughtsTokenCount 与 candidatesTokenCount 分立，计费需相加
export const isThinkingAlreadyInOutput = function isThinkingAlreadyInOutput(usage = {}) {
  if (!usage || typeof usage !== 'object') {
    return false
  }

  // 显式标记优先（buildTokenUsagePayload 会写入，避免扁平化丢细节）
  if (usage.reasoning_included_in_output === true || usage._thinkingAlreadyInOutput === true) {
    return true
  }
  if (usage.reasoning_included_in_output === false || usage._thinkingAlreadyInOutput === false) {
    return false
  }

  // OpenAI / Codex / Azure / Grok Responses&Chat：details.reasoning_tokens 是 output 子集
  if (
    usage.output_tokens_details?.reasoning_tokens !== undefined &&
    usage.output_tokens_details?.reasoning_tokens !== null
  ) {
    return true
  }
  if (
    usage.output_token_details?.reasoning_tokens !== undefined &&
    usage.output_token_details?.reasoning_tokens !== null
  ) {
    return true
  }
  if (
    usage.completion_tokens_details?.reasoning_tokens !== undefined &&
    usage.completion_tokens_details?.reasoning_tokens !== null
  ) {
    return true
  }

  // Gemini 原生：thoughts 与 candidates 分立
  if (usage.thoughtsTokenCount !== undefined && usage.thoughtsTokenCount !== null) {
    return false
  }

  return false
}

// 组装 recordUsage 对象重载入参：保留拆分后的 token，并把 raw usage 中的思考 tokens 一并带上
export const buildTokenUsagePayload = function buildTokenUsagePayload({
  inputTokens = 0,
  outputTokens = 0,
  cacheCreateTokens = 0,
  cacheReadTokens = 0,
  rawUsage = null,
  extras = null,
} = {}) {
  const raw = rawUsage && typeof rawUsage === 'object' ? rawUsage : {}
  const payload = {
    input_tokens: inputTokens || 0,
    output_tokens: outputTokens || 0,
    cache_creation_input_tokens: cacheCreateTokens || 0,
    cache_read_input_tokens: cacheReadTokens || 0,
    reasoning_tokens: extractThinkingTokens(raw),
    // 扁平化后仍能判定「思考是否已在 output 内」，避免 OpenAI/Grok 双计、Gemini 漏计
    reasoning_included_in_output: isThinkingAlreadyInOutput(raw),
  }

  // 保留官方 details，供下游/日志与兼容旧判定
  if (raw.completion_tokens_details) {
    payload.completion_tokens_details = raw.completion_tokens_details
  }
  if (raw.output_tokens_details) {
    payload.output_tokens_details = raw.output_tokens_details
  }
  if (raw.output_token_details) {
    payload.output_token_details = raw.output_token_details
  }
  if (
    raw.thoughtsTokenCount !== undefined &&
    raw.thoughtsTokenCount !== null &&
    (payload.thoughtsTokenCount === undefined || payload.thoughtsTokenCount === null)
  ) {
    payload.thoughtsTokenCount = raw.thoughtsTokenCount
  }

  if (extras && typeof extras === 'object') {
    Object.assign(payload, extras)
  }
  return payload
}

export const isOpenAIRelatedEndpoint = function isOpenAIRelatedEndpoint(endpoint) {
  if (typeof endpoint !== 'string') {
    return false
  }

  if (endpoint.startsWith('/azure/') || endpoint.startsWith('/droid/openai/')) {
    return true
  }

  if (!endpoint.startsWith('/openai/')) {
    return false
  }

  return !(
    endpoint === '/openai/claude' ||
    endpoint === '/openai/gemini' ||
    endpoint.startsWith('/openai/claude/') ||
    endpoint.startsWith('/openai/gemini/')
  )
}

export const getRequestDetailCacheMetrics = function getRequestDetailCacheMetrics(detail = {}) {
  const read = Math.max(0, Number(detail.cacheReadTokens) || 0)
  const create = Math.max(0, Number(detail.cacheCreateTokens) || 0)
  const input = Math.max(0, Number(detail.inputTokens) || 0)
  const isOpenAIRelated =
    OPENAI_RELATED_ACCOUNT_TYPES.has(detail.accountType) || isOpenAIRelatedEndpoint(detail.endpoint)
  const denominator = input + read + create

  if (denominator <= 0) {
    return {
      isOpenAIRelated,
      cacheCreateNotApplicable: isOpenAIRelated,
      numerator: read,
      denominator: 0,
      formula: CACHE_HIT_FORMULA,
      cacheHitFormula: CACHE_HIT_FORMULA,
      rate: 0,
    }
  }

  return {
    isOpenAIRelated,
    cacheCreateNotApplicable: isOpenAIRelated,
    numerator: read,
    denominator,
    formula: CACHE_HIT_FORMULA,
    cacheHitFormula: CACHE_HIT_FORMULA,
    rate: Number(((read / denominator) * 100).toFixed(2)),
  }
}

export const calculateCacheHitRate = function calculateCacheHitRate(
  cacheReadTokensOrDetail = 0,
  cacheCreateTokens = 0,
  inputTokens = 0,
) {
  if (typeof cacheReadTokensOrDetail === 'object' && cacheReadTokensOrDetail !== null) {
    return getRequestDetailCacheMetrics(cacheReadTokensOrDetail).rate
  }

  const read = Math.max(0, Number(cacheReadTokensOrDetail) || 0)
  const create = Math.max(0, Number(cacheCreateTokens) || 0)
  const input = Math.max(0, Number(inputTokens) || 0)
  const denominator = input + read + create

  if (denominator <= 0) {
    return 0
  }

  return Number(((read / denominator) * 100).toFixed(2))
}
