// 统一的请求/响应 header 过滤
// - 上行：去 CDN/hop-by-hop/凭证头，保留官方 CLI 关键头
// - 下行：剥网关指纹头（对齐 CLIProxyAPI header_filter），避免客户端识别为代理

// Cloudflare CDN headers（橙色云代理模式会添加这些）
export const cdnHeaders = [
  'x-real-ip',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-accel-buffering',
  'cf-ray',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-visitor',
  'cf-request-id',
  'cdn-loop',
  'true-client-ip',
]

// 网关/代理指纹（响应侧剥离，防 Claude Code / 客户端标 proxy）
export const gatewayFingerprintHeaders = [
  'x-litellm-model',
  'x-litellm-version',
  'x-litellm-response-cost',
  'x-litellm-key',
  'helicone-id',
  'helicone-status',
  'helicone-retry-at',
  'x-portkey-request-id',
  'x-portkey-trace-id',
  'cf-aig-request-id',
  'x-kong-proxy-latency',
  'x-kong-upstream-latency',
  'x-bt-engine',
  'x-request-id-gateway',
  'x-oneapi-request-id',
  'x-new-api-request-id',
  'x-crs-account-id',
  'x-crs-account-name',
]

// hop-by-hop（RFC 7230）— 响应侧也不该转给客户端
export const hopByHopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]

// 客户端凭据类：出站上游绝不可转发（浏览器 Cookie / 本地 CRS 会话等）
export const credentialStripHeaders = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-cr-api-key',
  'cookie',
  'cookie2',
]

// DEC_20261001_114137 Codex 证明/内部能力/路由头由官方客户端宿主生成，中转不接受客户端值（HTTP 与 WS 一致）
export const codexServerOwnedRequestHeaders = [
  'x-oai-attestation',
  'x-openai-internal-codex-responses-lite',
  'x-openai-memgen-request',
  'x-codex-routing-hint',
]

// Codex / OpenAI Responses 官方关键头（文档化保留；filterForOpenAI 黑名单模式默认已放行）
export const codexCriticalRequestHeaders = [
  'originator',
  'version',
  'session-id',
  'thread-id',
  'x-client-request-id',
  'x-openai-subagent',
  'chatgpt-account-id',
  'openai-organization',
  'openai-project',
  'openai-beta',
  'accept',
]

// Claude Code 2.1.280 每请求会话头与子代理身份头（DEC_20261001_114137 透传并缺失时补会话头）
export const CLAUDE_CODE_SESSION_ID_HEADER = 'x-claude-code-session-id'
export const claudeCodeSessionHeaders = [
  CLAUDE_CODE_SESSION_ID_HEADER,
  'x-claude-code-agent-id',
  'x-claude-code-parent-agent-id',
  'x-claude-code-request-class',
  'x-claude-code-agent-type',
  'x-claude-remote-container-id',
  'x-claude-remote-session-id',
  'x-client-app',
  'x-anthropic-additional-protection',
]

// Grok 官方关键头（xaiHelper 也会主动注入；此处保证客户端带来的不被误剥）
// DEC_20261001_114137 客户端只透传会话类 x-grok-*；身份/路由/模型覆盖由服务端决定
export const grokCriticalRequestHeaders = [
  'x-xai-token-auth',
  'x-grok-client-version',
  'x-grok-client-identifier',
  'x-grok-client-mode',
  'x-grok-conv-id',
  'x-grok-conv-group-id',
  'x-grok-req-id',
  'x-grok-session-id',
  'x-grok-agent-id',
  'x-grok-model-override',
  'x-grok-turn-idx',
  'x-grok-transient-retry',
  'x-authenticateresponse',
]

// 仅透传会话/重试类头；客户端身份、运行模式、设备、部署、模型覆盖一律不接受客户端值
const grokPassthroughRequestHeaders = new Set([
  'x-grok-conv-id',
  'x-grok-conv-group-id',
  'x-grok-req-id',
  'x-grok-session-id',
  'x-grok-turn-idx',
  'x-grok-transient-retry',
])

// 白名单透传客户端 Grok 会话头（出站合并前调用，服务端头后写覆盖）
export const pickGrokPassthroughHeaders = (headers) => {
  const picked = {}
  for (const [key, value] of Object.entries(toHeaderMap(headers))) {
    const lowerKey = key.toLowerCase()
    if (grokPassthroughRequestHeaders.has(lowerKey) && value) {
      picked[lowerKey] = value
    }
  }
  return picked
}

const toHeaderMap = (headers) => {
  if (!headers || typeof headers !== 'object') {
    return {}
  }
  // Node IncomingHttpHeaders / axios 可能是数组值
  return headers
}

/**
 * 为 OpenAI/Responses/Codex API 过滤请求 headers
 * 黑名单模式：去掉 hop/凭证/CDN，其余（含 Codex 关键头）原样透传
 */
export const filterForOpenAI = (headers) => {
  const skipHeaders = new Set([
    'host',
    'content-length',
    'connection',
    'upgrade',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
    ...credentialStripHeaders,
    ...cdnHeaders,
    ...hopByHopHeaders,
    ...codexServerOwnedRequestHeaders,
  ])

  const filtered = {}
  for (const [key, value] of Object.entries(toHeaderMap(headers))) {
    if (!skipHeaders.has(key.toLowerCase())) {
      filtered[key] = value
    }
  }
  return filtered
}

/**
 * 为 Claude/Anthropic API 过滤请求 headers
 * 白名单模式：只允许指定的 headers 通过
 */
export const filterForClaude = (headers) => {
  // 白名单模式：只允许以下 headers
  const allowedHeaders = new Set([
    'accept',
    'x-stainless-retry-count',
    'x-stainless-timeout',
    'x-stainless-lang',
    'x-stainless-package-version',
    'x-stainless-os',
    'x-stainless-arch',
    'x-stainless-runtime',
    'x-stainless-runtime-version',
    'x-stainless-helper-method',
    'anthropic-dangerous-direct-browser-access',
    'anthropic-version',
    'x-app',
    'anthropic-beta',
    // Claude Code 2.1.280 会话/子代理身份头
    ...claudeCodeSessionHeaders,
    'accept-language',
    'sec-fetch-mode',
    // 注意：不透传 accept-encoding，避免客户端发送的 zstd 等 Node.js 不支持的编码
    // 被转发到上游，导致 axios 无法解压响应（Node 18 zlib 不支持 zstd）
    'user-agent',
    'content-type',
    'connection',
  ])

  const filtered = {}
  Object.keys(toHeaderMap(headers)).forEach((key) => {
    const lowerKey = key.toLowerCase()
    if (allowedHeaders.has(lowerKey)) {
      filtered[key] = headers[key]
    }
  })

  return filtered
}

/**
 * 为 Gemini API 过滤请求 headers
 */
export const filterForGemini = (headers) => {
  const skipHeaders = new Set([
    'host',
    'content-length',
    'connection',
    ...credentialStripHeaders,
    ...cdnHeaders,
    ...hopByHopHeaders,
  ])

  const filtered = {}
  for (const [key, value] of Object.entries(toHeaderMap(headers))) {
    if (!skipHeaders.has(key.toLowerCase())) {
      filtered[key] = value
    }
  }
  return filtered
}

/**
 * 为 Grok / xAI 过滤请求 headers
 * 黑名单 + 确保官方关键头可透传（与 xaiHelper 注入互补）
 */
export const filterForGrok = (headers) => {
  const skipHeaders = new Set([
    'host',
    'content-length',
    'connection',
    ...credentialStripHeaders,
    ...cdnHeaders,
    ...hopByHopHeaders,
  ])

  const filtered = {}
  for (const [key, value] of Object.entries(toHeaderMap(headers))) {
    if (!skipHeaders.has(key.toLowerCase())) {
      filtered[key] = value
    }
  }
  return filtered
}

/**
 * 响应侧剥离：hop-by-hop + 网关指纹
 * 调用方在 res.setHeader 前使用；不覆盖已由业务写入的安全头
 */
export const filterUpstreamResponseHeaders = (headers) => {
  const skip = new Set([
    ...hopByHopHeaders,
    ...gatewayFingerprintHeaders,
    'content-encoding', // 已由 axios 解压则不应再传
    'content-length',
    // 禁止上游向 CRS 域写 Cookie（可干扰 adminToken 等管理端认证）
    'set-cookie',
    'set-cookie2',
  ])

  const filtered = {}
  for (const [key, value] of Object.entries(toHeaderMap(headers))) {
    if (!skip.has(String(key).toLowerCase())) {
      filtered[key] = value
    }
  }
  return filtered
}

// 把过滤后的上游响应头写到 Express res（已存在的不覆盖）
export const applyFilteredResponseHeaders = (res, upstreamHeaders) => {
  if (!res || res.headersSent) {
    return
  }
  const filtered = filterUpstreamResponseHeaders(upstreamHeaders || {})
  for (const [key, value] of Object.entries(filtered)) {
    if (value === undefined || value === null) {
      continue
    }
    const lower = key.toLowerCase()
    if (res.getHeader(lower) !== undefined) {
      continue
    }
    try {
      res.setHeader(key, value)
    } catch (error) {
      // 非法 header 名忽略
    }
  }
}
