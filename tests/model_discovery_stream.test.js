import { describe, expect, test } from '@jest/globals'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import {
  pipeModelTestStream,
  rejectModelTestResponse,
  modelTestSignal,
} from '../src/modules/relay/relay_model_test_stream.js'
import { sendModelDiscovery } from '../src/modules/relay/relay_model_discovery.js'

class Response extends EventEmitter {
  chunks = []
  headers = {}
  writableEnded = false
  destroyed = false
  statusCode = 200
  write(value) {
    this.chunks.push(value)
  }
  end() {
    this.writableEnded = true
    return this
  }
  setHeader(key, value) {
    this.headers[key] = value
  }
  status(code) {
    this.statusCode = code
    return this
  }
  json(body) {
    this.body = body
    return this
  }
}
const frame = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const events = (res) =>
  res.chunks
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .map((value) => JSON.parse(value.slice(6)))
const check = async (format, data, fragment = false) => {
  const res = new Response()
  const bytes = Buffer.from(data)
  const chunks = fragment ? Array.from(bytes, (_value, index) => bytes.subarray(index, index + 1)) : [bytes]
  await pipeModelTestStream(Readable.from(chunks), res, format)
  return events(res)
}

describe('protocol model tests require real terminal events', () => {
  test('Chat Completions preserves fragmented UTF-8 text and accepts the done marker without a trailing newline', async () => {
    const result = await check(
      'openai-chat',
      `${frame({ choices: [{ delta: { content: '模型可用' } }] })}data: [DONE]`,
      true,
    )
    expect(result).toContainEqual({ type: 'content', text: '模型可用' })
    expect(result.at(-1)).toEqual({ type: 'test_complete', success: true })
  })
  test('Responses requires completed status and does not treat partial text or incomplete as success', async () => {
    const delta = frame({ type: 'response.output_text.delta', delta: 'partial' })
    expect((await check('openai-responses', delta)).at(-1).success).toBe(false)
    expect(
      (
        await check(
          'openai-responses',
          delta + frame({ type: 'response.incomplete', response: { status: 'incomplete' } }),
        )
      ).at(-1).success,
    ).toBe(false)
    expect(
      (
        await check(
          'openai-responses',
          delta + frame({ type: 'response.completed', response: { status: 'completed' } }),
        )
      ).at(-1).success,
    ).toBe(true)
  })
  test('an error followed by a terminal event remains a failed test', async () => {
    const result = await check('openai-chat', frame({ error: { message: 'model not found' } }) + frame('[DONE]'))
    expect(result.at(-1).success).toBe(false)
  })
  test('Claude observes message_stop and does not count a max_tokens partial result as success', async () => {
    const delta = frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '通过' } })
    expect((await check('claude-messages', delta + frame({ type: 'message_stop' }), true)).at(-1).success).toBe(true)
    expect(
      (
        await check(
          'claude-messages',
          delta +
            frame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }) +
            frame({ type: 'message_stop' }),
        )
      ).at(-1).success,
    ).toBe(false)
  })
  test('Gemini extracts all visible text parts, ignores thought parts, and respects finish reasons', async () => {
    const data = frame({
      candidates: [
        {
          content: { parts: [{ text: 'hidden', thought: true }, { text: '你好' }, { text: '世界' }] },
          finishReason: 'STOP',
        },
      ],
    })
    const result = await check('gemini-generate', data, true)
    expect(result).toContainEqual({ type: 'content', text: '你好世界' })
    expect(result.at(-1).success).toBe(true)
    expect((await check('gemini-generate', frame({ candidates: [{ finishReason: 'SAFETY' }] }))).at(-1).success).toBe(
      false,
    )
  })
  test('stream connection errors end as failure', async () => {
    const source = Readable.from(
      (async function* () {
        yield Buffer.from(frame({ choices: [{ delta: { content: 'partial' } }] }))
        throw new Error('socket closed')
      })(),
    )
    const res = new Response()
    await pipeModelTestStream(source, res, 'openai-chat')
    expect(events(res).at(-1)).toMatchObject({ success: false })
    expect(res.writableEnded).toBe(true)
  })
  test('upstream HTTP errors are bounded and never echo sensitive raw bodies', async () => {
    const res = new Response()
    await rejectModelTestResponse(
      Readable.from([Buffer.from(JSON.stringify({ error: { message: 'secret-token-should-not-escape' } }))]),
      res,
      403,
    )
    expect(events(res).at(-1).success).toBe(false)
    expect(res.chunks.join('')).not.toContain('secret-token-should-not-escape')
    const large = new Response()
    await rejectModelTestResponse(Readable.from([Buffer.alloc(100000, 'x')]), large, 500)
    expect(large.chunks.join('').length).toBeLessThan(1000)
  })
  test('closing a test aborts its pending request, while normal completion does not', () => {
    const pending = new Response()
    const signal = modelTestSignal(pending)
    pending.emit('close')
    expect(signal.aborted).toBe(true)
    const completed = new Response()
    const finished = modelTestSignal(completed)
    completed.end()
    completed.emit('close')
    expect(finished.aborted).toBe(false)
  })
})

describe('model discovery protocol projections', () => {
  test('empty model scopes stay empty for regular and Codex clients', () => {
    const plain = new Response()
    sendModelDiscovery({ query: {}, headers: {} }, plain, [])
    expect(plain.body).toEqual({ object: 'list', data: [] })
    const codex = new Response()
    sendModelDiscovery({ query: { client_version: 'fixture' }, headers: {} }, codex, [])
    expect(codex.body.models).toEqual([])
  })
  test('Codex manifests preserve the scoped model IDs and conditional ETag behavior', () => {
    const models = [{ id: 'model-a' }, { id: 'model-b' }]
    const res = new Response()
    sendModelDiscovery({ query: { client_version: 'fixture' }, headers: {} }, res, models)
    expect(new Set(res.body.models.map((model) => model.slug))).toEqual(new Set(['model-a', 'model-b']))
    const unchanged = new Response()
    sendModelDiscovery(
      { query: { client_version: 'fixture' }, headers: { 'if-none-match': res.headers.ETag } },
      unchanged,
      models,
    )
    expect(unchanged.statusCode).toBe(304)
    expect(unchanged.writableEnded).toBe(true)
  })
  test('Gemini model lists retain the native envelope', () => {
    const res = new Response()
    sendModelDiscovery({ query: {}, headers: {} }, res, [{ id: 'gemini-one' }], true)
    expect(res.body).toEqual({ models: [{ name: 'models/gemini-one', displayName: 'gemini-one' }] })
  })
})
