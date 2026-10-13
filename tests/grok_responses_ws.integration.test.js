import { jest } from '@jest/globals'
import crypto from 'node:crypto'
import http from 'node:http'
import { connectWebSocketUpstream } from '../src/common/gateway_ws_upstream.js'
import { encodeWsClientText, encodeWsFrame } from '../src/common/gateway_ws_endpoint.js'
import { createWsFrameSniffer } from '../src/common/gateway_ws_frame_sniffer.js'

const key = { id: 'key', permissions: ['grok'] }
const authRelease = jest.fn().mockResolvedValue()
const validateWsApiKey = jest.fn().mockResolvedValue({ ok: true, keyData: key })
const leases = []
let slots = 0
const acquireWsTurnConcurrency = jest.fn(async (_key, options) => {
  const counted = options.acquireConcurrency !== false
  if (counted) {
    slots += 1
  }
  const release = jest.fn(async () => {
    if (counted) {
      slots -= 1
    }
  })
  leases.push(release)
  return { ok: true, release }
})
const recordUsage = jest.fn().mockResolvedValue({ realCost: 0, ratedCost: 1 })
let baseUrl
const mocks = {
  '../config/config.js': { config: { xai: { allowUnsafeUrlOverrides: true } } },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/infra/redis.js': { redis: {} },
  '../src/common/gateway_ws_api_key_auth.js': {
    authenticateApiKeyForUpgrade: jest
      .fn()
      .mockResolvedValue({ ok: true, keyData: key, release: authRelease }),
    validateWsApiKey,
    acquireWsTurnConcurrency
  },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: { recordUsage } },
  '../src/modules/account/account_openai_service.js': {},
  '../src/modules/account/account_grok_service.js': {
    grokAccountService: {
      ensureFreshToken: jest
        .fn()
        .mockResolvedValue({ id: 'account', authType: 'apikey', apiKey: 'fixture' }),
      getUpstreamBaseUrl: () => baseUrl
    }
  },
  '../src/modules/relay/relay_grok_scheduler.js': {
    grokScheduler: {
      selectAccount: jest.fn().mockResolvedValue({ id: 'account' }),
      assertAccountForWebSocket: jest.fn().mockResolvedValue('grok-test')
    }
  },
  '../src/modules/relay/relay_request_detail_service.js': {
    requestDetailService: { captureUnmeteredRequest: jest.fn().mockResolvedValue() }
  },
  '../src/modules/proxy/proxy_resolver.js': {
    proxyResolver: { resolveAgent: () => ({ agent: null }), report: jest.fn() }
  }
}
for (const [name, exports] of Object.entries(mocks)) {
  jest.unstable_mockModule(name, () => exports)
}
const { handleGrokResponsesWebSocket } =
  await import('../src/modules/relay/relay_grok_responses_ws.js')

const servers = []
const sockets = new Set()
const listen = async (handler) => {
  const server = http.createServer()
  servers.push(server)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}
const waitFor = async (condition) => {
  const deadline = Date.now() + 1500
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('fixture event timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
afterAll(async () => {
  sockets.forEach((socket) => socket.destroy())
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
})

it('relays native Grok rounds, settles before disconnect and gates the next request using the latest budget', async () => {
  const upstreamRequests = []
  const observed = []
  baseUrl = await listen((req, socket) => {
    expect(req.url).toBe('/v1/responses')
    expect(req.headers.authorization).toBe('Bearer fixture')
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    const sniffer = createWsFrameSniffer({
      onTextMessage: (text) => {
        const message = JSON.parse(text)
        upstreamRequests.push(message)
        expect(message.model).toBe('grok-test')
        const id = `turn-${upstreamRequests.length}`
        socket.write(
          encodeWsFrame(1, JSON.stringify({ type: 'response.created', response: { id } }))
        )
        socket.write(
          encodeWsFrame(
            1,
            JSON.stringify({
              type: 'response.completed',
              response: {
                id,
                model: message.model,
                usage: {
                  input_tokens: 1,
                  output_tokens: message.generate === false ? 0 : 1,
                  cost_in_usd_ticks: '0',
                  server_side_tool_usage_details: {
                    web_search_calls: message.generate === false ? 0 : 1
                  }
                }
              }
            })
          )
        )
      }
    })
    socket.on('data', sniffer.push)
  })
  const relay = await listen((req, socket, head) => {
    handleGrokResponsesWebSocket(req, socket, head).catch((error) => socket.destroy(error))
  })
  const client = await connectWebSocketUpstream({
    targetUrl: `${relay}/grok/v1/responses`,
    headers: { authorization: 'Bearer relay-fixture' }
  })
  const sniffer = createWsFrameSniffer({ onTextMessage: (text) => observed.push(JSON.parse(text)) })
  client.socket.on('data', sniffer.push)
  client.socket.write(
    encodeWsClientText(
      JSON.stringify({ type: 'response.create', model: 'grok-alias', generate: false, input: [] })
    )
  )
  await waitFor(() => observed.some((event) => event.type === 'response.completed'))
  expect(slots).toBe(0)
  expect(recordUsage).not.toHaveBeenCalled()
  client.socket.write(
    encodeWsClientText(JSON.stringify({ type: 'response.create', model: 'grok-alias', input: [] }))
  )
  await waitFor(() => recordUsage.mock.calls.length === 1 && slots === 0)
  expect(recordUsage.mock.calls[0][1]).toMatchObject({
    cost_in_usd_ticks: '0',
    server_side_tool_usage_details: { web_search_calls: 1 }
  })
  expect(recordUsage.mock.calls[0][4]).toBe('grok')
  validateWsApiKey.mockResolvedValueOnce({
    ok: false,
    status: 402,
    code: 'daily_cost_limit_exceeded',
    message: 'limit reached'
  })
  client.socket.write(
    encodeWsClientText(JSON.stringify({ type: 'response.create', model: 'grok-alias', input: [] }))
  )
  await waitFor(() => observed.some((event) => event.type === 'error'))
  expect(observed.find((event) => event.type === 'error')).toMatchObject({
    status: 402,
    error: { code: 'daily_cost_limit_exceeded' }
  })
  expect(upstreamRequests).toHaveLength(2)
  client.socket.destroy()
  await waitFor(() => authRelease.mock.calls.length === 1)
  expect(leases.every((release) => release.mock.calls.length === 1)).toBe(true)
})
