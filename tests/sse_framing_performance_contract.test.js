import { expect, test } from '@jest/globals'
import { IncrementalSSEParser } from '../src/modules/relay/relay_sse_parser.js'

test('preserves every delimiter and UTF-8 value across all byte splits', () => {
  for (const delimiter of ['\n\n', '\r\n\r\n', '\r\n\n', '\n\r\n', '\r\r']) {
    const frames = [`event: test\ndata:{"text":"中文𠀋"}${delimiter}`, `data:{"value":2}${delimiter}`]
    const bytes = Buffer.from(frames.join(''))
    for (let split = 0; split <= bytes.length; split++) {
      const parser = new IncrementalSSEParser()
      expect([
        ...parser.feedFrames(bytes.subarray(0, split)),
        ...parser.feedFrames(bytes.subarray(split)),
        ...parser.finishFrames(),
      ]).toEqual(frames)
      expect(parser.hasPending()).toBe(false)
    }
  }
})

test('joins a large fragmented event once it is complete and preserves all values', () => {
  const value = { text: '文'.repeat(128 * 1024), last: true }
  const wire = Buffer.from(`data:${JSON.stringify(value)}\r\n\r\n`)
  const parser = new IncrementalSSEParser()
  const frames = []
  for (let index = 0; index < wire.length; index += 113) {
    frames.push(...parser.feed(wire.subarray(index, index + 113)))
  }
  expect(frames.map((frame) => frame.data)).toEqual([value])
  expect(parser.finish()).toEqual([])
})

test('handles tiny chunks, whitespace, final tails and reuse without joining for pending checks', () => {
  const parser = new IncrementalSSEParser()
  for (const byte of Buffer.from(`data: {"value":"${'x'.repeat(16384)}"}`)) {
    expect(parser.feedFrames(Buffer.from([byte]))).toEqual([])
    expect(parser.hasPending()).toBe(true)
  }
  expect(parser.finish()[0].data.value).toHaveLength(16384)
  expect(parser.hasPending()).toBe(false)
  parser.feedFrames(Buffer.from('data: {"discard":true}'))
  parser.reset()
  expect(parser.feed('data: {"next":true}\n\n')[0].data).toEqual({ next: true })
  expect(parser.feedFrames('  ')).toEqual([])
  expect(parser.hasPending()).toBe(true)
  expect(parser.finishFrames()).toEqual([])
})

test('retains the existing event size limit for an unfinished event', () => {
  const parser = new IncrementalSSEParser()
  expect(() => parser.feedFrames(Buffer.alloc(64 * 1024 * 1024 + 1, 120))).toThrow('SSE event exceeds the buffer limit')
})
