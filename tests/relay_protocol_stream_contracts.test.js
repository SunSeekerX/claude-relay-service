import { jest } from '@jest/globals'
import { IncrementalSSEParser } from '../src/modules/relay/relay_sse_parser.js'
import { createCapacityShedSseRewriteStream } from '../src/modules/relay/relay_openai_capacity_shed.js'
import { normalizeOpenAITokenUsage } from '../src/modules/relay/relay_request_detail_helper.js'
import { ResponsesStreamState } from '../src/modules/relay/relay_responses_stream_state.js'
jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: new Proxy({}, { get: () => jest.fn() }),
}))
const {
  convertClaudeRequestToResponses,
  convertResponsesResultToClaudeMessage,
  createClaudeFromResponsesStreamState,
  convertResponsesStreamEventToClaude,
  finishClaudeFromResponsesStream,
} = await import('../src/modules/relay/translator/relay_translator_claude_responses.js')

const convertStream = (events) => {
  const state = createClaudeFromResponsesStreamState()
  const output = events.flatMap((event) => convertResponsesStreamEventToClaude(event, state))
  return { state, output }
}

describe('SSE wire boundaries', () => {
  it('preserves UTF-8, mixed delimiters and multiline data at every byte split', () => {
    const payload = { type: 'response.output_text.delta', delta: '中文\u{1f642}' }
    const text =
      `event: response.output_text.delta\r\ndata:${JSON.stringify(payload)}\r\n\r\n` +
      'event: response.completed\ndata: {"type":"response.completed",\ndata: "response":{"usage":{"input_tokens":1,"output_tokens":2}}}\n\n'
    const bytes = Buffer.from(text)
    for (let split = 0; split <= bytes.length; split += 1) {
      const parser = new IncrementalSSEParser()
      const rewriter = createCapacityShedSseRewriteStream()
      const chunks = [bytes.subarray(0, split), bytes.subarray(split)]
      const parsed = chunks.flatMap((chunk) => parser.feed(chunk)).concat(parser.finish())
      expect(parsed.filter((event) => event.type === 'data').map((event) => event.data)).toEqual([
        payload,
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } },
      ])
      expect(chunks.map((chunk) => rewriter.push(chunk)).join('') + rewriter.flush()).toBe(text)
    }
  })

  it('rewrites capacity errors without requiring a space after data:', () => {
    const rewriter = createCapacityShedSseRewriteStream()
    const parser = new IncrementalSSEParser()
    const text = rewriter.push('data:{"error":{"code":"slow_down","message":"at capacity"}}\n\n')
    expect(parser.feed(text)[0].data.error.code).toBe('server_error')
  })
})

describe('Responses accounting and terminal state', () => {
  it('keeps input, cache read and cache write buckets disjoint', () => {
    expect(
      normalizeOpenAITokenUsage({
        input_tokens: 1000,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 800, cache_write_tokens: 50 },
      }),
    ).toEqual({
      totalInputTokens: 1000,
      inputTokens: 150,
      outputTokens: 40,
      cacheReadTokens: 800,
      cacheCreateTokens: 50,
    })
    expect(
      normalizeOpenAITokenUsage({
        prompt_tokens: 1000,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 900 },
      }),
    ).toMatchObject({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 40 })
  })

  it('retains reported usage from incomplete and failed responses', () => {
    for (const type of ['response.incomplete', 'response.failed']) {
      const state = new ResponsesStreamState()
      const usage = { input_tokens: 1000, output_tokens: 40 }
      state.observe({
        type,
        response: {
          model: 'gpt-test',
          usage,
          service_tier: 'default',
          incomplete_details: { reason: 'max_output_tokens' },
        },
      })
      state.finish()
      expect(state.usage).toEqual(usage)
      expect(state.terminalType).toBe(type)
      expect(state.serviceTier).toBe('default')
    }
  })

  it('classifies nested rate limits and incomplete EOF without inventing usage', () => {
    const limited = new ResponsesStreamState()
    limited.observe({
      type: 'response.failed',
      response: {
        error: { code: 'rate_limit_exceeded', message: 'retry later', resets_in_seconds: 45 },
      },
    })
    expect(limited.finish()).toMatchObject({ statusCode: 429, errorCode: 'rate_limit_exceeded' })
    const truncated = new ResponsesStreamState()
    truncated.observe({ type: 'response.created', response: { id: 'r1' } })
    expect(truncated.finish()).toMatchObject({ statusCode: 502, errorCode: 'upstream_stream_incomplete' })
    expect(truncated.usage).toBeNull()
  })

  it('does not let trailing events replace a completed response', () => {
    const state = new ResponsesStreamState()
    state.observe({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4 } } })
    state.observe({ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } })
    expect(state.finish(new Error('socket closed'))).toMatchObject({ statusCode: 200, errorCode: null })
    expect(state.usage).toEqual({ input_tokens: 3, output_tokens: 4 })
  })
})

describe('Claude Messages and Responses round trips', () => {
  it('associates interleaved tool deltas by item identity and closes each block once', () => {
    const toolA = { type: 'function_call', id: 'fc_A', call_id: 'call_A', name: 'read_a', arguments: '{"a":1}' }
    const toolB = { type: 'function_call', id: 'fc_B', call_id: 'call_B', name: 'read_b', arguments: '{"b":2}' }
    const { output } = convertStream([
      { type: 'response.created', response: { id: 'r1', model: 'gpt-test' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...toolA, arguments: '' } },
      { type: 'response.output_item.added', output_index: 1, item: { ...toolB, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_A', delta: '{"a":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_B', delta: '{"b":2}' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_A', delta: '1}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_B', arguments: toolB.arguments },
      { type: 'response.function_call_arguments.done', item_id: 'fc_A', arguments: toolA.arguments },
      { type: 'response.output_item.done', output_index: 0, item: toolA },
      { type: 'response.output_item.done', output_index: 1, item: toolB },
      { type: 'response.completed', response: { output: [toolA, toolB] } },
    ])
    const blocks = []
    const stopped = []
    for (const { data } of output) {
      if (data.type === 'content_block_start') {
        blocks[data.index] = { id: data.content_block.id, arguments: '' }
      } else if (data.type === 'content_block_delta') {
        blocks[data.index].arguments += data.delta.partial_json
      } else if (data.type === 'content_block_stop') {
        stopped.push(data.index)
      }
    }
    expect(blocks).toEqual([
      { id: 'call_A', arguments: '{"a":1}' },
      { id: 'call_B', arguments: '{"b":2}' },
    ])
    expect(stopped).toEqual([0, 1])
    expect(output.filter((item) => item.event === 'error')).toEqual([])
  })

  it('preserves signatures, including reasoning with no visible summary', () => {
    const reasoning = { type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'opaque-one' }
    const { output } = convertStream([
      { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, encrypted_content: undefined } },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.completed', response: { output: [reasoning] } },
    ])
    expect(
      output.filter((item) => item.data.delta?.type === 'signature_delta').map((item) => item.data.delta.signature),
    ).toEqual(['opaque-one'])
    const replay = convertClaudeRequestToResponses({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'first', signature: 'opaque-one' },
            { type: 'text', text: 'between' },
            { type: 'thinking', thinking: 'second', signature: 'opaque-two' },
          ],
        },
      ],
    })
    expect(replay.input.map((item) => item.type)).toEqual(['reasoning', 'message', 'reasoning'])
    expect(replay.input.filter((item) => item.type === 'reasoning').map((item) => item.encrypted_content)).toEqual([
      'opaque-one',
      'opaque-two',
    ])
  })

  it('keeps the canonical summary when Grok emits both reasoning channels', () => {
    const item = {
      type: 'reasoning',
      id: 'rs1',
      encrypted_content: 'opaque',
      summary: [{ type: 'summary_text', text: '简要过程' }],
      content: [{ type: 'reasoning_text', text: '详细过程' }],
    }
    const { output } = convertStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs1' } },
      { type: 'response.reasoning_text.delta', item_id: 'rs1', delta: '详细过程' },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs1', summary_index: 0, delta: '简要过程' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { output: [item] } },
    ])
    expect(
      output
        .filter((entry) => entry.data.delta?.type === 'thinking_delta')
        .map((entry) => entry.data.delta.thinking)
        .join(''),
    ).toBe('简要过程')
    expect(output.filter((entry) => entry.event === 'error')).toEqual([])
    expect(output.filter((entry) => entry.data.delta?.type === 'signature_delta')).toHaveLength(1)
  })

  it('emits a signature supplied only by the terminal response before closing thinking', () => {
    const reasoning = {
      type: 'reasoning',
      id: 'rs1',
      summary: [{ type: 'summary_text', text: '过程' }],
    }
    const message = {
      type: 'message',
      id: 'm1',
      content: [{ type: 'output_text', text: '结论' }],
    }
    const { output } = convertStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs1' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs1', summary_index: 0, delta: '过程' },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'm1' } },
      { type: 'response.output_text.delta', item_id: 'm1', delta: '结论' },
      { type: 'response.output_item.done', output_index: 1, item: message },
      {
        type: 'response.completed',
        response: {
          output: [{ ...reasoning, encrypted_content: 'terminal-ciphertext' }, message],
        },
      },
    ])
    const signature = output.findIndex((item) => item.data.delta?.type === 'signature_delta')
    const thinkingStop = output.findIndex((item) => item.event === 'content_block_stop' && item.data.index === 0)
    const textStart = output.findIndex((item) => item.data.content_block?.type === 'text')
    expect(signature).toBeGreaterThan(-1)
    expect(output[signature].data.delta.signature).toBe('terminal-ciphertext')
    expect(signature).toBeLessThan(thinkingStop)
    expect(thinkingStop).toBeLessThan(textStart)
    expect(output.filter((item) => item.event === 'error')).toEqual([])
  })

  it('emits an error for missing terminal events and max_tokens for a budget stop', () => {
    const state = createClaudeFromResponsesStreamState()
    expect(finishClaudeFromResponsesStream(state).map((item) => item.event)).toEqual(['error'])
    expect(finishClaudeFromResponsesStream(state)).toEqual([])
    const response = {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'partial' }] }],
      usage: { input_tokens: 100, output_tokens: 10 },
    }
    const { output } = convertStream([{ type: 'response.incomplete', response }])
    expect(output.find((item) => item.event === 'message_delta').data.delta.stop_reason).toBe('max_tokens')
    expect(convertResponsesResultToClaudeMessage(response).stop_reason).toBe('max_tokens')
  })

  it('keeps tool images as media and preserves document payloads', () => {
    const request = convertClaudeRequestToResponses({
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_A',
              content: [
                { type: 'text', text: 'image follows' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
              ],
            },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' } },
          ],
        },
      ],
    })
    expect(request.parallel_tool_calls).toBe(false)
    expect(request.input[0].output).toEqual([
      { type: 'input_text', text: 'image follows' },
      { type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
    ])
    expect(request.input[1].content[0]).toMatchObject({
      type: 'input_file',
      file_data: 'data:application/pdf;base64,cGRm',
    })
  })
})
