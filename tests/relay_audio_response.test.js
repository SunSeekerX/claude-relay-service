import { expect, test } from '@jest/globals'
import { Readable, Writable } from 'node:stream'
import { readAudioResponse } from '../src/modules/relay/relay_audio_response.js'

const sink = () => {
  const chunks = []
  const destination = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk))
      done()
    },
  })
  destination.status = () => destination
  return { destination, body: () => Buffer.concat(chunks) }
}

test.each(['hello\n', 'WEBVTT\n\n00:00.000 --> 00:01.000\n你好\n'])(
  'audio text remains byte-identical',
  async (text) => {
    const body = Buffer.from(text)
    const result = await readAudioResponse(
      { data: Readable.from([body]), headers: { 'content-type': 'text/vtt' }, status: 200 },
      sink().destination,
    )
    expect(result.body.equals(body)).toBe(true)
  },
)

test('streaming transcription preserves UTF-8 frames and observes only final usage', async () => {
  const wire = Buffer.from(
    'data:{"type":"transcript.text.delta","delta":"你好"}\r\n\r\ndata:{"type":"transcript.text.done","usage":{"input_tokens":10,"output_tokens":2}}\n\n',
  )
  const target = sink()
  const result = await readAudioResponse(
    {
      data: Readable.from([...wire].map((byte) => Buffer.from([byte]))),
      headers: { 'content-type': 'text/event-stream' },
      status: 200,
    },
    target.destination,
  )
  expect(target.body().equals(wire)).toBe(true)
  expect(result).toMatchObject({
    statusCode: 200,
    protocolTerminal: 'transcript.text.done',
    data: { usage: { input_tokens: 10 } },
  })
})

test('transport EOF without transcript terminal produces an explicit failure', async () => {
  const target = sink()
  const result = await readAudioResponse(
    {
      data: Readable.from(['data:{"type":"transcript.text.delta","delta":"partial"}\n\n']),
      headers: { 'content-type': 'text/event-stream' },
      status: 200,
    },
    target.destination,
  )
  expect(result.statusCode).toBe(502)
  expect(target.body().toString()).toContain('event: error')
})
