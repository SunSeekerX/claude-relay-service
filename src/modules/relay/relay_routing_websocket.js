import axios from 'axios'
import { isIPv6 } from 'node:net'
import { config } from '../../../config/config.js'
import { logger } from '../../common/logger.js'
import { acceptWebSocketEndpoint } from '../../common/gateway_ws_endpoint.js'
import { extractBearerOrQueryKey, validateWsApiKey } from '../../common/gateway_ws_api_key_auth.js'
import { IncrementalSSEParser } from './relay_sse_parser.js'
import {
  buildHttpResponsesBodyFromWsMessage,
  completeHttpBridgeWarmup,
  createHttpBridgeLanes,
} from './relay_codex_responses_ws_bridge.js'
import { assertModelAccess } from './relay_model_access.js'
import { getResponsesBridgeProvider } from './relay_responses_contract.js'

export const buildNamedWsRequest = (message, state) => {
  const source =
    message.response && typeof message.response === 'object' ? { ...message, ...message.response } : message
  const external = state.allowExternalPreviousResponse && source.previous_response_id && source.previous_response_id !== state.lastResponseId
  const body = external
    ? buildHttpResponsesBodyFromWsMessage({ ...source, previous_response_id: undefined }, { ...state, inputItems: [] })
    : buildHttpResponsesBodyFromWsMessage(message, state)
  if (external) {body.previous_response_id = source.previous_response_id}
  if (state.allowExternalPreviousResponse) {body.store = source.store ?? true}
  body.model = source.model ?? state.model
  for (const field of ['temperature', 'top_p', 'max_output_tokens', 'metadata', 'truncation', 'user']) {
    if (Object.hasOwn(source, field)) {
      body[field] = source[field]
    }
  }
  return body
}

export const relayNamedWsTurn = async ({ req, url, body, state, sendText, signal }) => {
  const auth = await validateWsApiKey(req, url)
  if (!auth.ok) {
    throw Object.assign(new Error(auth.message), { statusCode: auth.status, code: auth.code })
  }
  const route = auth.keyData._relayRoute
  const bridgeProvider = ['claude', 'gemini'].includes(route?.provider) ? route.provider : getResponsesBridgeProvider(url.pathname)
  if (!route && !getResponsesBridgeProvider(url.pathname)) {
    throw Object.assign(new Error('该连接的调用入口已变更，请重新连接'), { statusCode: 409 })
  }
  assertModelAccess(auth.keyData, body.model)
  if (route?.modelMode === 'mapped-only' && !Object.hasOwn(route.modelMapping, body.model)) {
    throw Object.assign(new Error('该入口仅开放模型映射表中的模型'), { statusCode: 400 })
  }
  assertModelAccess(auth.keyData, route?.modelMapping?.[body.model] ?? body.model)
  if (bridgeProvider && body.previous_response_id) {
    const [{ redis }, { responsesContextScope }] = await Promise.all([import('../../infra/redis.js'), import('./relay_responses_gateway.js')])
    const context = await redis.getResponsesContext(responsesContextScope({ apiKey: auth.keyData }, bridgeProvider), body.previous_response_id)
    if (!context) {throw Object.assign(new Error('Previous response is unavailable; resend the full input context'), { statusCode: 400, code: 'previous_response_not_found' })}
    body.input = [...context.input, ...body.input]
    if (body.tools === undefined && context.tools) {body.tools = context.tools}
    delete body.previous_response_id
  }
  if (body.generate === false) {
    for (const event of completeHttpBridgeWarmup(body, state)) {
      sendText(JSON.stringify(event))
    }
    return
  }
  const headers = { 'Content-Type': 'application/json', 'x-api-key': extractBearerOrQueryKey(req, url) }
  for (const name of [
    'user-agent',
    'x-app',
    'session-id',
    'session_id',
    'x-session-id',
    'thread-id',
    'x-codex-turn-state',
    'x-codex-turn-metadata',
  ]) {
    if (req.headers[name] !== undefined) {
      headers[name] = req.headers[name]
    }
  }
  const host = ['0.0.0.0', '::'].includes(config.server.host) ? '127.0.0.1' : config.server.host
  const target = `http://${isIPv6(host) ? `[${host}]` : host}:${config.server.port}${url.pathname}`
  let response
  try {
    response = await axios.post(target, body, {
      headers,
      responseType: 'stream',
      signal,
      proxy: false,
      timeout: config.server.requestTimeout ?? 600000,
      validateStatus: () => true,
    })
  } catch (error) {
    const safeError = Object.assign(new Error('调用入口 HTTP 转发失败'), {
      statusCode: 502,
      code: error.code,
      transportError: { name: error.name, message: error.message, stack: error.stack },
    })
    throw safeError
  }
  if (response.status >= 400) {
    response.data.destroy()
    throw Object.assign(new Error('调用入口请求失败'), { statusCode: response.status })
  }
  const parser = new IncrementalSSEParser()
  let terminal = false
  const consume = (events) => {
    for (const event of events) {
      if (event.type === 'invalid') {
        throw Object.assign(new Error('响应流格式无效'), { statusCode: 502 })
      }
      if (event.type !== 'data') {
        continue
      }
      const { data } = event
      sendText(JSON.stringify(data))
      if (data.type === 'response.completed' || data.type === 'response.done') {
        terminal = true
        state.lastResponseId = data.response?.id ?? null
        state.inputItems = [...body.input, ...(data.response?.output ?? [])]
        state.lastRequestBody = { ...body }
        state.model = body.model
      } else if (['response.failed', 'response.incomplete', 'error'].includes(data.type)) {
        terminal = true
      }
    }
  }
  for await (const chunk of response.data) {
    consume(parser.feed(chunk))
  }
  consume(parser.finish())
  if (!terminal) {
    throw Object.assign(new Error('响应流未正常结束'), { statusCode: 502 })
  }
}

export const handleNamedResponsesWebSocket = async (req, socket, head, { releaseAuth, keyData }) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const connectionAbort = new AbortController()
  const lanes = createHttpBridgeLanes({
    signal: connectionAbort.signal,
    initialModel: url.searchParams.get('model') ?? req.headers['x-model'] ?? null,
    allowExternalPreviousResponse: ['claude', 'gemini'].includes(keyData?._relayRoute?.provider) || Boolean(getResponsesBridgeProvider(url.pathname)),
    buildBody: buildNamedWsRequest,
    sendText: (text) => endpoint.sendText(text),
    run: (body, state, sendText) =>
      relayNamedWsTurn({ req, url, body, state, sendText, signal: connectionAbort.signal }),
  })
  const endpoint = acceptWebSocketEndpoint(req, socket, head, {
    label: 'named-responses',
    onTextMessage: (text) => lanes.processText(text),
    onClose: () => {
      connectionAbort.abort()
      lanes
        .drain()
        .finally(releaseAuth)
        .catch((error) => logger.error('Named Responses WebSocket cleanup failed', error))
    },
  })
  if (!endpoint) {
    await releaseAuth()
  }
}
