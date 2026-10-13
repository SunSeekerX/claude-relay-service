import { jest } from '@jest/globals'
import { repairResponsesToolCallsInBody } from '../src/modules/relay/relay_codex_responses_ws_tool_repair.js'
const mocks = {
  '../config/config.js': { config: {} },
  '../config/env.js': { env: {} },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/infra/redis.js': { redis: {} },
  '../src/modules/account/account_openai_service.js': {},
  '../src/modules/relay/relay_unified_openai_scheduler.js': { unifiedOpenAIScheduler: {} },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: {} },
  '../src/modules/relay/relay_request_detail_service.js': { requestDetailService: {} },
  '../src/common/gateway_ws_api_key_auth.js': {
    validateWsApiKey: jest.fn(),
    acquireWsTurnConcurrency: jest.fn()
  }
}
for (const [name, exports] of Object.entries(mocks)) {
  jest.unstable_mockModule(name, () => exports)
}
const { createHttpBridgeLanes } =
  await import('../src/modules/relay/relay_codex_responses_ws_bridge.js')

describe('HTTP bridge WebSocket lanes', () => {
  it('runs separate lanes concurrently and queues each lane in order', async () => {
    const started = []
    const gates = new Map()
    const run = jest.fn((body) => {
      const id = body.input[0].content
      started.push(id)
      return new Promise((resolve) => gates.set(id, resolve))
    })
    const lanes = createHttpBridgeLanes({ run, sendText: jest.fn() })
    const create = (lane, content) =>
      lanes.processText(
        JSON.stringify({
          type: 'response.create',
          stream_id: lane,
          model: 'gpt-test',
          input: [{ role: 'user', content }]
        })
      )
    const a1 = create('a', 'a1')
    const a2 = create('a', 'a2')
    const b1 = create('b', 'b1')
    await Promise.resolve()
    expect(started).toEqual(['a1', 'b1'])
    gates.get('a1')()
    await a1
    await Promise.resolve()
    expect(started).toEqual(['a1', 'b1', 'a2'])
    gates.get('b1')()
    gates.get('a2')()
    await Promise.all([a2, b1, lanes.drain()])
    expect(run.mock.calls.every(([body]) => body.stream_id === undefined)).toBe(true)
  })

  it('forks the latest response context without mutating the source lane and tags outputs', async () => {
    const bodies = []
    const output = []
    const lanes = createHttpBridgeLanes({
      sendText: (text) => output.push(JSON.parse(text)),
      run: async (body, state, sendText) => {
        bodies.push(body)
        state.lastResponseId = `response-${bodies.length}`
        state.inputItems = [...body.input, { role: 'assistant', content: 'answer' }]
        state.model = body.model
        state.lastRequestBody = { ...body }
        sendText(
          JSON.stringify({ type: 'response.completed', response: { id: state.lastResponseId } })
        )
      }
    })
    const create = (event) =>
      lanes.processText(JSON.stringify({ type: 'response.create', model: 'gpt-test', ...event }))
    await create({ stream_id: 'source', input: [{ role: 'user', content: 'original' }] })
    await create({
      stream_id: 'fork',
      previous_response_id: 'response-1',
      input: [{ role: 'user', content: 'forked' }]
    })
    await create({
      stream_id: 'source',
      previous_response_id: 'response-1',
      input: [{ role: 'user', content: 'continued' }]
    })
    expect(bodies[1].input.map((item) => item.content)).toEqual(['original', 'answer', 'forked'])
    expect(bodies[2].input.map((item) => item.content)).toEqual(['original', 'answer', 'continued'])
    expect(output.map((event) => event.stream_id)).toEqual(['source', 'fork', 'source'])
  })

  it('requires native transport for real mid-turn steering', async () => {
    const run = jest.fn()
    const sendText = jest.fn()
    const lanes = createHttpBridgeLanes({ run, sendText })
    await lanes.processText(
      JSON.stringify({ type: 'response.steer', previous_response_id: 'response', input: [] })
    )
    expect(run).not.toHaveBeenCalled()
    expect(JSON.parse(sendText.mock.calls[0][0])).toMatchObject({
      type: 'error',
      status: 400,
      error: { code: 'steering_not_supported' }
    })
  })

  it('blocks later queued turns after a critical billing failure', async () => {
    const run = jest.fn().mockRejectedValue(
      Object.assign(new Error('billing unavailable'), {
        statusCode: 503,
        code: 'billing_unavailable'
      })
    )
    const sendText = jest.fn()
    const lanes = createHttpBridgeLanes({ run, sendText })
    await lanes.processText(
      JSON.stringify({ type: 'response.create', model: 'gpt-test', input: [] })
    )
    await lanes.processText(
      JSON.stringify({ type: 'response.create', model: 'gpt-test', input: [] })
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sendText.mock.calls.at(-1)[0]).status).toBe(503)
  })

  it('keeps image and file content arrays in valid function outputs', () => {
    const output = [
      { type: 'input_image', image_url: 'data:image/png;base64,YQ==' },
      { type: 'input_file', file_data: 'data:application/pdf;base64,YQ==' }
    ]
    const body = repairResponsesToolCallsInBody({
      input: [
        { type: 'function_call', call_id: 'call', name: 'inspect', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call', output }
      ]
    })
    expect(body.input[1].output).toEqual(output)
    expect(Array.isArray(body.input[1].output)).toBe(true)
  })
})
