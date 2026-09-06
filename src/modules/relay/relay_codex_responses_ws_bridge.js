// Codex Responses WebSocket → HTTP/SSE 桥（http_bridge）
// 客户端仍走 WS（response.create / response.append），上游走官方 HTTP stream
// 对照：CLIProxyAPI responses websocket HTTP mode + sub2api http_bridge
import axios from 'axios'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

import { config } from '../../../config/config.js'
import { env } from '../../../config/env.js'
import { logger } from '../../common/logger.js'
import { acceptWebSocketEndpoint, encodeWsClientText, encodeWsClientPong } from '../../common/gateway_ws_endpoint.js'
import { createWsFrameSniffer } from '../../common/gateway_ws_frame_sniffer.js'
import { IncrementalSSEParser } from './relay_sse_parser.js'
import { filterForOpenAI, codexCriticalRequestHeaders } from './relay_header_filter.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { unifiedOpenAIScheduler } from './relay_unified_openai_scheduler.js'
import * as openaiAccountService from '../account/account_openai_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import {
  createRequestDetailMeta,
  buildFailedRequestDetailPayload,
  resolveOpenAIServiceTier,
} from './relay_request_detail_helper.js'
import { requestDetailService } from './relay_request_detail_service.js'
import * as responsesWs from './relay_codex_responses_ws.js'
import { repairResponsesToolCallsInBody } from './relay_codex_responses_ws_tool_repair.js'
import { sanitizeOpenAICapacityShedForClient } from './relay_openai_capacity_shed.js'
import { applyOpenAIServiceTierAlias } from './relay_openai_compact_v2.js'
import { applyOpenAIPublicModelAlias } from './relay_openai_model_alias.js'
import { normalizeCodexBootstrapBody } from './relay_codex_bootstrap_normalize.js'
import { extractUpstreamErrorCode, extractSafeMessage } from '../../common/client_error_builder.js'
import { normalizeKnownOpenAICodexModel } from './relay_openai_model_alias.js'

// 与 relay_openai_routes.getCodexCompatibleModel 同语义（避免跨文件非导出依赖）
const getCodexCompatibleModel = (requestedModel = null) => {
  const isCodexModel = typeof requestedModel === 'string' && requestedModel.toLowerCase().includes('codex')
  if (requestedModel && requestedModel.startsWith('gpt-5-') && !isCodexModel) {
    return 'gpt-5'
  }
  return requestedModel
}

// 会话内对话状态：支持 append / previous_response_id 增量
const createBridgeSessionState = () => ({
  model: null,
  // 累积 input（message / function_call / function_call_output 等）
  inputItems: [],
  lastResponseId: null,
  instructions: null,
  tools: null,
  toolChoice: null,
  parallelToolCalls: undefined,
  temperature: undefined,
  topP: undefined,
  maxOutputTokens: undefined,
  reasoning: undefined,
  serviceTier: undefined,
  // DEC_20260905_194420 WS 多路径 cyber-policy 命中后，同连接后续 turn 直接拒绝
  cyberPolicyBlocked: false,
  cyberPolicyCode: null,
  cyberPolicyMessage: null,
})

// 仅会话级 cyber/session block 才钉死连接；invalid_prompt/content_filter 等可自愈，不封锁后续 turn
const SESSION_CYBER_BLOCK_CODES = new Set([
  'session_blocked_by_cyber_policy',
  'session_blocked',
  'conversation_blocked',
])
const SESSION_CYBER_BLOCK_MESSAGE_RE =
  /session is blocked|start a new session|blocked by cyber|cyber-security policy|网络安全策略|开启新会话|该会话已被/i

// 透传帧出站前：仅对 JSON response.create 做公开模型别名归一，其它帧原样

// 字符串字段脱敏：在真实空白上匹配，避免 JSON.stringify 后 \\t/\\n 漏 Bearer
// DEC_20260906_011816
const sanitizeCredentialText = (text) => {
  if (typeof text !== 'string' || !text) {
    return text
  }
  return text
    .replace(/Bearer[ \t\r\n]+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/\bsk-(?:proj|ant|svcacct)-[A-Za-z0-9_-]{8,}/gi, 'sk-***')
    .replace(/\bsk-[A-Za-z0-9]{8,}/g, 'sk-***')
    .replace(/https?:\/\/[^\s"']+/g, '[upstream]')
    .replace(/([?&](?:key|token|auth|password|secret|api_key)=)[^&\s"']+/gi, '$1***')
}

const sanitizeDeepValue = (value, depth = 0) => {
  if (value === null || value === undefined) {
    return value
  }
  if (depth > 8) {
    return typeof value === 'string' ? sanitizeCredentialText(value).slice(0, 4000) : value
  }
  if (typeof value === 'string') {
    return sanitizeCredentialText(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDeepValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      out[key] = sanitizeDeepValue(value[key], depth + 1)
    }
    return out
  }
  return value
}

export const sanitizeUpstreamBodyForDetail = (body) => {
  if (body === null || body === undefined) {
    return null
  }
  if (typeof body === 'string') {
    return sanitizeCredentialText(body).slice(0, 4000)
  }
  try {
    return sanitizeDeepValue(body)
  } catch (error) {
    console.error(error)
    try {
      return sanitizeCredentialText(String(body)).slice(0, 4000)
    } catch {
      return null
    }
  }
}

export const rewriteClientWsTextForUpstream = (text) => {
  if (typeof text !== 'string' || !text.trim()) {
    return text
  }
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return text
  }
  if (!message || typeof message !== 'object') {
    return text
  }
  const type = message.type || 'response.create'
  if (type !== 'response.create' && type !== 'response.append') {
    return text
  }
  // 顶层 model 或 response.model
  if (typeof message.model === 'string') {
    const body = { model: message.model }
    applyOpenAIPublicModelAlias(body)
    message.model = body.model
  }
  if (message.response && typeof message.response === 'object' && typeof message.response.model === 'string') {
    const body = { model: message.response.model }
    applyOpenAIPublicModelAlias(body)
    message.response.model = body.model
  }
  if (typeof message.service_tier === 'string') {
    applyOpenAIServiceTierAlias(message)
  }
  try {
    return JSON.stringify(message)
  } catch {
    return text
  }
}

export const isSessionCyberPolicyBlock = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return false
  }
  // 展开嵌套：response.failed 常把 error 放在 response.error
  const candidates = [payload, payload.error, payload.response, payload.response?.error].filter(
    (item) => item && typeof item === 'object',
  )

  for (const candidate of candidates) {
    const code = String(extractUpstreamErrorCode(candidate) || '').toLowerCase()
    if (code && SESSION_CYBER_BLOCK_CODES.has(code)) {
      return true
    }
    if (code && /session_blocked/.test(code)) {
      return true
    }
    const message = extractSafeMessage(candidate) || ''
    if (message && SESSION_CYBER_BLOCK_MESSAGE_RE.test(message)) {
      return true
    }
  }
  return false
}

// 从上游 error / response.failed 事件识别会话级 cyber policy，写入会话态
const noteCyberPolicyFromUpstream = (state, payload, pathLabel = 'ws') => {
  if (!state || !payload || typeof payload !== 'object') {
    return false
  }
  const candidates = [payload, payload.error, payload.response, payload.response?.error].filter(
    (item) => item && typeof item === 'object',
  )

  for (const candidate of candidates) {
    if (!isSessionCyberPolicyBlock(candidate)) {
      continue
    }
    // 从命中候选提取真正 code/message（嵌套 response.error 优先）
    const nestedCandidates = [candidate.response?.error, candidate.error, candidate].filter(
      (item) => item && typeof item === 'object',
    )
    let code = ''
    let message = ''
    for (const nested of nestedCandidates) {
      const nestedCode = extractUpstreamErrorCode(nested)
      const nestedMessage = extractSafeMessage(nested)
      if (nestedCode && SESSION_CYBER_BLOCK_CODES.has(nestedCode.toLowerCase())) {
        code = nestedCode
        message = nestedMessage || message
        break
      }
      if (nestedCode && /session_blocked/i.test(nestedCode)) {
        code = nestedCode
        message = nestedMessage || message
        break
      }
      if (nestedMessage && SESSION_CYBER_BLOCK_MESSAGE_RE.test(nestedMessage)) {
        code = nestedCode || code
        message = nestedMessage
        break
      }
    }
    code = code || 'session_blocked_by_cyber_policy'
    message = message || 'Session blocked by cyber policy; start a new session'
    state.cyberPolicyBlocked = true
    state.cyberPolicyCode = code
    state.cyberPolicyMessage = message
    logger.warn(`[ResponsesWS-bridge] cyber policy recorded path=${pathLabel} code=${code} message=${message}`)
    return true
  }
  return false
}

const extractUsageFromCompleted = (eventData) => {
  const usage = eventData?.response?.usage
  if (!usage || typeof usage !== 'object') {
    return null
  }
  const totalInput = usage.input_tokens || usage.prompt_tokens || 0
  const cacheRead =
    usage.cache_read_input_tokens ||
    usage.input_tokens_details?.cached_tokens ||
    usage.prompt_tokens_details?.cached_tokens ||
    0
  const cacheCreate = usage.cache_creation_input_tokens || 0
  const actualInput = Math.max(0, Number(totalInput) - Number(cacheRead) || 0)
  const responseTier =
    (typeof eventData?.response?.service_tier === 'string' && eventData.response.service_tier) || null
  return {
    input_tokens: actualInput,
    output_tokens: usage.output_tokens || usage.completion_tokens || 0,
    cache_read_input_tokens: Number(cacheRead) || 0,
    cache_creation_input_tokens: Number(cacheCreate) || 0,
    service_tier: responseTier,
    raw: usage,
  }
}

// 把 client WS 消息规范成可 POST 的 responses body
export const buildHttpResponsesBodyFromWsMessage = (message, state) => {
  if (!message || typeof message !== 'object') {
    throw Object.assign(new Error('invalid websocket message'), { statusCode: 400 })
  }
  const type = message.type || 'response.create'

  if (type === 'response.create') {
    // 完整 body 可能在 message 顶层，或 message.response 下
    const source =
      message.response && typeof message.response === 'object' ? { ...message, ...message.response } : message
    const model = source.model || state.model
    if (!model) {
      throw Object.assign(new Error('missing model in response.create'), { statusCode: 400 })
    }
    // 公开别名归一写入 state，保证 create/append 出站一致；选号用同一归一名
    const canonicalModel = normalizeKnownOpenAICodexModel(model) || model
    state.model = canonicalModel
    state.clientModel = model

    if (source.instructions !== undefined) {
      state.instructions = source.instructions
    }
    if (source.tools !== undefined) {
      state.tools = source.tools
    }
    if (source.tool_choice !== undefined) {
      state.toolChoice = source.tool_choice
    }
    if (source.parallel_tool_calls !== undefined) {
      state.parallelToolCalls = source.parallel_tool_calls
    }
    if (source.temperature !== undefined) {
      state.temperature = source.temperature
    }
    if (source.top_p !== undefined) {
      state.topP = source.top_p
    }
    if (source.max_output_tokens !== undefined) {
      state.maxOutputTokens = source.max_output_tokens
    }
    if (source.reasoning !== undefined) {
      state.reasoning = source.reasoning
    }
    if (source.service_tier !== undefined) {
      state.serviceTier = source.service_tier
    }

    const inputDelta = Array.isArray(source.input) ? source.input : []
    const previousId = source.previous_response_id || null

    const body = {
      model: getCodexCompatibleModel(canonicalModel) || canonicalModel,
      stream: true,
      store: false,
    }
    if (source.service_tier !== undefined) {
      body.service_tier = source.service_tier
    }
    applyOpenAIServiceTierAlias(body)
    applyOpenAIPublicModelAlias(body)

    // v2 续写：有 previous_response_id 时只发本轮 delta input，禁止把历史整包重放
    if (previousId) {
      state.lastResponseId = previousId
      body.previous_response_id = previousId
      body.input = inputDelta
      if (inputDelta.length) {
        state.inputItems = state.inputItems.concat(inputDelta)
      }
    } else if (inputDelta.length) {
      // 新会话：全量 input
      state.inputItems = [...inputDelta]
      state.lastResponseId = null
      body.input = state.inputItems
    } else if (state.lastResponseId) {
      // 无 input 的续写
      body.previous_response_id = state.lastResponseId
      body.input = []
    } else {
      body.input = state.inputItems
    }

    if (state.instructions !== null && state.instructions !== undefined) {
      body.instructions = state.instructions
    }
    if (state.tools !== null && state.tools !== undefined) {
      body.tools = state.tools
    }
    if (state.toolChoice !== null && state.toolChoice !== undefined) {
      body.tool_choice = state.toolChoice
    }
    if (state.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = state.parallelToolCalls
    }
    if (state.temperature !== undefined) {
      body.temperature = state.temperature
    }
    if (state.topP !== undefined) {
      body.top_p = state.topP
    }
    if (state.maxOutputTokens !== undefined) {
      body.max_output_tokens = state.maxOutputTokens
    }
    if (state.reasoning !== undefined) {
      body.reasoning = state.reasoning
    }
    if (state.serviceTier !== undefined && state.serviceTier !== null) {
      body.service_tier = state.serviceTier
      applyOpenAIServiceTierAlias(body)
    }

    // 先 bootstrap 再 tool repair：repair 会丢无 call_id 的 function_call_output
    // DEC_20260904_174000 bootstrap 必须先于 repair，否则 delegation/automation 被丢弃
    const bootstrap = normalizeCodexBootstrapBody(body)
    if (bootstrap.changed) {
      logger.info(`Codex bootstrap normalized on WS bridge kinds=${bootstrap.kinds.join(',')}`)
    }
    const repaired = repairResponsesToolCallsInBody(bootstrap.body)
    applyOpenAIPublicModelAlias(repaired)
    return repaired
  }

  if (type === 'response.append') {
    // 旧协议 append：只发增量 + previous_response_id，不重放完整历史
    let delta = message.input || message.delta || message.items
    if (!Array.isArray(delta)) {
      delta = typeof message.text === 'string' ? [{ type: 'message', role: 'user', content: message.text }] : []
    }
    if (!state.model) {
      throw Object.assign(new Error('response.append before response.create'), { statusCode: 400 })
    }
    if (delta.length) {
      state.inputItems = state.inputItems.concat(delta)
    }
    const body = {
      model: getCodexCompatibleModel(state.model) || state.model,
      input: delta,
      stream: true,
      store: false,
    }
    if (state.lastResponseId) {
      body.previous_response_id = state.lastResponseId
    }
    if (state.instructions !== null && state.instructions !== undefined) {
      body.instructions = state.instructions
    }
    if (state.tools !== null && state.tools !== undefined) {
      body.tools = state.tools
    }
    if (state.toolChoice !== null && state.toolChoice !== undefined) {
      body.tool_choice = state.toolChoice
    }
    if (state.serviceTier !== null && state.serviceTier !== undefined) {
      body.service_tier = state.serviceTier
    }
    applyOpenAIServiceTierAlias(body)
    applyOpenAIPublicModelAlias(body)
    const bootstrapAppend = normalizeCodexBootstrapBody(body)
    if (bootstrapAppend.changed) {
      logger.info(`Codex bootstrap normalized on WS append kinds=${bootstrapAppend.kinds.join(',')}`)
    }
    return repairResponsesToolCallsInBody(bootstrapAppend.body)
  }

  throw Object.assign(new Error(`unsupported websocket message type: ${type}`), { statusCode: 400 })
}

const buildUpstreamHeaders = ({ accessToken, account, accountId, clientHeaders }) => {
  const incoming = clientHeaders || {}
  const headers = filterForOpenAI(incoming)
  for (const key of codexCriticalRequestHeaders) {
    if (headers[key] === undefined && incoming[key] !== undefined) {
      headers[key] = incoming[key]
    }
  }
  headers.authorization = `Bearer ${accessToken}`
  headers['chatgpt-account-id'] =
    headers['chatgpt-account-id'] || account?.accountId || account?.chatgptUserId || accountId
  headers.host = 'chatgpt.com'
  headers.accept = 'text/event-stream'
  headers['content-type'] = 'application/json'
  headers['openai-beta'] = responsesWs.mergeResponsesWebsocketBetaHeader(headers['openai-beta'])
  return headers
}

const resolveUpstreamUrl = (accountType) => {
  // openai-responses 第三方走其 base；OAuth 固定 chatgpt codex
  if (accountType === 'openai-responses') {
    return null // 调用方用 openai-responses relay 不适用 bridge 简化路径
  }
  return 'https://chatgpt.com/backend-api/codex/responses'
}

/**
 * 处理一条 WS 客户端消息：HTTP SSE 上游 → 回写 WS 事件
 */
const runOneTurn = async ({
  body,
  accessToken,
  account,
  accountId,
  accountType,
  clientHeaders,
  sendText,
  apiKeyData,
  reqMeta,
  state,
  abortSignal: contextAbortSignal = null,
}) => {
  if (accountType === 'openai-responses') {
    sendText(
      JSON.stringify({
        type: 'error',
        error: {
          message: 'http_bridge currently requires OpenAI OAuth (ChatGPT) account',
          type: 'invalid_request_error',
          code: 'unsupported_account_type',
        },
      }),
    )
    return { ok: false }
  }

  const upstreamUrl = resolveUpstreamUrl(accountType)
  const headers = buildUpstreamHeaders({ accessToken, account, accountId, clientHeaders })
  const proxyResolution = proxyResolver.resolveAgent(account, 'codex')
  const axiosConfig = {
    headers,
    timeout: config.requestTimeout || 600000,
    responseType: 'stream',
    validateStatus: () => true,
    signal: contextAbortSignal || undefined,
  }
  if (proxyResolution.agent) {
    axiosConfig.httpAgent = proxyResolution.agent
    axiosConfig.httpsAgent = proxyResolution.agent
    axiosConfig.proxy = false
  }

  let upstream
  try {
    upstream = await axios.post(upstreamUrl, body, axiosConfig)
  } catch (error) {
    console.error(error)
    proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, error)
    sendText(
      JSON.stringify({
        type: 'error',
        error: { message: error.message || 'upstream request failed', type: 'api_error' },
      }),
    )
    if (apiKeyData?.id) {
      try {
        if (reqMeta && typeof reqMeta === 'object') {
          reqMeta._crsAccountId = accountId || reqMeta._crsAccountId || null
          reqMeta._crsAccountType = accountType || reqMeta._crsAccountType || 'openai'
          // 建连失败：清掉上一轮上游头，避免失败详情误挂旧 upstreamRequestId
          reqMeta._crsUpstreamHeaders = null
          reqMeta._crsUpstreamRequestIdHeader = null
          if (!reqMeta.apiKey) {
            reqMeta.apiKey = apiKeyData
          }
        }
        const failedPayload = buildFailedRequestDetailPayload({
          req: reqMeta,
          statusCode: 502,
          durationMs: null,
          responseBody: sanitizeUpstreamBodyForDetail({
            error: { message: error.message || 'upstream request failed', type: 'api_error' },
          }),
          path: '/openai/v1/responses#ws-bridge',
        })
        failedPayload.apiKeyId = apiKeyData.id
        failedPayload.accountId = accountId || failedPayload.accountId
        failedPayload.accountType = accountType || 'openai'
        failedPayload.model = body?.model || failedPayload.model || 'unknown'
        failedPayload.stream = true
        await requestDetailService.captureRequestDetail(failedPayload)
      } catch (captureError) {
        console.error(captureError)
      }
    }
    return { ok: false }
  }

  // 客户端断开：中止已建立的 SSE 流（signal 主要拦握手前；流式还需 destroy）
  const destroyUpstream = () => {
    try {
      if (upstream?.data && typeof upstream.data.destroy === 'function') {
        upstream.data.destroy()
      }
    } catch (e) {
      console.error(e)
    }
  }
  if (contextAbortSignal) {
    if (contextAbortSignal.aborted) {
      destroyUpstream()
      return { ok: false, aborted: true }
    }
    contextAbortSignal.addEventListener('abort', destroyUpstream, { once: true })
  }

  // DEC_20260905_194420 bridge 成功/失败都挂上游头到 reqMeta
  if (reqMeta && typeof reqMeta === 'object') {
    reqMeta._crsUpstreamHeaders = upstream.headers || null
    reqMeta._crsUpstreamRequestIdHeader =
      account?.upstreamRequestIdHeader || account?.extra?.upstreamRequestIdHeader || null
  }

  if (upstream.status >= 400) {
    // 读错误体
    const chunks = []
    await new Promise((resolve) => {
      upstream.data.on('data', (c) => chunks.push(c))
      upstream.data.on('end', resolve)
      upstream.data.on('error', resolve)
      setTimeout(resolve, 5000)
    })
    let errBody = Buffer.concat(chunks).toString('utf8')
    try {
      errBody = JSON.parse(errBody)
    } catch {
      errBody = { error: { message: errBody || `upstream ${upstream.status}` } }
    }
    // 出站 capacity 码改写（内部仍可看原始 errBody）
    const sanitizedErr = sanitizeOpenAICapacityShedForClient(errBody)
    const clientErrBody = sanitizedErr.payload
    noteCyberPolicyFromUpstream(state, clientErrBody, 'http_error')
    noteCyberPolicyFromUpstream(state, errBody, 'http_error_raw')
    proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, new Error(`status ${upstream.status}`))
    sendText(
      JSON.stringify({
        type: 'error',
        error: clientErrBody.error || clientErrBody,
        status: upstream.status,
      }),
    )
    if (apiKeyData?.id) {
      try {
        if (reqMeta && typeof reqMeta === 'object') {
          reqMeta._crsAccountId = accountId || reqMeta._crsAccountId || null
          reqMeta._crsAccountType = accountType || reqMeta._crsAccountType || 'openai'
          if (!reqMeta.apiKey) {
            reqMeta.apiKey = apiKeyData
          }
        }
        const failedPayload = buildFailedRequestDetailPayload({
          req: reqMeta,
          statusCode: Number(upstream.status) || 502,
          durationMs: null,
          responseBody: sanitizeUpstreamBodyForDetail(errBody),
          path: '/openai/v1/responses#ws-bridge',
        })
        failedPayload.apiKeyId = apiKeyData.id
        failedPayload.accountId = accountId || failedPayload.accountId
        failedPayload.accountType = accountType || 'openai'
        failedPayload.model = body?.model || failedPayload.model || 'unknown'
        failedPayload.stream = true
        await requestDetailService.captureRequestDetail(failedPayload)
      } catch (error) {
        console.error(error)
        logger.error(`[ResponsesWS-bridge] http error detail capture: ${error.message}`)
      }
    }
    return { ok: false, status: upstream.status }
  }

  const parser = new IncrementalSSEParser()
  let usagePayload = null
  let actualModel = body.model
  let completedId = null
  // DEC_20260904_174000 半截流：无 terminal 不得 ok=true
  let sawResponseCreated = false
  let sawTerminal = false
  let terminalFailed = false
  let streamError = null
  let lastFailEvent = null

  await new Promise((resolve, reject) => {
    upstream.data.on('data', (chunk) => {
      try {
        const events = parser.feed(chunk.toString('utf8'))
        for (const event of events || []) {
          if (!event) {
            continue
          }
          if (event.type === 'done') {
            sendText(JSON.stringify({ type: 'response.done' }))
            continue
          }
          if (event.type !== 'data' || !event.data || typeof event.data !== 'object') {
            continue
          }
          const eventData = event.data
          const eventType = eventData.type

          if (eventType === 'response.created') {
            sawResponseCreated = true
          }
          if (
            eventType === 'response.completed' ||
            eventType === 'response.failed' ||
            eventType === 'response.done' ||
            eventType === 'error'
          ) {
            sawTerminal = true
            if (eventType === 'response.failed' || eventType === 'error') {
              terminalFailed = true
              lastFailEvent = eventData
              noteCyberPolicyFromUpstream(state, eventData, `sse_${eventType}`)
            }
          }

          // capacity shed 出站改写
          const sanitizedEvent = sanitizeOpenAICapacityShedForClient(eventData)
          const clientEvent = sanitizedEvent.payload

          // 回写客户端：WS 文本帧 = 事件 JSON（官方 WS 语义）
          sendText(JSON.stringify(clientEvent))

          if (eventData.type === 'response.completed' && eventData.response) {
            actualModel = eventData.response.model || actualModel
            completedId = eventData.response.id || completedId
            usagePayload = extractUsageFromCompleted(eventData)
            if (completedId) {
              state.lastResponseId = completedId
            }
            // 把 output 里的 function_call 等并入 input 历史，便于 append
            const { output } = eventData.response
            if (Array.isArray(output) && output.length) {
              state.inputItems = state.inputItems.concat(output)
            }
          }
        }
      } catch (error) {
        console.error(error)
      }
    })
    upstream.data.on('end', resolve)
    upstream.data.on('error', (error) => {
      console.error(error)
      streamError = error
      reject(error)
    })
  }).catch((error) => {
    streamError = error
    sendText(
      JSON.stringify({
        type: 'error',
        error: { message: error.message || 'stream error', type: 'api_error', code: 'upstream_stream_error' },
      }),
    )
  })

  // 上游正常 end 但无 terminal：补失败帧，禁止假成功
  if (!streamError && sawResponseCreated && !sawTerminal) {
    terminalFailed = true
    sendText(
      JSON.stringify({
        type: 'error',
        error: {
          message: 'Upstream closed before response completed',
          type: 'api_error',
          code: 'upstream_incomplete',
        },
      }),
    )
  }

  proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, null)

  const success = !streamError && !terminalFailed && Boolean(usagePayload || completedId || sawTerminal)
  if (success && usagePayload && apiKeyData?.id) {
    try {
      const effectiveTier = resolveOpenAIServiceTier(
        usagePayload.service_tier,
        body?.service_tier || state?.serviceTier || null,
      )
      await apiKeyService.recordUsage(
        apiKeyData.id,
        usagePayload,
        actualModel,
        accountId,
        'openai',
        effectiveTier,
        createRequestDetailMeta(reqMeta || {}, {
          stream: true,
          statusCode: 200,
          billingUsage: usagePayload,
          requestBody: { wsBridge: true, model: actualModel, serviceTier: effectiveTier },
        }),
      )
    } catch (error) {
      console.error(error)
      logger.error(`[ResponsesWS-bridge] billing failed: ${error.message}`)
    }
  }

  if (!success) {
    // DEC_20260905_194420 WS bridge 失败也落 request detail（含上游 ID）
    if (apiKeyData?.id) {
      try {
        if (reqMeta && typeof reqMeta === 'object') {
          reqMeta._crsAccountId = accountId || reqMeta._crsAccountId || null
          reqMeta._crsAccountType = accountType || reqMeta._crsAccountType || 'openai'
          if (!reqMeta.apiKey) {
            reqMeta.apiKey = apiKeyData
          }
        }
        const failedPayload = buildFailedRequestDetailPayload({
          req: reqMeta,
          statusCode: Number(upstream?.status) >= 400 ? Number(upstream.status) : 502,
          durationMs: null,
          responseBody: sanitizeUpstreamBodyForDetail(lastFailEvent) || null,
          path: '/openai/v1/responses#ws-bridge',
        })
        failedPayload.apiKeyId = apiKeyData.id
        failedPayload.accountId = accountId || failedPayload.accountId
        failedPayload.accountType = accountType || 'openai'
        failedPayload.model = actualModel || body?.model || failedPayload.model || 'unknown'
        failedPayload.stream = true
        if (state?.cyberPolicyCode) {
          failedPayload.errorCode = state.cyberPolicyCode
        }
        if (state?.cyberPolicyMessage) {
          failedPayload.errorMessage = state.cyberPolicyMessage
        } else if (!failedPayload.errorMessage) {
          const rawMsg = streamError?.message || ''
          const safeMsg =
            typeof rawMsg === 'string' && rawMsg
              ? String(sanitizeUpstreamBodyForDetail(rawMsg) || '').slice(0, 500)
              : ''
          failedPayload.errorMessage =
            safeMsg ||
            (terminalFailed && lastFailEvent ? 'upstream_response_failed' : null) ||
            (terminalFailed ? 'upstream_incomplete' : 'stream_failed')
        }
        await requestDetailService.captureRequestDetail(failedPayload)
      } catch (error) {
        console.error(error)
        logger.error(`[ResponsesWS-bridge] failed detail capture: ${error.message}`)
      }
    }
    return {
      ok: false,
      incomplete: Boolean(sawResponseCreated && !sawTerminal),
      usagePayload,
      actualModel,
      responseId: completedId,
      error: streamError?.message || (terminalFailed ? 'upstream_incomplete' : 'stream_failed'),
    }
  }

  return { ok: true, usagePayload, actualModel, responseId: completedId }
}

/**
 * 入口：把 upgrade 收成 http_bridge 会话
 * 账户在首条 response.create（已知 model）时再选号，避免握手 null 模型选错号
 */
export const handleResponsesWebSocketHttpBridge = async (
  req,
  socket,
  head,
  { apiKeyData, releaseAuth = async () => {}, preselectedAccount = null, preselectedAccountId = null } = {},
) => {
  const sessionId = req.headers['session-id'] || req.headers['session_id'] || req.headers['x-session-id'] || null
  const sessionHash = sessionId ? crypto.createHash('sha256').update(String(sessionId)).digest('hex') : null

  // 连接级 abort：客户端断开则中止进行中的上游 SSE
  const connectionAbort = new AbortController()
  let accessToken = null
  let accountId = preselectedAccountId || null
  let account = preselectedAccount || null
  let accountType = 'openai'
  let accountReady = Boolean(account && accountId)

  const ensureAccount = async (requestedModel = null) => {
    if (accountReady && !requestedModel) {
      return
    }
    // 有 model 时按白名单重选；首次无 model 可用预选
    const selected = await unifiedOpenAIScheduler.selectAccountForApiKey(
      apiKeyData,
      sessionHash,
      requestedModel || null,
    )
    ;({ accountId } = selected)
    accountType = selected.accountType || 'openai'
    if (accountType !== 'openai') {
      throw new Error('http_bridge requires OpenAI OAuth account')
    }
    account = await openaiAccountService.getAccount(accountId)
    if (!account) {
      throw new Error('OpenAI account not found')
    }
    if (openaiAccountService.isTokenExpired(account) && account.refreshToken) {
      await openaiAccountService.refreshAccountToken(accountId)
      account = await openaiAccountService.getAccount(accountId)
    }
    accessToken = selected.accessToken || openaiAccountService.decrypt(account.accessToken)
    if (!accessToken) {
      throw new Error('missing accessToken')
    }
    accountReady = true
  }

  // 预选账户（app 层为读 mode 已选过）可先填 token
  if (account && accountId) {
    try {
      if (openaiAccountService.isTokenExpired(account) && account.refreshToken) {
        await openaiAccountService.refreshAccountToken(accountId)
        account = await openaiAccountService.getAccount(accountId)
      }
      accessToken = openaiAccountService.decrypt(account.accessToken)
      accountReady = Boolean(accessToken)
    } catch (error) {
      console.error(error)
      accountReady = false
    }
  }

  const state = createBridgeSessionState()
  // 串行队列：同一连接上 response.create/append 必须排队，避免竞争 lastResponseId
  let queue = Promise.resolve()
  let currentUpstreamAbort = null

  const endpoint = acceptWebSocketEndpoint(req, socket, head, {
    label: 'responses-http-bridge',
    onTextMessage: (text) => {
      queue = queue
        .then(async () => {
          let message
          try {
            message = JSON.parse(text)
          } catch {
            endpoint.sendText(
              JSON.stringify({
                type: 'error',
                error: { message: 'invalid json', type: 'invalid_request_error' },
              }),
            )
            return
          }

          try {
            // DEC_20260905_194420 同连接已命中 cyber policy 时，后续 turn 直接拒绝，避免反复打上游
            if (state.cyberPolicyBlocked) {
              endpoint.sendText(
                JSON.stringify({
                  type: 'error',
                  error: {
                    message: state.cyberPolicyMessage || 'Session blocked by cyber policy; start a new session',
                    type: 'permission_error',
                    code: state.cyberPolicyCode || 'session_blocked_by_cyber_policy',
                  },
                }),
              )
              return
            }

            // 选号传原始 modelHint；公开别名由调度白名单候选覆盖
            const modelHint = message?.model || message?.response?.model || state.model || null
            await ensureAccount(modelHint)

            const body = buildHttpResponsesBodyFromWsMessage(message, state)
            currentUpstreamAbort = new AbortController()
            const onConnAbort = () => {
              try {
                currentUpstreamAbort.abort()
              } catch (e) {
                console.error(e)
              }
            }
            connectionAbort.signal.addEventListener('abort', onConnAbort, { once: true })
            try {
              await runOneTurn({
                body,
                accessToken,
                account,
                accountId,
                accountType,
                clientHeaders: req.headers,
                sendText: (t) => endpoint.sendText(t),
                apiKeyData,
                reqMeta: req,
                state,
                abortSignal: currentUpstreamAbort.signal,
              })
            } finally {
              connectionAbort.signal.removeEventListener('abort', onConnAbort)
              currentUpstreamAbort = null
            }
          } catch (error) {
            console.error(error)
            if (error.name === 'CanceledError' || error.code === 'ERR_CANCELED' || connectionAbort.signal.aborted) {
              logger.info('[ResponsesWS-bridge] turn aborted (client gone)')
            } else {
              endpoint.sendText(
                JSON.stringify({
                  type: 'error',
                  error: {
                    message: error.message || 'bridge turn failed',
                    type: 'invalid_request_error',
                  },
                }),
              )
            }
          }
        })
        .catch((error) => {
          console.error(error)
        })
    },
    onClose: () => {
      try {
        connectionAbort.abort()
      } catch (e) {
        console.error(e)
      }
      if (currentUpstreamAbort) {
        try {
          currentUpstreamAbort.abort()
        } catch (e) {
          console.error(e)
        }
      }
      releaseAuth().catch((e) => console.error(e))
    },
  })

  if (!endpoint) {
    await releaseAuth()
  } else {
    logger.info(`[ResponsesWS-bridge] http_bridge connected key=${apiKeyData.id} account=${accountId || 'deferred'}`)
  }
}

// 从 WS 文本帧提取 response.create 的 model
const extractModelFromResponsesWsText = (text) => {
  try {
    const message = JSON.parse(text)
    if (!message || typeof message !== 'object') {
      return null
    }
    if (message.type && message.type !== 'response.create') {
      // 非 create 帧也可能顶层带 model
      return message.model || message.response?.model || null
    }
    const source =
      message.response && typeof message.response === 'object' ? { ...message, ...message.response } : message
    return source.model || null
  } catch {
    return null
  }
}

/**
 * 默认 passthrough 且握手无 model 时：先完成客户端 101，等首帧 response.create 带 model 后再选号并连上游 WSS。
 * 避免 null 模型选到不支持账户后无法重选。
 */
export const handleResponsesWebSocketLazyPassthrough = async (
  req,
  socket,
  head,
  {
    apiKeyData,
    releaseAuth = async () => {},
    sessionId = null,
    onUpstreamTextMessage = null,
    onClientTextMessage = null,
    onUpgrade = null,
    onClose = null,
  } = {},
) => {
  const sessionHash = sessionId ? crypto.createHash('sha256').update(String(sessionId)).digest('hex') : null
  let upstreamSocket = null
  let connecting = false
  let closed = false
  const pendingTexts = []
  // 首帧无 model 时的积压上限：按字节而非仅帧数（单帧可近 8MiB，20 帧可打到 ~160MiB）
  const PENDING_MAX_FRAMES = 20
  const PENDING_MAX_BYTES = 1 * 1024 * 1024
  let pendingBytes = 0

  const settleClose = async (err = null) => {
    if (closed) {
      return
    }
    closed = true
    try {
      if (upstreamSocket && !upstreamSocket.destroyed) {
        upstreamSocket.destroy()
      }
    } catch (e) {
      console.error(e)
    }
    try {
      if (typeof onClose === 'function') {
        onClose(err)
      }
    } catch (e) {
      console.error(e)
    }
    try {
      await releaseAuth()
    } catch (e) {
      console.error(e)
    }
  }

  const openUpstream = async (model) => {
    const selected = await unifiedOpenAIScheduler.selectAccountForApiKey(apiKeyData, sessionHash, model)
    if (selected.accountType && selected.accountType !== 'openai') {
      throw new Error('Responses WS requires OpenAI OAuth account')
    }
    let account = await openaiAccountService.getAccount(selected.accountId)
    if (!account) {
      throw new Error('OpenAI account not found')
    }
    if (openaiAccountService.isTokenExpired(account) && account.refreshToken) {
      await openaiAccountService.refreshAccountToken(selected.accountId)
      account = await openaiAccountService.getAccount(selected.accountId)
    }
    const accessToken = selected.accessToken || openaiAccountService.decrypt(account.accessToken)
    if (!accessToken) {
      throw new Error('missing accessToken')
    }

    const isChatGptOAuth = Boolean(account?.accountId || account?.chatgptUserId)
    const targetUrl = responsesWs.resolveResponsesUpstreamWebSocketUrl({
      pathname: (req.url || '').split('?')[0] || '/api/codex/responses',
      search: '',
      isChatGptOAuth,
    })
    const headers = responsesWs.buildResponsesWebsocketUpstreamHeaders({
      accessToken,
      account,
      accountId: selected.accountId,
      clientHeaders: req.headers,
    })
    const proxyResolution = proxyResolver.resolveAgent(account, 'codex')

    const upstreamUrl = new URL(targetUrl)
    if (upstreamUrl.protocol === 'http:') {
      upstreamUrl.protocol = 'ws:'
    }
    if (upstreamUrl.protocol === 'https:') {
      upstreamUrl.protocol = 'wss:'
    }
    const isTls = upstreamUrl.protocol === 'wss:'
    const lib = isTls ? https : http

    const outboundHeaders = {
      host: upstreamUrl.host,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
      ...headers,
    }
    delete outboundHeaders['sec-websocket-extensions']

    const upSocket = await new Promise((resolve, reject) => {
      const requestOptions = {
        protocol: isTls ? 'https:' : 'http:',
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isTls ? 443 : 80),
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        method: 'GET',
        headers: outboundHeaders,
        timeout: 30000,
      }
      if (proxyResolution?.agent) {
        requestOptions.agent = proxyResolution.agent
      }
      const upstreamReq = lib.request(requestOptions)
      upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error('upstream websocket handshake timeout'))
      })
      upstreamReq.on('upgrade', (upRes, sock) => {
        // 101 响应头挂到 req，供 request detail 上游 ID
        if (req && typeof req === 'object' && upRes?.headers) {
          req._crsUpstreamHeaders = upRes.headers
          req._crsUpstreamRequestIdHeader =
            account?.upstreamRequestIdHeader || account?.extra?.upstreamRequestIdHeader || null
        }
        resolve(sock)
      })
      upstreamReq.on('error', reject)
      upstreamReq.on('response', (res) => {
        reject(new Error(`upstream websocket rejected status=${res.statusCode}`))
      })
      upstreamReq.end()
    })

    return {
      upSocket,
      accountId: selected.accountId,
      account,
      accessToken,
      proxyResolution,
    }
  }

  let endpoint = null
  endpoint = acceptWebSocketEndpoint(req, socket, head, {
    label: 'responses-lazy-passthrough',
    onTextMessage: (text) => {
      if (closed) {
        return
      }

      // 已切入 http_bridge：必须优先处理，否则 !upstreamSocket 会再次入队并重选号
      if (endpoint._crsBridgeMode && typeof endpoint._crsBridgeProcess === 'function') {
        endpoint._crsBridgeQueue = (endpoint._crsBridgeQueue || Promise.resolve())
          .then(() => endpoint._crsBridgeProcess(text))
          .catch((error) => {
            console.error(error)
            if (!closed) {
              endpoint.sendText(
                JSON.stringify({
                  type: 'error',
                  error: {
                    message: error.message || 'bridge turn failed',
                    type: 'api_error',
                  },
                }),
              )
            }
          })
        return
      }

      // 已连上游 WSS：转发
      if (upstreamSocket && !upstreamSocket.destroyed) {
        try {
          if (typeof onClientTextMessage === 'function') {
            try {
              onClientTextMessage(text)
            } catch (e) {
              console.error(e)
            }
          }
          upstreamSocket.write(encodeWsClientText(rewriteClientWsTextForUpstream(text)))
        } catch (error) {
          console.error(error)
          settleClose(error)
        }
        return
      }

      // 上游未就绪：入队；首次解析到 model 后选号并分流 passthrough / http_bridge
      const frameBytes = Buffer.byteLength(typeof text === 'string' ? text : String(text ?? ''), 'utf8')
      if (pendingTexts.length >= PENDING_MAX_FRAMES || pendingBytes + frameBytes > PENDING_MAX_BYTES) {
        endpoint.sendText(
          JSON.stringify({
            type: 'error',
            error: {
              message: 'pending websocket frames exceeded limit before model arrived',
              type: 'invalid_request_error',
            },
          }),
        )
        endpoint.close(1009, 'pending overflow')
        settleClose(new Error('pending overflow'))
        return
      }
      pendingTexts.push(text)
      pendingBytes += frameBytes
      if (connecting) {
        return
      }
      const model = pendingTexts.map(extractModelFromResponsesWsText).find(Boolean)
      if (!model) {
        return
      }
      // 选号传原始 model；白名单候选含公开别名，避免破坏账户映射键
      connecting = true
      ;(async () => {
        const selected = await unifiedOpenAIScheduler.selectAccountForApiKey(apiKeyData, sessionHash, model)
        if (selected.accountType && selected.accountType !== 'openai') {
          throw new Error('Responses WS requires OpenAI OAuth account')
        }
        let account = await openaiAccountService.getAccount(selected.accountId)
        if (!account) {
          throw new Error('OpenAI account not found')
        }
        if (openaiAccountService.isTokenExpired(account) && account.refreshToken) {
          await openaiAccountService.refreshAccountToken(selected.accountId)
          account = await openaiAccountService.getAccount(selected.accountId)
        }
        const accessToken = selected.accessToken || openaiAccountService.decrypt(account.accessToken)
        if (!accessToken) {
          throw new Error('missing accessToken')
        }

        const mode = resolveResponsesWsMode({ account })
        if (mode === 'http_bridge') {
          logger.info(
            `[ResponsesWS] lazy→http_bridge key=${apiKeyData.id} account=${selected.accountId} model=${model}`,
          )
          try {
            if (typeof onUpgrade === 'function') {
              // selfBilled：runOneTurn 内已按 turn 记 usage，禁止 app 外层再兜底 request_count
              onUpgrade({ accountId: selected.accountId, model, selfBilled: true })
            }
          } catch (e) {
            console.error(e)
          }
          const state = createBridgeSessionState()
          if (model) {
            state.model = model
          }
          const connectionAbort = new AbortController()
          let bridgeBusy = Promise.resolve()
          const processText = (frameText) => {
            bridgeBusy = bridgeBusy
              .then(async () => {
                if (closed || connectionAbort.signal.aborted) {
                  return
                }
                if (state.cyberPolicyBlocked) {
                  endpoint.sendText(
                    JSON.stringify({
                      type: 'error',
                      error: {
                        message: state.cyberPolicyMessage || 'Session blocked by cyber policy; start a new session',
                        type: 'permission_error',
                        code: state.cyberPolicyCode || 'session_blocked_by_cyber_policy',
                      },
                    }),
                  )
                  return
                }
                const message = JSON.parse(frameText)
                const body = buildHttpResponsesBodyFromWsMessage(message, state)
                const turnAbort = new AbortController()
                const onAbort = () => {
                  try {
                    turnAbort.abort()
                  } catch (e) {
                    console.error(e)
                  }
                }
                connectionAbort.signal.addEventListener('abort', onAbort, { once: true })
                try {
                  await runOneTurn({
                    body,
                    accessToken,
                    account,
                    accountId: selected.accountId,
                    accountType: 'openai',
                    clientHeaders: req.headers,
                    sendText: (t) => endpoint.sendText(t),
                    apiKeyData,
                    reqMeta: req,
                    state,
                    abortSignal: turnAbort.signal,
                  })
                } finally {
                  connectionAbort.signal.removeEventListener('abort', onAbort)
                }
              })
              .catch((error) => {
                console.error(error)
                if (!closed) {
                  endpoint.sendText(
                    JSON.stringify({
                      type: 'error',
                      error: {
                        message: error.message || 'bridge turn failed',
                        type: 'api_error',
                      },
                    }),
                  )
                }
              })
            return bridgeBusy
          }
          // 先置 bridge 标志，再冲刷队列，避免冲刷期间新帧误入 connecting 路径
          endpoint._crsBridgeMode = true
          endpoint._crsBridgeProcess = processText
          endpoint._crsBridgeAbort = connectionAbort
          endpoint._crsBridgeQueue = Promise.resolve()
          connecting = false
          const queued = pendingTexts.splice(0, pendingTexts.length)
          pendingBytes = 0
          for (const pending of queued) {
            await processText(pending)
          }
          return
        }

        // passthrough：连上游 WSS
        const opened = await openUpstream(model)
        if (closed) {
          try {
            opened.upSocket.destroy()
          } catch (e) {
            console.error(e)
          }
          return
        }
        upstreamSocket = opened.upSocket
        connecting = false
        logger.info(
          `[ResponsesWS] lazy passthrough connected key=${apiKeyData.id} account=${opened.accountId} model=${model}`,
        )
        try {
          if (typeof onUpgrade === 'function') {
            onUpgrade({ accountId: opened.accountId, model })
          }
        } catch (e) {
          console.error(e)
        }

        const upSniffer = createWsFrameSniffer({
          label: 'lazy-up-decode',
          onTextMessage: (upText) => {
            // 跟踪 turn 终端事件：response.created 后无 terminal 就关 = 半截失败
            try {
              const parsed = JSON.parse(upText)
              const eventType = parsed && parsed.type
              if (eventType === 'response.created') {
                endpoint._crsTurnStarted = true
                endpoint._crsTurnTerminal = false
              } else if (
                eventType === 'response.completed' ||
                eventType === 'response.failed' ||
                eventType === 'response.done' ||
                eventType === 'error'
              ) {
                endpoint._crsTurnTerminal = true
              }
            } catch {
              // 非 JSON 忽略
            }

            let clientText = upText
            try {
              const sanitized = sanitizeOpenAICapacityShedForClient(upText)
              if (sanitized.changed) {
                clientText = sanitized.payload
              }
            } catch (e) {
              console.error(e)
            }

            if (typeof onUpstreamTextMessage === 'function') {
              try {
                onUpstreamTextMessage(upText)
              } catch (e) {
                console.error(e)
              }
            }
            endpoint.sendText(clientText)
          },
          onPing: (payload) => {
            // 本服务作为上游 WS 客户端，必须回 masked Pong，否则上游心跳超时断连
            try {
              if (upstreamSocket && !upstreamSocket.destroyed) {
                upstreamSocket.write(encodeWsClientPong(payload || Buffer.alloc(0)))
              }
            } catch (error) {
              console.error(error)
            }
          },
        })

        upstreamSocket.on('data', (chunk) => {
          upSniffer.push(chunk)
        })
        upstreamSocket.on('error', (err) => {
          console.error(err)
          // 先发终端 error frame 再 settleClose，避免 closed 抢先导致无说明断连
          // DEC_20260905_155232
          try {
            if (endpoint._crsTurnStarted && !endpoint._crsTurnTerminal && !closed) {
              endpoint.sendText(
                JSON.stringify({
                  type: 'error',
                  error: {
                    message: 'Upstream socket error',
                    type: 'api_error',
                    code: 'upstream_error',
                  },
                }),
              )
              endpoint._crsTurnTerminal = true
            }
          } catch (e) {
            console.error(e)
          }
          try {
            endpoint.close(1011, 'upstream error')
          } catch (e) {
            console.error(e)
          }
          settleClose(err)
        })
        upstreamSocket.on('close', () => {
          // active turn 无 terminal：对客户端报失败，禁止假成功 1000
          // DEC_20260904_170000 对齐 sub2api close-before-terminal
          try {
            if (endpoint._crsTurnStarted && !endpoint._crsTurnTerminal && !closed) {
              endpoint.sendText(
                JSON.stringify({
                  type: 'error',
                  error: {
                    message: 'Upstream closed before response completed',
                    type: 'api_error',
                    code: 'upstream_incomplete',
                  },
                }),
              )
              endpoint.close(1011, 'upstream incomplete')
            } else {
              endpoint.close(1000, 'upstream closed')
            }
          } catch (e) {
            console.error(e)
          }
          settleClose()
        })

        const queued = pendingTexts.splice(0, pendingTexts.length)
        pendingBytes = 0
        for (const pending of queued) {
          try {
            if (typeof onClientTextMessage === 'function') {
              try {
                onClientTextMessage(pending)
              } catch (e) {
                console.error(e)
              }
            }
            upstreamSocket.write(encodeWsClientText(rewriteClientWsTextForUpstream(pending)))
          } catch (e) {
            console.error(e)
          }
        }
      })().catch((error) => {
        console.error(error)
        connecting = false
        endpoint.sendText(
          JSON.stringify({
            type: 'error',
            error: { message: error.message || 'failed to select upstream', type: 'api_error' },
          }),
        )
        endpoint.close(1011, 'select failed')
        settleClose(error)
      })
    },
    onClose: () => {
      try {
        if (endpoint?._crsBridgeAbort) {
          endpoint._crsBridgeAbort.abort()
        }
      } catch (e) {
        console.error(e)
      }
      settleClose()
    },
  })

  if (!endpoint) {
    await releaseAuth()
  } else {
    logger.info(`[ResponsesWS] lazy entry waiting first frame model key=${apiKeyData.id}`)
  }
}

// 模式：auto | passthrough | http_bridge
export const resolveResponsesWsMode = ({ account, forcedMode } = {}) => {
  if (forcedMode === 'passthrough' || forcedMode === 'http_bridge') {
    return forcedMode
  }
  // 账户可配置 responsesWsMode / extra.responsesWsMode（extra 可能是 JSON 字符串）
  let extra = account?.extra
  if (typeof extra === 'string') {
    try {
      extra = JSON.parse(extra)
    } catch {
      extra = null
    }
  }
  const fromAccount =
    account?.responsesWsMode ||
    (extra && typeof extra === 'object' ? extra.responsesWsMode : null) ||
    (extra && typeof extra === 'object' ? extra.openai_oauth_responses_websockets_v2_mode : null)
  if (fromAccount === 'http_bridge' || fromAccount === 'passthrough') {
    return fromAccount
  }
  // 默认 auto：OAuth 先透传；可由 env.CODEX_RESPONSES_WS_MODE 改默认
  const envMode = env.CODEX_RESPONSES_WS_MODE
  if (envMode === 'http_bridge' || envMode === 'passthrough' || envMode === 'auto') {
    return envMode === 'auto' ? 'passthrough' : envMode
  }
  return 'passthrough'
}
