import { redis as redisClient } from '../../infra/redis.js'
import { RedisKeys, TTL } from '../../infra/redis_key.js'
import { logger } from '../../common/logger.js'
// Codex Realtime / Live 协议辅助（对齐官方 codex-rs + CLIProxyAPI / sub2api）
// - POST 建连：/v1/realtime/calls | /v1/live | /backend-api/codex/realtime/calls
// - 回包：SDP body + Location（含 call_id）
// - sideband WS：
//   API：wss://.../v1/realtime?call_id= 或 /v1/live/{call_id} 或 /v1/realtime/calls/{call_id}
//   ChatGPT OAuth：wss://chatgpt.com/backend-api/codex/{call_id}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isRealtimeCallIdSegment = (segment) => {
  if (!segment || typeof segment !== 'string') {
    return false
  }
  if (segment.startsWith('rtc_') && segment.length > 4) {
    return true
  }
  return UUID_RE.test(segment)
}

// 从上游 Location 抽 call_id（官方：rsplit 找 rtc_/uuid 段）
export const extractCallIdFromLocation = (location) => {
  if (!location || typeof location !== 'string') {
    return null
  }
  const pathOnly = location.split('?')[0] || location
  const segments = pathOnly.split('/').filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (isRealtimeCallIdSegment(segments[i])) {
      return segments[i]
    }
  }
  return null
}

// 客户端侧 Location：必须回 CRS 相对路径，客户端才会再走我们的 WS 代理
// 对齐 CLIProxy：/v1/realtime* → /v1/realtime/calls/{id}
// 对齐 sub2api：/backend-api/codex/* → /backend-api/codex/{id}；/v1/live → /v1/live/{id}
export const rewriteClientLocation = (requestPath, callId) => {
  if (!callId) {
    return null
  }
  const path = String(requestPath || '')
  if (path.includes('/backend-api/codex')) {
    return `/backend-api/codex/${encodeURIComponent(callId)}`
  }
  if (path.includes('/live')) {
    return `/v1/live/${encodeURIComponent(callId)}`
  }
  return `/v1/realtime/calls/${encodeURIComponent(callId)}`
}

export const extractCallIdFromWsRequest = (pathname, searchParams) => {
  if (searchParams) {
    const fromQuery = searchParams.get('call_id') || searchParams.get('callId')
    if (fromQuery && isRealtimeCallIdSegment(fromQuery)) {
      return fromQuery
    }
  }
  const path = String(pathname || '')
  const segments = path.split('/').filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = decodeURIComponent(segments[i])
    if (isRealtimeCallIdSegment(seg)) {
      return seg
    }
  }
  return null
}

// 客户端 WS 路径 → 上游 wss URL
// ChatGPT OAuth sideband 固定 wss://chatgpt.com/backend-api/codex/{call_id}（sub2api）
// API Key 形态保留 /v1/realtime?call_id= 或 /v1/live/{id}
export const resolveUpstreamWebSocketUrl = ({ pathname, search = '', callId = null, isChatGptOAuth = true } = {}) => {
  const path = String(pathname || '')
  const id = callId || extractCallIdFromWsRequest(path, new URLSearchParams(String(search).replace(/^\?/, '')))

  if (isChatGptOAuth) {
    if (!id) {
      // 无 call_id 的裸 realtime 握手少见；仍转发到 backend codex realtime 根
      return `wss://chatgpt.com/backend-api/codex/realtime${search || ''}`
    }
    return `wss://chatgpt.com/backend-api/codex/${encodeURIComponent(id)}`
  }

  // OpenAI API Key base
  if (id && (path.includes('/live/') || path.endsWith('/live'))) {
    return `wss://api.openai.com/v1/live/${encodeURIComponent(id)}`
  }
  if (id && path.includes('/realtime/calls/')) {
    return `wss://api.openai.com/v1/realtime/calls/${encodeURIComponent(id)}`
  }
  const qs = new URLSearchParams(String(search).replace(/^\?/, ''))
  if (id && !qs.has('call_id')) {
    qs.set('call_id', id)
  }
  const q = qs.toString()
  return `wss://api.openai.com/v1/realtime${q ? `?${q}` : ''}`
}

export const isRealtimeHttpCreatePath = (fullPath) => {
  const p = String(fullPath || '')
  // 官方/CLIProxy 建连路径并集：
  // - /v1/realtime/calls、/backend-api/codex/realtime/calls
  // - /v1/realtime（部分客户端省略 /calls）
  // - /v1/live（FramelessBidi）
  if (p.includes('/realtime/calls')) {
    return true
  }
  if (/\/v1\/realtime(\/|$|\?)/.test(p) && !p.includes('/responses')) {
    return true
  }
  if (/\/v1\/live(\/|$|\?)/.test(p) || /(^|\/)live(\/|$|\?)/.test(p)) {
    return true
  }
  return false
}

export const isRealtimeWebSocketPath = (pathname) => {
  const p = String(pathname || '')
  if (!p) {
    return false
  }
  if (p.includes('/v1/realtime') || p.includes('/v1/live')) {
    return true
  }
  // ChatGPT base：sideband 是 /backend-api/codex/{call_id}，路径里不一定含 realtime
  if (p.includes('/backend-api/codex')) {
    return true
  }
  return false
}

// POST 建连成功后绑定 call_id → account，WS 侧复用同一号
export const bindRealtimeCallAccount = async (callId, accountId, extra = {}) => {
  if (!callId || !accountId) {
    return
  }
  try {
    const client = redisClient.getClientSafe()
    const key = RedisKeys.session.codexRealtimeCall(callId)
    const payload = JSON.stringify({
      accountId,
      boundAt: new Date().toISOString(),
      ...extra,
    })
    await client.setex(key, TTL.codexRealtimeCall, payload)
  } catch (error) {
    console.error(error)
    logger.warn(`[CodexRealtime] bind call failed callId=${callId}: ${error.message}`)
  }
}

export const getRealtimeCallBinding = async (callId) => {
  if (!callId) {
    return null
  }
  try {
    const client = redisClient.getClientSafe()
    const raw = await client.get(RedisKeys.session.codexRealtimeCall(callId))
    if (!raw) {
      return null
    }
    return JSON.parse(raw)
  } catch (error) {
    console.error(error)
    logger.warn(`[CodexRealtime] get call binding failed callId=${callId}: ${error.message}`)
    return null
  }
}

// 从 Realtime/Live 事件中抽取 usage（OpenAI 官方 response.done / response.completed）
export const extractRealtimeUsageFromEvent = (eventObj) => {
  if (!eventObj || typeof eventObj !== 'object') {
    return null
  }
  const type = String(eventObj.type || '')
  const usage = eventObj.usage || eventObj.response?.usage || eventObj.session?.usage || null
  if (!usage || typeof usage !== 'object') {
    // 部分事件只在特定 type 下带 usage
    if (
      type !== 'response.done' &&
      type !== 'response.completed' &&
      type !== 'conversation.item.input_audio_transcription.completed' &&
      type !== 'rate_limits.updated'
    ) {
      return null
    }
    if (!usage) {
      return null
    }
  }

  const inputDetails = usage.input_token_details || usage.input_tokens_details || {}
  const outputDetails = usage.output_token_details || usage.output_tokens_details || {}
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || 0) || 0
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0) || 0
  const cacheReadTokens =
    Number(usage.cache_read_input_tokens || usage.cache_read_tokens || inputDetails.cached_tokens || 0) || 0
  const cacheCreateTokens = Number(usage.cache_creation_input_tokens || usage.cache_creation_tokens || 0) || 0

  if (inputTokens <= 0 && outputTokens <= 0 && cacheReadTokens <= 0 && cacheCreateTokens <= 0) {
    return null
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreateTokens,
    input_audio_tokens: Number(inputDetails.audio_tokens || 0) || 0,
    output_audio_tokens: Number(outputDetails.audio_tokens || 0) || 0,
    model: eventObj.response?.model || eventObj.session?.model || null,
  }
}

export const createRealtimeUsageAccumulator = () => {
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    input_audio_tokens: 0,
    output_audio_tokens: 0,
    eventCount: 0,
    lastModel: null,
  }

  const ingestText = (text) => {
    if (!text || typeof text !== 'string') {
      return
    }
    const trimmed = text.trim()
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
      return
    }
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }
    const events = Array.isArray(parsed) ? parsed : [parsed]
    for (const eventObj of events) {
      const usage = extractRealtimeUsageFromEvent(eventObj)
      if (!usage) {
        continue
      }
      totals.input_tokens += usage.input_tokens
      totals.output_tokens += usage.output_tokens
      totals.cache_read_input_tokens += usage.cache_read_input_tokens
      totals.cache_creation_input_tokens += usage.cache_creation_input_tokens
      totals.input_audio_tokens += usage.input_audio_tokens
      totals.output_audio_tokens += usage.output_audio_tokens
      totals.eventCount += 1
      if (usage.model) {
        totals.lastModel = usage.model
      }
    }
  }

  const snapshot = () => ({ ...totals })

  const hasTokenUsage = () =>
    totals.input_tokens > 0 ||
    totals.output_tokens > 0 ||
    totals.cache_read_input_tokens > 0 ||
    totals.cache_creation_input_tokens > 0

  return { ingestText, snapshot, hasTokenUsage }
}
