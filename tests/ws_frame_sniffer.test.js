import { createWsFrameSniffer } from '../src/common/gateway_ws_frame_sniffer.js'

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
