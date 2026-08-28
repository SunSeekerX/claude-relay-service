// 本端 WebSocket 端点（不依赖 ws 包）：完成 101 握手 + 帧读写
// 仅服务端→客户端无 mask；客户端→服务端带 mask（RFC6455）
import crypto from 'node:crypto'
import { logger } from './logger.js'

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

const acceptKey = (secWebSocketKey) =>
  crypto.createHash('sha1').update(`${secWebSocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')

export const encodeWsFrame = (opcode, payload, { fin = true } = {}) => {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8')
  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
    header[1] = 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
  }
  return Buffer.concat([header, data])
}

export const encodeWsText = (text) => encodeWsFrame(OP_TEXT, text)

// 作为上游客户端发帧必须 mask（RFC6455）
export const encodeWsClientText = (text) => {
  const data = Buffer.from(String(text ?? ''), 'utf8')
  const maskKey = crypto.randomBytes(4)
  const masked = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < data.length; i += 1) {
    masked[i] = data[i] ^ maskKey[i & 3]
  }
  const len = masked.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(2 + 4)
    header[0] = 0x80 | OP_TEXT
    header[1] = 0x80 | len
    maskKey.copy(header, 2)
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4 + 4)
    header[0] = 0x80 | OP_TEXT
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
    maskKey.copy(header, 4)
  } else {
    header = Buffer.allocUnsafe(10 + 4)
    header[0] = 0x80 | OP_TEXT
    header[1] = 0x80 | 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
    maskKey.copy(header, 10)
  }
  return Buffer.concat([header, masked])
}

export const encodeWsClientPong = (payload = Buffer.alloc(0)) => {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8')
  const maskKey = crypto.randomBytes(4)
  const masked = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < data.length; i += 1) {
    masked[i] = data[i] ^ maskKey[i & 3]
  }
  const header = Buffer.allocUnsafe(2 + 4)
  header[0] = 0x80 | OP_PONG
  header[1] = 0x80 | (masked.length & 0x7f)
  maskKey.copy(header, 2)
  return Buffer.concat([header, masked])
}
export const encodeWsClose = (code = 1000, reason = '') => {
  const reasonBuf = Buffer.from(String(reason || '').slice(0, 123), 'utf8')
  const payload = Buffer.allocUnsafe(2 + reasonBuf.length)
  payload.writeUInt16BE(code, 0)
  reasonBuf.copy(payload, 2)
  return encodeWsFrame(OP_CLOSE, payload)
}
export const encodeWsPong = (payload = Buffer.alloc(0)) => encodeWsFrame(OP_PONG, payload)

/**
 * 把 HTTP upgrade 收成可收发 JSON 文本帧的本端会话
 * @returns {{ sendText, close, destroy } | null}
 */
export const acceptWebSocketEndpoint = (
  req,
  socket,
  head,
  {
    onTextMessage,
    onClose,
    onError,
    label = 'ws-endpoint',
    // 额外响应头（不含 Status-Line）
    extraHeaders = {},
  } = {},
) => {
  const key = req.headers['sec-websocket-key']
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    try {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    } catch (_) {
      /* ignore */
    }
    try {
      socket.destroy()
    } catch (_) {
      /* ignore */
    }
    return null
  }

  const headerLines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ]
  // 不协商压缩扩展，保证明文 JSON 可解析
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    if (value !== undefined && value !== null && value !== '') {
      headerLines.push(`${name}: ${value}`)
    }
  }
  headerLines.push('', '')
  try {
    socket.write(headerLines.join('\r\n'))
  } catch (error) {
    console.error(error)
    try {
      socket.destroy()
    } catch (_) {
      /* ignore */
    }
    return null
  }

  socket.setNoDelay?.(true)
  socket.setTimeout?.(0)

  let closed = false
  let buffer = Buffer.alloc(0)
  let fragmentedOpcode = null
  let fragmentedChunks = []

  const resetFragment = () => {
    fragmentedOpcode = null
    fragmentedChunks = []
  }

  const settleClose = (err = null) => {
    if (closed) {
      return
    }
    closed = true
    if (typeof onClose === 'function') {
      try {
        onClose(err)
      } catch (callbackError) {
        console.error(callbackError)
      }
    }
  }

  const destroy = (err = null) => {
    settleClose(err)
    try {
      socket.destroy()
    } catch (_) {
      /* ignore */
    }
  }

  const sendRaw = (buf) => {
    if (closed || !socket.writable) {
      return false
    }
    try {
      socket.write(buf)
      return true
    } catch (error) {
      console.error(error)
      destroy(error)
      return false
    }
  }

  const sendText = (text) => sendRaw(encodeWsText(text))
  const close = (code = 1000, reason = '') => {
    sendRaw(encodeWsClose(code, reason))
    // 半关闭后等对端或短延时销毁
    setTimeout(() => destroy(), 500)
  }

  const emitText = (text) => {
    if (typeof onTextMessage !== 'function') {
      return
    }
    try {
      onTextMessage(text)
    } catch (error) {
      console.error(error)
      logger.warn(`[WsEndpoint:${label}] onTextMessage error: ${error.message}`)
      if (typeof onError === 'function') {
        try {
          onError(error)
        } catch (e) {
          console.error(e)
        }
      }
    }
  }

  const push = (chunk) => {
    if (!chunk || !chunk.length || closed) {
      return
    }
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk)
    if (buffer.length > 8 * 1024 * 1024) {
      logger.warn(`[WsEndpoint:${label}] buffer overflow, closing`)
      close(1009, 'message too big')
      return
    }

    while (!closed) {
      if (buffer.length < 2) {
        return
      }
      const b0 = buffer[0]
      const b1 = buffer[1]
      const fin = (b0 & 0x80) !== 0
      const rsv1 = (b0 & 0x40) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let payloadLen = b1 & 0x7f
      let offset = 2

      // 客户端帧必须 mask
      if (!masked && opcode < 0x8) {
        close(1002, 'client frames must be masked')
        return
      }

      if (payloadLen === 126) {
        if (buffer.length < 4) {
          return
        }
        payloadLen = buffer.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (buffer.length < 10) {
          return
        }
        const high = buffer.readUInt32BE(2)
        const low = buffer.readUInt32BE(6)
        if (high !== 0 || low > 8 * 1024 * 1024) {
          close(1009, 'message too big')
          return
        }
        payloadLen = low
        offset = 10
      }

      const total = offset + 4 + payloadLen
      if (buffer.length < total) {
        return
      }

      const mask = buffer.subarray(offset, offset + 4)
      let payload = buffer.subarray(offset + 4, total)
      const decoded = Buffer.allocUnsafe(payloadLen)
      for (let i = 0; i < payloadLen; i += 1) {
        decoded[i] = payload[i] ^ mask[i & 3]
      }
      payload = decoded
      buffer = buffer.subarray(total)

      if (rsv1) {
        // 未协商压缩，收到压缩帧则关
        close(1002, 'unexpected RSV1')
        return
      }

      if (opcode === OP_CLOSE) {
        let code = 1000
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0)
        }
        sendRaw(encodeWsClose(code))
        destroy()
        return
      }
      if (opcode === OP_PING) {
        sendRaw(encodeWsPong(payload))
        continue
      }
      if (opcode === OP_PONG) {
        continue
      }
      if (opcode >= 0x8) {
        continue
      }

      if (opcode === OP_CONTINUATION) {
        if (fragmentedOpcode === null) {
          continue
        }
        fragmentedChunks.push(payload)
        if (fin) {
          const full = Buffer.concat(fragmentedChunks)
          const op = fragmentedOpcode
          resetFragment()
          if (op === OP_TEXT) {
            emitText(full.toString('utf8'))
          }
        }
        continue
      }

      if (!fin) {
        fragmentedOpcode = opcode
        fragmentedChunks = [payload]
        continue
      }

      if (opcode === OP_TEXT) {
        emitText(payload.toString('utf8'))
      }
      // binary 忽略
    }
  }

  if (head && head.length) {
    push(head)
  }
  socket.on('data', push)
  socket.on('error', (error) => {
    console.error(error)
    destroy(error)
  })
  socket.on('close', () => destroy())
  socket.on('end', () => destroy())

  return { sendText, close, destroy, socket }
}
