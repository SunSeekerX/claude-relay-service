import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { Readable } from 'node:stream'

const keyData = {
  id: 'key1',
  _relayRoute: { code: 'a', modelMode: 'mapped-only', modelMapping: { alias: 'gpt-target' } },
}
const validate = jest.fn(async () => ({ ok: true, keyData }))
const post = jest.fn()
const getContext = jest.fn()
await jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis: { getResponsesContext: getContext } }))
await jest.unstable_mockModule('../src/modules/relay/relay_responses_gateway.js', () => ({ responsesContextScope: () => 'fixture-scope' }))
await jest.unstable_mockModule('../src/common/gateway_ws_api_key_auth.js', () => ({
  extractBearerOrQueryKey: () => 'private-fixture-key',
  validateWsApiKey: validate,
}))
await jest.unstable_mockModule('../config/config.js', () => ({ config: { server: { port: 3000, host: '0.0.0.0' } } }))
await jest.unstable_mockModule('axios', () => ({ default: { post } }))
await jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: { error: jest.fn() } }))
await jest.unstable_mockModule('../src/modules/relay/relay_codex_responses_ws_bridge.js', () => ({
  buildHttpResponsesBodyFromWsMessage: (message, state) => ({
    model: 'normalized-by-old-bridge',
    input: [...(state.inputItems ?? []), ...(message.input ?? [])],
    stream: true,
  }),
  completeHttpBridgeWarmup: (body) => [
    { type: 'response.completed', response: { model: body.model, usage: { input_tokens: 0 } } },
  ],
  createHttpBridgeLanes: jest.fn(),
}))
const { buildNamedWsRequest, relayNamedWsTurn } = await import('../src/modules/relay/relay_routing_websocket.js')
const req = {
  headers: { host: 'localhost:3000', 'user-agent': 'fixture-client', 'session-id': 'same-session' },
  url: '/r/a/v1/responses',
}
const url = new URL('http://localhost:3000/r/a/v1/responses')
beforeEach(() => {
  post.mockReset()
  validate.mockClear()
  getContext.mockReset()
  validate.mockResolvedValue({ ok: true, keyData })
})

describe('named Responses WebSocket bridge', () => {
  test('a reconnected reverse-provider socket hydrates persisted history before the single HTTP turn', async () => {
    const keyData = { id: 'key1', permissions: ['claude'], _relayRoute: { code: 'a', provider: 'claude', binding: 'account' } }
    validate.mockResolvedValue({ ok: true, keyData })
    getContext.mockResolvedValue({ input: [{ role: 'user', content: 'prior history' }] })
    post.mockResolvedValue({ status: 200, data: Readable.from([`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_next', output: [] } })}\n\n`]) })
    const body = buildNamedWsRequest({ type: 'response.create', model: 'claude-test', previous_response_id: 'resp_prior', input: [{ role: 'user', content: 'next' }] }, { inputItems: [], allowExternalPreviousResponse: true })
    expect(body.store).toBe(true)
    await relayNamedWsTurn({ req, url, body, state: {}, sendText: () => {}, signal: new AbortController().signal })
    expect(getContext).toHaveBeenCalledWith('fixture-scope', 'resp_prior')
    expect(post.mock.calls[0][1].input).toHaveLength(2)
    expect(post.mock.calls[0][1].previous_response_id).toBeUndefined()
    expect(post).toHaveBeenCalledTimes(1)
  })
  test('legacy Claude Responses sockets use the same HTTP bridge without requiring an OpenAI route', async () => {
    validate.mockResolvedValue({ ok: true, keyData: { id: 'key1', permissions: ['claude'] } })
    const response = { id: 'resp1', output: [], usage: { input_tokens: 0, output_tokens: 0 } }
    post.mockResolvedValue({ status: 200, data: Readable.from([`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`]) })
    const output = []
    await relayNamedWsTurn({ req, url: new URL('http://localhost/openai/claude/v1/responses'), body: { model: 'claude-test', input: [], stream: true }, state: {}, sendText: (text) => output.push(text), signal: new AbortController().signal })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toBe('http://127.0.0.1:3000/openai/claude/v1/responses')
    expect(output).toHaveLength(1)
  })
  test('preserves a configured alias and native request fields before HTTP route mapping', () => {
    const body = buildNamedWsRequest(
      { type: 'response.create', model: 'alias', input: [], max_output_tokens: 123, temperature: 0 },
      { inputItems: [] },
    )
    expect(body).toMatchObject({ model: 'alias', max_output_tokens: 123, temperature: 0 })
  })

  test('revalidates every turn and invokes the same named HTTP path exactly once without separate billing', async () => {
    const response = { id: 'resp1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] }
    post.mockResolvedValue({
      status: 200,
      data: Readable.from([Buffer.from(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)]),
    })
    const output = []
    const state = {}
    await relayNamedWsTurn({
      req,
      url,
      body: { model: 'alias', input: [{ role: 'user', content: 'hi' }], stream: true },
      state,
      sendText: (value) => output.push(JSON.parse(value)),
      signal: new AbortController().signal,
    })
    expect(validate).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toBe('http://127.0.0.1:3000/r/a/v1/responses')
    expect(state.lastResponseId).toBe('resp1')
    expect(state.model).toBe('alias')
    expect(output[0].type).toBe('response.completed')
  })

  test('revoked authorization prevents any turn HTTP call', async () => {
    validate.mockResolvedValue({ ok: false, status: 403, message: 'revoked' })
    await expect(
      relayNamedWsTurn({ req, url, body: { model: 'alias' }, state: {}, sendText: jest.fn() }),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(post).not.toHaveBeenCalled()
  })

  test('failed transport never exposes the Axios authorization config in a propagated error', async () => {
    post.mockRejectedValue(
      Object.assign(new Error('connection refused'), {
        code: 'ECONNREFUSED',
        config: { headers: { 'x-api-key': 'private-fixture-key' } },
      }),
    )
    try {
      await relayNamedWsTurn({ req, url, body: { model: 'alias', input: [] }, state: {}, sendText: jest.fn() })
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 502 })
      expect(error).not.toHaveProperty('config')
      expect(JSON.stringify(error)).not.toContain('private-fixture-key')
    }
  })
})
