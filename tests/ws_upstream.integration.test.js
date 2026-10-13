import crypto from 'node:crypto'
import http from 'node:http'
import { connectWebSocketUpstream } from '../src/common/gateway_ws_upstream.js'
import { encodeWsFrame } from '../src/common/gateway_ws_endpoint.js'
import { createWsFrameSniffer } from '../src/common/gateway_ws_frame_sniffer.js'

let server
let sockets
const listen = async (handler) => {
  sockets = new Set()
  server = http.createServer()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}/v1/responses?fixture=1`
}
afterEach(async () => {
  sockets?.forEach((socket) => socket.destroy())
  if (server) {
    await new Promise((resolve) => server.close(resolve))
  }
})

describe('native WebSocket upstream wire', () => {
  it('keeps the official path and first upgrade packet and strips compression negotiation', async () => {
    let received
    const targetUrl = await listen((req, socket) => {
      received = req
      const accept = crypto
        .createHash('sha1')
        .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write(
        Buffer.concat([
          Buffer.from(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
          ),
          encodeWsFrame(0x1, '{"type":"response.created","response":{"id":"first"}}')
        ])
      )
    })
    const connection = await connectWebSocketUpstream({
      targetUrl,
      headers: { authorization: 'Bearer fixture', 'sec-websocket-extensions': 'permessage-deflate' }
    })
    expect(received.url).toBe('/v1/responses?fixture=1')
    expect(received.headers['sec-websocket-extensions']).toBeUndefined()
    expect(received.headers.authorization).toBe('Bearer fixture')
    const messages = []
    createWsFrameSniffer({ onTextMessage: (text) => messages.push(JSON.parse(text)) }).push(
      connection.head
    )
    expect(messages[0].response.id).toBe('first')
    connection.socket.destroy()
  })

  it('rejects a malformed upstream handshake', async () => {
    const targetUrl = await listen((_req, socket) =>
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n'
      )
    )
    await expect(connectWebSocketUpstream({ targetUrl, headers: {} })).rejects.toThrow(
      'Invalid upstream WebSocket handshake'
    )
  })

  it('cancels an unfinished handshake when the client disconnects', async () => {
    let sawUpgrade
    const started = new Promise((resolve) => {
      sawUpgrade = resolve
    })
    const targetUrl = await listen(() => sawUpgrade())
    const controller = new AbortController()
    const connection = connectWebSocketUpstream({
      targetUrl,
      headers: {},
      signal: controller.signal
    })
    await started
    controller.abort()
    await expect(connection).rejects.toMatchObject({ name: 'AbortError' })
  })
})
