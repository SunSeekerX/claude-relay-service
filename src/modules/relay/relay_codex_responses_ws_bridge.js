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
import { createRequestDetailMeta } from './relay_request_detail_helper.js'
import * as responsesWs from './relay_codex_responses_ws.js'
import { repairResponsesToolCallsInBody } from './relay_codex_responses_ws_tool_repair.js'

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
})

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
  return {
    input_tokens: actualInput,
    output_tokens: usage.output_tokens || usage.completion_tokens || 0,
    cache_read_input_tokens: Number(cacheRead) || 0,
    cache_creation_input_tokens: Number(cacheCreate) || 0,
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
    state.model = model

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

    const inputDelta = Array.isArray(source.input) ? source.input : []
    const previousId = source.previous_response_id || null

    const body = {
      model: getCodexCompatibleModel(model) || model,
      stream: true,
      store: false,
    }

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

    return repairResponsesToolCallsInBody(body)
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
    return repairResponsesToolCallsInBody(body)
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
    proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, new Error(`status ${upstream.status}`))
    sendText(JSON.stringify({ type: 'error', error: errBody.error || errBody, status: upstream.status }))
    return { ok: false, status: upstream.status }
  }

  const parser = new IncrementalSSEParser()
  let usagePayload = null
  let actualModel = body.model
  let completedId = null

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

          // 回写客户端：WS 文本帧 = 事件 JSON（官方 WS 语义）
          sendText(JSON.stringify(eventData))

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
      reject(error)
    })
  }).catch((error) => {
    sendText(
      JSON.stringify({
        type: 'error',
        error: { message: error.message || 'stream error', type: 'api_error' },
      }),
    )
  })

  proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, null)

  if (usagePayload && apiKeyData?.id) {
    try {
      await apiKeyService.recordUsage(
        apiKeyData.id,
        usagePayload,
        actualModel,
        accountId,
        'openai',
        null,
        createRequestDetailMeta(reqMeta || {}, {
          stream: true,
          statusCode: 200,
          billingUsage: usagePayload,
          requestBody: { wsBridge: true, model: actualModel },
        }),
      )
    } catch (error) {
      console.error(error)
      logger.error(`[ResponsesWS-bridge] billing failed: ${error.message}`)
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
            // 先解析 body 拿到 model，再按 model 选号（白名单分组）
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
          upstreamSocket.write(encodeWsClientText(text))
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
            if (typeof onUpstreamTextMessage === 'function') {
              try {
                onUpstreamTextMessage(upText)
              } catch (e) {
                console.error(e)
              }
            }
            endpoint.sendText(upText)
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
          settleClose(err)
          try {
            endpoint.close(1011, 'upstream error')
          } catch (e) {
            console.error(e)
          }
        })
        upstreamSocket.on('close', () => {
          settleClose()
          try {
            endpoint.close(1000, 'upstream closed')
          } catch (e) {
            console.error(e)
          }
        })

        const queued = pendingTexts.splice(0, pendingTexts.length)
        pendingBytes = 0
        for (const pending of queued) {
          try {
            upstreamSocket.write(encodeWsClientText(pending))
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
