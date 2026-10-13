import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'

export const connectWebSocketUpstream = ({ targetUrl, headers, agent = null, signal = null }) => {
  const url = new URL(targetUrl)
  const tls = url.protocol === 'https:' || url.protocol === 'wss:'
  const requestOptions = {
    protocol: tls ? 'https:' : 'http:',
    hostname: url.hostname,
    port: url.port || (tls ? 443 : 80),
    path: url.pathname + url.search,
    method: 'GET',
    agent,
    timeout: 30000,
    signal: signal ?? undefined,
    headers: {
      ...headers,
      host: url.host,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': crypto.randomBytes(16).toString('base64')
    }
  }
  delete requestOptions.headers['sec-websocket-extensions']
  return new Promise((resolve, reject) => {
    const request = (tls ? https : http).request(requestOptions)
    request.on('timeout', () => request.destroy(new Error('Upstream WebSocket handshake timeout')))
    request.on('error', reject)
    request.on('response', (response) => {
      response.resume()
      reject(
        Object.assign(new Error('Upstream refused WebSocket upgrade'), {
          statusCode: response.statusCode,
          upstream: true
        })
      )
    })
    request.on('upgrade', (response, socket, head) => {
      const expected = crypto
        .createHash('sha1')
        .update(
          `${requestOptions.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`
        )
        .digest('base64')
      if (
        response.headers['sec-websocket-accept'] !== expected ||
        response.headers['sec-websocket-extensions']
      ) {
        socket.destroy()
        reject(new Error('Invalid upstream WebSocket handshake'))
        return
      }
      resolve({ socket, headers: response.headers, head })
    })
    request.end()
  })
}
