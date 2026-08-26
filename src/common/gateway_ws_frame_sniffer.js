import { logger } from './logger.js'
// 从原始 WebSocket 字节流中嗅探文本帧（不改写转发字节）
// 服务端→客户端帧通常未 mask；客户端→服务端帧带 mask。
// 仅用于计费/观测，解析失败不影响隧道。

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8

export const createWsFrameSniffer = ({ onTextMessage, onCloseFrame, label = 'ws' } = {}) => {
  let buffer = Buffer.alloc(0)
  let fragmentedOpcode = null
  let fragmentedChunks = []
  let fragmentedRsv1 = false

  const resetFragment = () => {
    fragmentedOpcode = null
    fragmentedChunks = []
    fragmentedRsv1 = false
  }

  const emitText = (text) => {
    if (typeof onTextMessage !== 'function' || text === null) {
      return
    }
    try {
      onTextMessage(text)
    } catch (error) {
      console.error(error)
      logger.warn(`[WsSniffer:${label}] onTextMessage error: ${error.message}`)
    }
  }

  const push = (chunk) => {
    if (!chunk || !chunk.length) {
      return
    }
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk)

    // 防止异常流量把 buffer 撑爆：只保留最近 4MB 未完成帧
    if (buffer.length > 4 * 1024 * 1024) {
      logger.warn(`[WsSniffer:${label}] buffer overflow, reset`)
      buffer = Buffer.alloc(0)
      resetFragment()
      return
    }

    while (true) {
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
        // 超大帧不解析（仍由隧道原样转发）
        if (high !== 0 || low > 8 * 1024 * 1024) {
          buffer = Buffer.alloc(0)
          resetFragment()
          return
        }
        payloadLen = low
        offset = 10
      }

      const maskLen = masked ? 4 : 0
      const total = offset + maskLen + payloadLen
      if (buffer.length < total) {
        return
      }

      let payload = buffer.subarray(offset + maskLen, total)
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4)
        const decoded = Buffer.allocUnsafe(payloadLen)
        for (let i = 0; i < payloadLen; i += 1) {
          decoded[i] = payload[i] ^ mask[i & 3]
        }
        payload = decoded
      }

      buffer = buffer.subarray(total)

      // control frames
      if (opcode === OP_CLOSE) {
        if (typeof onCloseFrame === 'function') {
          try {
            onCloseFrame(payload)
          } catch (error) {
            console.error(error)
          }
        }
        resetFragment()
        continue
      }
      if (opcode >= 0x8) {
        // ping/pong 等控制帧忽略
        continue
      }

      // data frames
      if (opcode === OP_CONTINUATION) {
        if (fragmentedOpcode === null) {
          continue
        }
        fragmentedChunks.push(payload)
        if (fin) {
          const full = Buffer.concat(fragmentedChunks)
          const op = fragmentedOpcode
          const wasCompressed = fragmentedRsv1 || rsv1
          resetFragment()
          if (wasCompressed) {
            logger.debug(`[WsSniffer:${label}] skip compressed fragmented frame opcode=${op}`)
          } else if (op === OP_TEXT) {
            emitText(full.toString('utf8'))
          }
        }
        continue
      }

      if (!fin) {
        fragmentedOpcode = opcode
        fragmentedRsv1 = rsv1
        fragmentedChunks = [payload]
        continue
      }

      // single full frame
      // RSV1 = permessage-deflate 压缩帧，无法当明文 JSON 解析（应已在握手剥离扩展）
      if (rsv1) {
        if (opcode === OP_TEXT || opcode === OP_BINARY || opcode === OP_CONTINUATION) {
          logger.debug(`[WsSniffer:${label}] skip compressed frame opcode=${opcode}`)
        }
        continue
      }
      if (opcode === OP_TEXT) {
        emitText(payload.toString('utf8'))
      }
      // binary ignored for billing sniffer
    }
  }

  return {
    push,
    reset: () => {
      buffer = Buffer.alloc(0)
      resetFragment()
    },
  }
}
