import { redis as redisClient } from '../../infra/redis.js'
import { RedisKeys, TTL } from '../../infra/redis_key.js'
import { logger } from '../../common/logger.js'
// Codex Realtime / Live 协议辅助（对齐官方 codex-rs + CLIProxyAPI / sub2api）
// - POST 建连：/v1/realtime/calls | /v1/live | /backend-api/codex/realtime/calls
// - 回包：SDP body + Location（含 call_id）
// - sideband WS：
// API：wss://.../v1/realtime?call_id= 或 /v1/live/{call_id} 或 /v1/realtime/calls/{call_id}
// ChatGPT OAuth：wss://chatgpt.com/backend-api/codex/{call_id}

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

  const responseId =
    (typeof eventObj.response?.id === 'string' && eventObj.response.id) ||
    (typeof eventObj.id === 'string' && eventObj.type && String(eventObj.type).startsWith('response.')
      ? eventObj.id
      : null) ||
    null

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreateTokens,
    input_audio_tokens: Number(inputDetails.audio_tokens || 0) || 0,
    output_audio_tokens: Number(outputDetails.audio_tokens || 0) || 0,
    model: eventObj.response?.model || eventObj.session?.model || null,
    service_tier:
      (typeof eventObj.response?.service_tier === 'string' && eventObj.response.service_tier) ||
      (typeof eventObj.service_tier === 'string' && eventObj.service_tier) ||
      null,
    responseId,
  }
}

const normalizeRequestServiceTier = (raw) => {
  if (typeof raw !== 'string') {
    return null
  }
  const normalized = raw.trim().toLowerCase()
  if (!normalized || normalized === 'auto' || normalized === 'default') {
    return null
  }
  return normalized
}

const extractRequestServiceTier = (eventObj) => {
  const top =
    (typeof eventObj.service_tier === 'string' && eventObj.service_tier) ||
    (eventObj.response && typeof eventObj.response.service_tier === 'string' && eventObj.response.service_tier) ||
    null
  return normalizeRequestServiceTier(top)
}

export const createRealtimeUsageAccumulator = () => {
  // 按单次 completed usage 分桶（turn 序号 + tier + model），禁止跨 turn 合并后一次计费
  // DEC_20260905_194420
  // 档位：FIFO 队列 + response.id 绑定，禁止连接级单槽错配
  // DEC_20260906_011816
  const entries = []
  const pendingTierQueue = []
  const tierByResponseId = new Map()
  const totals = {
    eventCount: 0,
    lastModel: null,
    lastServiceTier: null,
    lastRequestServiceTier: null,
    lastErrorEvent: null,
    cyberPolicyEvent: null,
  }

  const noteCyber = (eventObj) => {
    totals.lastErrorEvent = eventObj
    if (totals.cyberPolicyEvent) {
      return
    }
    const SESSION_CODES = new Set(['session_blocked_by_cyber_policy', 'session_blocked', 'conversation_blocked'])
    const SESSION_RE =
      /session is blocked|start a new session|blocked by cyber|cyber-security policy|网络安全策略|开启新会话|该会话已被/i
    const cands = [eventObj, eventObj.error, eventObj.response, eventObj.response && eventObj.response.error].filter(
      (item) => item && typeof item === 'object',
    )
    for (const candidate of cands) {
      const code = String((candidate && (candidate.code || candidate.type)) || '').toLowerCase()
      const message = String((candidate && candidate.message) || '')
      if (
        (code && (SESSION_CODES.has(code) || /session_blocked/.test(code))) ||
        (message && SESSION_RE.test(message))
      ) {
        totals.cyberPolicyEvent = eventObj
        break
      }
    }
  }

  const exhaustedResponseIds = new Set()
  // 队列溢出后本连接停止新关联，已入队/已绑 id 仍可 drain
  // DEC_20260906_103722
  let associationFrozen = false

  const refreshLastRequestServiceTier = () => {
    totals.lastRequestServiceTier = pendingTierQueue.length > 0 ? pendingTierQueue[pendingTierQueue.length - 1] : null
  }

  const rememberExhaustedResponseId = (responseId) => {
    if (!responseId) {
      return
    }
    exhaustedResponseIds.add(responseId)
    while (exhaustedResponseIds.size > 256) {
      const oldest = exhaustedResponseIds.values().next().value
      exhaustedResponseIds.delete(oldest)
    }
  }

  const extractEventResponseId = (eventObj, usageResponseId = null) => {
    if (typeof usageResponseId === 'string' && usageResponseId) {
      return usageResponseId
    }
    if (eventObj && typeof eventObj.response?.id === 'string' && eventObj.response.id) {
      return eventObj.response.id
    }
    if (eventObj && typeof eventObj.id === 'string' && eventObj.type && String(eventObj.type).startsWith('response.')) {
      return eventObj.id
    }
    return null
  }

  const freezeAssociation = (reason) => {
    if (associationFrozen) {
      return
    }
    associationFrozen = true
    // 未绑定 FIFO 已与上游响应失序，清空后禁止再绑 created / 未知 id 终端
    // 冻结前已按 response.id 绑定的仍可 drain
    // DEC_20260906_105200
    pendingTierQueue.length = 0
    refreshLastRequestServiceTier()
    logger.warn(`[CodexRealtime] freeze request-tier association: ${reason}`)
  }

  const enqueueRequestTier = (eventObj) => {
    const tier = extractRequestServiceTier(eventObj)
    if (associationFrozen) {
      return
    }
    if (pendingTierQueue.length >= 64) {
      // 满则丢本条并冻结后续关联，禁止腾位后再入队导致串档
      // DEC_20260906_014853 丢最新；DEC_20260906_103722 溢出后停止关联
      freezeAssociation('pending tier queue full')
      return
    }
    pendingTierQueue.push(tier)
    totals.lastRequestServiceTier = tier
  }

  const bindCreatedResponseId = (eventObj) => {
    const responseId =
      (typeof eventObj.response?.id === 'string' && eventObj.response.id) ||
      (typeof eventObj.id === 'string' && eventObj.id) ||
      null
    if (associationFrozen || !responseId || pendingTierQueue.length === 0) {
      return
    }
    if (tierByResponseId.has(responseId) || exhaustedResponseIds.has(responseId)) {
      return
    }
    const tier = pendingTierQueue.shift()
    refreshLastRequestServiceTier()
    tierByResponseId.set(responseId, tier)
    while (tierByResponseId.size > 128) {
      const oldest = tierByResponseId.keys().next().value
      rememberExhaustedResponseId(oldest)
      tierByResponseId.delete(oldest)
    }
  }

  // 终端事件只消费一次：有 id 走绑定，无 id 才 FIFO
  // 未知 id 的 completed/done：隐式 created（绑队头到该 id）再消费
  // DEC_20260906_014853 / DEC_20260906_103722
  const consumeTurnTier = (eventObj, usageResponseId = null) => {
    const responseId = extractEventResponseId(eventObj, usageResponseId)
    const eventType = eventObj && eventObj.type
    if (responseId) {
      if (tierByResponseId.has(responseId)) {
        const tier = tierByResponseId.get(responseId)
        tierByResponseId.delete(responseId)
        rememberExhaustedResponseId(responseId)
        return tier
      }
      if (exhaustedResponseIds.has(responseId)) {
        return null
      }
      // 冻结后禁止用 FIFO 给未知 id 兜底，避免被丢弃请求抢走其它档位
      // DEC_20260906_105200
      if (associationFrozen) {
        return null
      }
      if (eventType === 'response.completed' || eventType === 'response.done') {
        if (pendingTierQueue.length > 0) {
          const tier = pendingTierQueue.shift()
          refreshLastRequestServiceTier()
          rememberExhaustedResponseId(responseId)
          return tier
        }
        return null
      }
      // created 尚未见到：failed/error 释放队头
      if (eventType === 'response.failed' || eventType === 'error') {
        if (pendingTierQueue.length > 0) {
          const tier = pendingTierQueue.shift()
          refreshLastRequestServiceTier()
          rememberExhaustedResponseId(responseId)
          return tier
        }
      }
      return null
    }
    if (associationFrozen) {
      return null
    }
    if (pendingTierQueue.length > 0) {
      const tier = pendingTierQueue.shift()
      refreshLastRequestServiceTier()
      return tier
    }
    return null
  }

  // 解析事件数组；source=upstream 才允许 usage 入账；client 只采 create 档位
  // DEC_20260906_011816 客户端帧禁止伪造 usage 扣费
  const ingestParsedEvents = (events, source) => {
    const fromClient = source === 'client'
    for (const eventObj of events) {
      if (!eventObj || typeof eventObj !== 'object') {
        continue
      }
      const eventType = eventObj.type
      if (eventType === 'response.create') {
        enqueueRequestTier(eventObj)
        continue
      }
      // 客户端其余事件一律忽略（含假 completed / usage）
      if (fromClient) {
        continue
      }
      if (eventType === 'response.created') {
        bindCreatedResponseId(eventObj)
      }
      if (eventType === 'response.failed' || eventType === 'error' || eventObj.error) {
        noteCyber(eventObj)
      }
      const usage = extractRealtimeUsageFromEvent(eventObj)
      const isTerminal =
        eventType === 'response.completed' ||
        eventType === 'response.done' ||
        eventType === 'response.failed' ||
        eventType === 'error'
      // 终端事件只消费一次档位槽：先取档再入账，failed+usage 不会先删后偷下一请求
      // 普通 error / 零用量 completed 同样释放队头，避免后续串档
      // DEC_20260906_014853
      let consumedTier = null
      if (isTerminal) {
        consumedTier = consumeTurnTier(eventObj, usage && usage.responseId)
      }
      if (!usage) {
        continue
      }
      const serviceTier = usage.service_tier || consumedTier || null
      const model = (typeof usage.model === 'string' && usage.model.trim()) || totals.lastModel || null
      entries.push({
        serviceTier: serviceTier || null,
        model,
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        input_audio_tokens: usage.input_audio_tokens || 0,
        output_audio_tokens: usage.output_audio_tokens || 0,
        eventCount: 1,
        lastModel: model,
      })
      totals.eventCount += 1
      if (model) {
        totals.lastModel = model
      }
      if (serviceTier) {
        totals.lastServiceTier = serviceTier
      }
      refreshLastRequestServiceTier()
    }
  }

  const parseEventsFromText = (text) => {
    if (!text || typeof text !== 'string') {
      return null
    }
    const trimmed = text.trim()
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
      return null
    }
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null
    }
    return Array.isArray(parsed) ? parsed : [parsed]
  }

  // 兼容旧调用：默认按上游处理（单测/历史路径）
  const ingestText = (text) => {
    const events = parseEventsFromText(text)
    if (!events) {
      return
    }
    ingestParsedEvents(events, 'upstream')
  }

  const ingestClientText = (text) => {
    const events = parseEventsFromText(text)
    if (!events) {
      return
    }
    ingestParsedEvents(events, 'client')
  }

  const ingestUpstreamText = (text) => {
    const events = parseEventsFromText(text)
    if (!events) {
      return
    }
    ingestParsedEvents(events, 'upstream')
  }

  const snapshot = () => {
    let input_tokens = 0
    let output_tokens = 0
    let cache_read_input_tokens = 0
    let cache_creation_input_tokens = 0
    let input_audio_tokens = 0
    let output_audio_tokens = 0
    for (const entry of entries) {
      input_tokens += entry.input_tokens
      output_tokens += entry.output_tokens
      cache_read_input_tokens += entry.cache_read_input_tokens
      cache_creation_input_tokens += entry.cache_creation_input_tokens
      input_audio_tokens += entry.input_audio_tokens
      output_audio_tokens += entry.output_audio_tokens
    }
    return {
      input_tokens,
      output_tokens,
      cache_read_input_tokens,
      cache_creation_input_tokens,
      input_audio_tokens,
      output_audio_tokens,
      eventCount: totals.eventCount,
      lastModel: totals.lastModel,
      lastServiceTier: totals.lastServiceTier,
      lastRequestServiceTier: totals.lastRequestServiceTier,
      lastErrorEvent: totals.lastErrorEvent,
      cyberPolicyEvent: totals.cyberPolicyEvent,
      // 每条 completed usage 单独一项，结算时分别 recordUsage
      tierUsages: entries.map((entry) => ({ ...entry })),
    }
  }

  const hasTokenUsage = () =>
    entries.some(
      (entry) =>
        entry.input_tokens > 0 ||
        entry.output_tokens > 0 ||
        entry.cache_read_input_tokens > 0 ||
        entry.cache_creation_input_tokens > 0,
    )

  return { ingestText, ingestClientText, ingestUpstreamText, snapshot, hasTokenUsage }
}
