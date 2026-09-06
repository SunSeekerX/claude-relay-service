import crypto from 'node:crypto'
import { logger } from './logger.js'
// 从原始 WebSocket 字节流中嗅探文本帧（不改写转发字节）
// 服务端→客户端帧通常未 mask；客户端→服务端帧带 mask。
// 仅用于计费/观测，解析失败不影响隧道。

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9

export const createWsFrameSniffer = ({ onTextMessage, onCloseFrame, onPing, label = 'ws' } = {}) => {
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
      if (opcode === OP_PING) {
        // 上游 Ping：回调由隧道侧回 masked Pong（本服务作客户端）
        if (typeof onPing === 'function') {
          try {
            onPing(payload)
          } catch (error) {
            console.error(error)
          }
        }
        continue
      }
      if (opcode >= 0x8) {
        // pong 等其它控制帧忽略
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

// 客户端→上游文本帧改写：完整消息（含分片）重组后改写，再以单帧 masked 文本发出
// rewriteText(text)=>string|null；null/同文表示不改写
// 溢出策略：旁路透传 + 16MiB 上限（DEC_20260906_011816）
const WS_REWRITE_MAX_BUFFER = 16 * 1024 * 1024
const WS_REWRITE_MAX_FRAME = 16 * 1024 * 1024
// 空/极短分片绕过 payload 字节上限：同时限制帧数与实际占用（含原始帧）
// DEC_20260906_103722
const WS_REWRITE_MAX_FRAGMENT_FRAMES = 4096

export const createWsClientTextRewriter = ({ rewriteText, label = 'ws-rewrite' } = {}) => {
  let buffer = Buffer.alloc(0)
  let bypass = false
  // 不可改写的分片消息：逐帧原样转发直到 FIN
  let passthroughFragment = false
  let fragmentedOpcode = null
  let fragmentedChunks = []
  let fragmentedHeldBytes = 0
  let fragmentedFrameCount = 0
  // 重组期间保留原始线帧；旁路时必须原样吐出，禁止丢分片 / 提前 FIN
  // DEC_20260906_014853
  let fragmentedRawFrames = []

  const resetFragment = () => {
    passthroughFragment = false
    fragmentedOpcode = null
    fragmentedChunks = []
    fragmentedHeldBytes = 0
    fragmentedFrameCount = 0
    fragmentedRawFrames = []
  }

  const fragmentWouldOverflow = (rawFrame, payload) => {
    const nextCount = fragmentedFrameCount + 1
    const nextBytes = fragmentedHeldBytes + rawFrame.length + payload.length
    return nextCount > WS_REWRITE_MAX_FRAGMENT_FRAMES || nextBytes > WS_REWRITE_MAX_BUFFER
  }

  const holdFragmentFrame = (rawFrame, payload) => {
    fragmentedRawFrames.push(rawFrame)
    fragmentedChunks.push(payload)
    fragmentedFrameCount += 1
    fragmentedHeldBytes += rawFrame.length + payload.length
  }

  const flushHeldRawFrames = (out) => {
    if (fragmentedRawFrames.length) {
      for (const frame of fragmentedRawFrames) {
        out.push(frame)
      }
    }
    resetFragment()
  }

  const encodeMaskedText = (text) => {
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

  const enterBypass = (out, reason) => {
    if (!bypass) {
      logger.warn(`[WsRewrite:${label}] enter bypass: ${reason}`)
    }
    bypass = true
    // 先吐出尚未发出的原始分片，再吐剩余 buffer；禁止清空丢失或提前 FIN=1
    // DEC_20260906_014853
    flushHeldRawFrames(out)
    if (buffer.length) {
      out.push(buffer)
      buffer = Buffer.alloc(0)
    }
  }

  const unmaskPayload = (rawFrame, offset, payloadLen, masked) => {
    const maskLen = masked ? 4 : 0
    const payload = rawFrame.subarray(offset + maskLen, offset + maskLen + payloadLen)
    if (!masked) {
      return Buffer.from(payload)
    }
    const mask = rawFrame.subarray(offset, offset + 4)
    const decoded = Buffer.allocUnsafe(payloadLen)
    for (let i = 0; i < payloadLen; i += 1) {
      decoded[i] = payload[i] ^ mask[i & 3]
    }
    return decoded
  }

  const emitRewrittenText = (out, text) => {
    if (typeof rewriteText !== 'function') {
      out.push(encodeMaskedText(text))
      return
    }
    let rewritten
    try {
      rewritten = rewriteText(text)
    } catch (error) {
      console.error(error)
      rewritten = null
    }
    if (typeof rewritten === 'string' && rewritten !== text) {
      out.push(encodeMaskedText(rewritten))
    } else {
      out.push(encodeMaskedText(text))
    }
  }

  const push = (chunk) => {
    const out = []
    if (!chunk || !chunk.length) {
      return out
    }
    // 已旁路：不再解析，原样转发，保证帧边界不被二次切开
    if (bypass) {
      out.push(Buffer.from(chunk))
      return out
    }
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk)
    if (buffer.length > WS_REWRITE_MAX_BUFFER) {
      enterBypass(out, `buffer>${WS_REWRITE_MAX_BUFFER}`)
      return out
    }

    while (true) {
      if (bypass) {
        break
      }
      if (buffer.length < 2) {
        break
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
          break
        }
        payloadLen = buffer.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (buffer.length < 10) {
          break
        }
        const high = buffer.readUInt32BE(2)
        const low = buffer.readUInt32BE(6)
        if (high !== 0 || low > WS_REWRITE_MAX_FRAME) {
          enterBypass(out, `frameLen>${WS_REWRITE_MAX_FRAME}`)
          break
        }
        payloadLen = low
        offset = 10
      }
      const maskLen = masked ? 4 : 0
      const total = offset + maskLen + payloadLen
      if (buffer.length < total) {
        break
      }
      const rawFrame = Buffer.from(buffer.subarray(0, total))
      buffer = buffer.subarray(total)

      // 控制帧：原样转发，不打断分片状态（除 CLOSE 清分片）
      if (opcode >= 0x8) {
        if (opcode === OP_CLOSE) {
          flushHeldRawFrames(out)
        }
        out.push(rawFrame)
        continue
      }

      // 客户端→服务端帧按 RFC 必须 masked；未 mask 的数据帧无法安全改写
      if (!masked) {
        flushHeldRawFrames(out)
        out.push(rawFrame)
        continue
      }

      // 不可改写分片中：原样转发直到 FIN
      if (passthroughFragment) {
        out.push(rawFrame)
        if (fin || opcode >= 0x8) {
          // 控制帧不应出现在此分支；FIN 结束透传分片
          if (opcode === OP_CONTINUATION || opcode === OP_TEXT || opcode === OP_BINARY) {
            if (fin) {
              passthroughFragment = false
            }
          }
        }
        continue
      }

      const payload = unmaskPayload(rawFrame, offset, payloadLen, masked)

      // 分片消息：攒齐后再改写为单帧发出（DEC_20260906_011816）
      if (opcode === OP_CONTINUATION) {
        if (fragmentedOpcode === null) {
          // 无起始片：原样转发本帧，避免吞字节
          out.push(rawFrame)
          continue
        }
        if (fragmentWouldOverflow(rawFrame, payload)) {
          // 超限：先持有本帧再原样吐出已持有分片并旁路，禁止提前 FIN=1
          // DEC_20260906_014853 / DEC_20260906_103722 空分片也计入帧数与占用
          holdFragmentFrame(rawFrame, payload)
          enterBypass(out, 'fragment hold overflow')
          break
        }
        holdFragmentFrame(rawFrame, payload)
        if (fin) {
          const full = Buffer.concat(fragmentedChunks)
          const op = fragmentedOpcode
          resetFragment()
          // 仅 TEXT 分片会进入重组路径；其它 opcode 起始已走 passthroughFragment
          if (op === OP_TEXT) {
            emitRewrittenText(out, full.toString('utf8'))
          }
        }
        continue
      }

      if (!fin) {
        // 分片起始：仅明文 TEXT 可重组改写；压缩/binary 逐帧透传
        if (rsv1 || opcode !== OP_TEXT || typeof rewriteText !== 'function') {
          passthroughFragment = true
          out.push(rawFrame)
          continue
        }
        if (fragmentWouldOverflow(rawFrame, payload)) {
          // 起始分片本身超占用：不重组、不双持有，原样发出并旁路
          // DEC_20260906_105200
          out.push(rawFrame)
          enterBypass(out, 'fragment start overflow')
          break
        }
        fragmentedOpcode = opcode
        holdFragmentFrame(rawFrame, payload)
        continue
      }

      // 完整单帧
      if (rsv1) {
        // 压缩单帧：无法明文改写，原样转发
        out.push(rawFrame)
        continue
      }
      if (opcode === OP_TEXT && typeof rewriteText === 'function') {
        emitRewrittenText(out, payload.toString('utf8'))
      } else {
        out.push(rawFrame)
      }
    }
    return out
  }

  return {
    push,
    flush: () => {
      const out = []
      bypass = true
      flushHeldRawFrames(out)
      if (buffer.length) {
        out.push(buffer)
        buffer = Buffer.alloc(0)
      }
      return out
    },
    isBypass: () => bypass,
  }
}
