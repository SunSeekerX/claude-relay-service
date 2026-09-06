import {
  createWsFrameSniffer,
  createWsClientTextRewriter,
} from '../src/common/gateway_ws_frame_sniffer.js'

const buildUnmaskedTextFrame = (text, { fin = true, opcode = 0x1 } = {}) => {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = (fin ? 0x80 : 0x00) | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    throw new Error('payload too large for test helper')
  }
  return Buffer.concat([header, payload])
}

const buildMaskedTextFrame = (text, { fin = true, opcode = 0x1, maskKey = Buffer.from([1, 2, 3, 4]) } = {}) => {
  const payload = Buffer.from(text, 'utf8')
  const masked = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i] ^ maskKey[i & 3]
  }
  const len = masked.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(2 + 4)
    header[0] = (fin ? 0x80 : 0x00) | opcode
    header[1] = 0x80 | len
    maskKey.copy(header, 2)
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4 + 4)
    header[0] = (fin ? 0x80 : 0x00) | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
    maskKey.copy(header, 4)
  } else {
    header = Buffer.allocUnsafe(10 + 4)
    header[0] = (fin ? 0x80 : 0x00) | opcode
    header[1] = 0x80 | 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
    maskKey.copy(header, 10)
  }
  return Buffer.concat([header, masked])
}

const decodeMaskedTextFrames = (buffers) => {
  const messages = []
  let buffer = Buffer.concat(buffers.map((item) => Buffer.from(item)))
  while (buffer.length >= 2) {
    const b0 = buffer[0]
    const b1 = buffer[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let payloadLen = b1 & 0x7f
    let offset = 2
    if (payloadLen === 126) {
      payloadLen = buffer.readUInt16BE(2)
      offset = 4
    } else if (payloadLen === 127) {
      payloadLen = buffer.readUInt32BE(6)
      offset = 10
    }
    const maskLen = masked ? 4 : 0
    const total = offset + maskLen + payloadLen
    if (buffer.length < total) {
      break
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
    if (fin && opcode === 0x1) {
      messages.push(payload.toString('utf8'))
    }
  }
  return messages
}

describe('wsFrameSniffer', () => {
  test('parses single unmasked text frame', () => {
    const messages = []
    const sniffer = createWsFrameSniffer({ onTextMessage: (t) => messages.push(t) })
    sniffer.push(buildUnmaskedTextFrame('{"type":"response.done"}'))
    expect(messages).toEqual(['{"type":"response.done"}'])
  })

  test('parses fragmented text frames', () => {
    const messages = []
    const sniffer = createWsFrameSniffer({ onTextMessage: (t) => messages.push(t) })
    sniffer.push(buildUnmaskedTextFrame('{"a":', { fin: false, opcode: 0x1 }))
    sniffer.push(buildUnmaskedTextFrame('1}', { fin: true, opcode: 0x0 }))
    expect(messages).toEqual(['{"a":1}'])
  })

  test('handles chunked arrival', () => {
    const messages = []
    const sniffer = createWsFrameSniffer({ onTextMessage: (t) => messages.push(t) })
    const frame = buildUnmaskedTextFrame('hello')
    sniffer.push(frame.subarray(0, 2))
    sniffer.push(frame.subarray(2))
    expect(messages).toEqual(['hello'])
  })
})

describe('wsClientTextRewriter', () => {
  test('rewrites fragmented masked text as one message', () => {
    const seen = []
    const rewriter = createWsClientTextRewriter({
      rewriteText: (text) => {
        seen.push(text)
        return text.replace('gpt-6', 'gpt-real')
      },
    })
    const out = []
    out.push(...rewriter.push(buildMaskedTextFrame('{"model":"gpt-', { fin: false, opcode: 0x1 })))
    out.push(...rewriter.push(buildMaskedTextFrame('6"}', { fin: true, opcode: 0x0 })))
    expect(seen).toEqual(['{"model":"gpt-6"}'])
    expect(decodeMaskedTextFrames(out)).toEqual(['{"model":"gpt-real"}'])
  })

  test('overflow enters bypass instead of half-frame flush', () => {
    const rewriter = createWsClientTextRewriter({
      rewriteText: (text) => text,
    })
    // 2 字节头 + 宣称超大 payload，但不给满；第二次 push 仍应旁路原样，不把半包当新帧
    const header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(16 * 1024 * 1024 + 1, 6)
    const first = rewriter.push(header)
    expect(rewriter.isBypass()).toBe(true)
    expect(Buffer.concat(first).equals(header)).toBe(true)
    const more = Buffer.from([0x01, 0x02, 0x03, 0x04])
    const second = rewriter.push(more)
    expect(Buffer.concat(second).equals(more)).toBe(true)
  })

  test('bypass during held fragment emits original frames not a premature FIN', () => {
    const rewriter = createWsClientTextRewriter({
      rewriteText: (text) => text.replace('gpt-6', 'gpt-real'),
    })
    const start = buildMaskedTextFrame('{"model":"gpt-', { fin: false, opcode: 0x1 })
    const held = rewriter.push(start)
    expect(held).toEqual([])
    const header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(16 * 1024 * 1024 + 1, 6)
    const flushed = rewriter.push(header)
    expect(rewriter.isBypass()).toBe(true)
    expect(flushed[0].equals(start)).toBe(true)
    expect(Buffer.concat(flushed.slice(1)).equals(header)).toBe(true)
  })

  test('empty continuation frames still trip fragment hold overflow', () => {
    const rewriter = createWsClientTextRewriter({
      rewriteText: (text) => text,
    })
    rewriter.push(buildMaskedTextFrame('x', { fin: false, opcode: 0x1 }))
    let entered = false
    for (let index = 0; index < 4096; index += 1) {
      rewriter.push(buildMaskedTextFrame('', { fin: false, opcode: 0x0 }))
      if (rewriter.isBypass()) {
        entered = true
        break
      }
    }
    expect(entered).toBe(true)
  })

  test('oversized starting text fragment enters bypass without double-holding', () => {
    const rewriter = createWsClientTextRewriter({
      rewriteText: (text) => text,
    })
    const payload = 'a'.repeat(9 * 1024 * 1024)
    const start = buildMaskedTextFrame(payload, { fin: false, opcode: 0x1 })
    const out = rewriter.push(start)
    expect(rewriter.isBypass()).toBe(true)
    expect(out[0].equals(start)).toBe(true)
  })
})
