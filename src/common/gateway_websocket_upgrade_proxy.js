import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import { logger } from './logger.js'
import { createWsFrameSniffer, createWsClientTextRewriter } from './gateway_ws_frame_sniffer.js'
// 原生 HTTP Upgrade 隧道：把客户端 WebSocket 接到上游 wss/ws
// 不引入 ws 包；鉴权与上游头由调用方构造
// 支持：账户代理 agent、握手超时主动关闭、上游文本帧嗅探（计费）

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('stream').Duplex} socket
 * @param {Buffer} head
 * @param {object} opts
 * @param {string} opts.targetUrl
 * @param {Record<string,string|string[]|undefined>} [opts.headers]
 * @param {import('http').Agent|null} [opts.agent]
 * @param {number} [opts.handshakeTimeoutMs]
 * @param {(text: string) => void} [opts.onUpstreamTextMessage]
 * @param {(err?: Error|null) => void} [opts.onClose]
 * @param {(upRes: import('http').IncomingMessage) => void} [opts.onUpgrade]
 */
export const proxyWebSocketUpgrade = (
  req,
  socket,
  head,
  {
    targetUrl,
    headers = {},
    agent = null,
    handshakeTimeoutMs = 30000,
    // true：不向下游协商 permessage-deflate 等扩展（压缩帧会导致明文嗅探失败）
    stripExtensions = true,
    onUpstreamTextMessage = null,
    onClientToUpstreamText = null,
    onClose = null,
    onUpgrade = null,
  } = {},
) => {
  let settled = false
  const settle = (err = null) => {
    if (settled) {
      return
    }
    settled = true
    if (typeof onClose === 'function') {
      try {
        onClose(err || null)
      } catch (callbackError) {
        console.error(callbackError)
      }
    }
  }

  const failClient = (statusCode, message) => {
    try {
      const body = message || ''
      socket.write(
        `HTTP/1.1 ${statusCode} Error\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
    } catch (_) {
      /* ignore */
    }
    try {
      socket.destroy()
    } catch (_) {
      /* ignore */
    }
    settle(new Error(message || `upgrade failed ${statusCode}`))
  }

  if (!targetUrl) {
    failClient(500, 'Internal Server Error')
    return
  }

  let upstreamUrl
  try {
    upstreamUrl = new URL(targetUrl)
  } catch (error) {
    console.error(error)
    failClient(500, 'Internal Server Error')
    return
  }

  if (upstreamUrl.protocol === 'http:') {
    upstreamUrl.protocol = 'ws:'
  } else if (upstreamUrl.protocol === 'https:') {
    upstreamUrl.protocol = 'wss:'
  }

  const isTls = upstreamUrl.protocol === 'wss:'
  const lib = isTls ? https : http
  const port = upstreamUrl.port || (isTls ? 443 : 80)

  const outboundHeaders = {
    host: upstreamUrl.host,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': req.headers['sec-websocket-version'] || '13',
    'sec-websocket-key': req.headers['sec-websocket-key'],
    'sec-websocket-protocol': req.headers['sec-websocket-protocol'],
    ...headers,
  }
  // 默认剥离 extensions，避免上游启用 permessage-deflate 后 RSV1 压缩帧无法嗅探 usage
  if (!stripExtensions && req.headers['sec-websocket-extensions']) {
    outboundHeaders['sec-websocket-extensions'] = req.headers['sec-websocket-extensions']
  } else {
    delete outboundHeaders['sec-websocket-extensions']
  }

  for (const [k, v] of Object.entries(outboundHeaders)) {
    if (v === undefined || v === null || v === '') {
      delete outboundHeaders[k]
    }
  }

  const requestOptions = {
    protocol: isTls ? 'https:' : 'http:',
    hostname: upstreamUrl.hostname,
    port,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    method: 'GET',
    headers: outboundHeaders,
    timeout: handshakeTimeoutMs,
  }
  if (agent) {
    requestOptions.agent = agent
  }

  const upstreamReq = lib.request(requestOptions)

  // 握手超时：必须主动 destroy，否则客户端/并发槽长期挂起
  upstreamReq.on('timeout', () => {
    logger.warn(`[WsProxy] upstream handshake timeout ${handshakeTimeoutMs}ms url=${targetUrl}`)
    try {
      upstreamReq.destroy(new Error('upstream websocket handshake timeout'))
    } catch (_) {
      /* ignore */
    }
    if (!settled) {
      failClient(504, 'Upstream WebSocket handshake timeout')
    }
  })

  upstreamReq.on('upgrade', (upRes, upSocket, upHead) => {
    try {
      if (typeof onUpgrade === 'function') {
        onUpgrade(upRes)
      }
    } catch (error) {
      console.error(error)
    }

    const proto = upRes.headers['sec-websocket-protocol']
    const accept = upRes.headers['sec-websocket-accept']
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade']
    if (accept) {
      lines.push(`Sec-WebSocket-Accept: ${accept}`)
    }
    if (proto) {
      lines.push(`Sec-WebSocket-Protocol: ${proto}`)
    }

    try {
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    } catch (error) {
      console.error(error)
      try {
        upSocket.destroy()
      } catch (_) {
        /* ignore */
      }
      settle(error)
      return
    }

    if (upHead && upHead.length) {
      socket.write(upHead)
    }

    // 上游→客户端：原样转发 + 文本帧嗅探（计费）
    const sniffer =
      typeof onUpstreamTextMessage === 'function'
        ? createWsFrameSniffer({
            onTextMessage: onUpstreamTextMessage,
            label: 'upstream',
          })
        : null

    // 若 upgrade 响应带了首包，也要嗅探
    if (sniffer && upHead && upHead.length) {
      sniffer.push(upHead)
    }

    upSocket.on('data', (chunk) => {
      if (sniffer) {
        sniffer.push(chunk)
      }
      if (!socket.destroyed) {
        const ok = socket.write(chunk)
        if (!ok) {
          upSocket.pause()
        }
      }
    })
    socket.on('drain', () => {
      if (!upSocket.destroyed) {
        upSocket.resume()
      }
    })

    // 客户端→上游：可选文本帧改写（stripExtensions 时明文可读）
    // head 必须先进改写器，禁止直接 write 导致半帧边界错乱 / 完整帧绕过
    // DEC_20260906_011816
    const clientRewriter =
      typeof onClientToUpstreamText === 'function'
        ? createWsClientTextRewriter({
            label: 'client-to-upstream',
            rewriteText: onClientToUpstreamText,
          })
        : null

    const writeClientChunkToUpstream = (chunk) => {
      if (!chunk || !chunk.length || upSocket.destroyed) {
        return
      }
      if (!clientRewriter) {
        const ok = upSocket.write(chunk)
        if (!ok) {
          socket.pause()
        }
        return
      }
      const frames = clientRewriter.push(chunk) || []
      for (const frame of frames) {
        if (!frame || !frame.length || upSocket.destroyed) {
          continue
        }
        const ok = upSocket.write(frame)
        if (!ok) {
          socket.pause()
        }
      }
    }

    if (head && head.length) {
      writeClientChunkToUpstream(head)
    }

    socket.on('data', (chunk) => {
      writeClientChunkToUpstream(chunk)
    })
    upSocket.on('drain', () => {
      if (!socket.destroyed) {
        socket.resume()
      }
    })

    const closeBoth = (err = null) => {
      try {
        upSocket.destroy()
      } catch (_) {
        /* ignore */
      }
      try {
        socket.destroy()
      } catch (_) {
        /* ignore */
      }
      settle(err)
    }

    upSocket.on('error', (err) => {
      logger.warn(`[WsProxy] upstream socket error: ${err.message}`)
      closeBoth(err)
    })
    socket.on('error', (err) => {
      logger.warn(`[WsProxy] client socket error: ${err.message}`)
      closeBoth(err)
    })
    upSocket.on('close', () => closeBoth(null))
    socket.on('close', () => closeBoth(null))
  })

  upstreamReq.on('response', (upRes) => {
    logger.warn(`[WsProxy] upstream refused upgrade status=${upRes.statusCode}`)
    const bodyChunks = []
    upRes.on('data', (c) => bodyChunks.push(c))
    upRes.on('end', () => {
      const body = Buffer.concat(bodyChunks)
      try {
        socket.write(
          `HTTP/1.1 ${upRes.statusCode || 502} ${upRes.statusMessage || 'Error'}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n`,
        )
        socket.write(body)
      } catch (_) {
        /* ignore */
      }
      try {
        socket.destroy()
      } catch (_) {
        /* ignore */
      }
      settle(new Error(`upstream refused upgrade status=${upRes.statusCode}`))
    })
  })

  upstreamReq.on('error', (error) => {
    console.error(error)
    logger.error(`[WsProxy] upstream request error: ${error.message}`)
    if (!settled) {
      failClient(502, 'Bad Gateway')
    }
  })

  // 客户端在握手阶段断开
  socket.on('close', () => {
    if (!settled) {
      try {
        upstreamReq.destroy()
      } catch (_) {
        /* ignore */
      }
      settle(null)
    }
  })
  socket.on('error', () => {
    if (!settled) {
      try {
        upstreamReq.destroy()
      } catch (_) {
        /* ignore */
      }
    }
  })

  upstreamReq.end()
}
