import { describe, expect, test } from '@jest/globals'
import {
  buildResponsesProviderRequest,
  ProviderResponsesState
} from '../src/modules/relay/relay_responses_conversion.js'
import { adaptResponsesTools } from '../src/modules/relay/relay_responses_tools.js'
import { normalizeClaudeCodeToolsInRequest } from '../src/modules/relay/relay_claude_code_tool_schemas.js'
import { sanitizeClaudeBodyFallbacks } from '../src/modules/relay/translator/relay_translator_body_sanitize.js'
import { normalizeClaudeRequestForModel } from '../src/modules/relay/translator/relay_translator_thinking.js'

const usage = {
  promptTokenCount: 100,
  cachedContentTokenCount: 60,
  candidatesTokenCount: 7,
  thoughtsTokenCount: 3,
  totalTokenCount: 110
}
const makeState = () => new ProviderResponsesState('gemini', 'gemini-test', adaptResponsesTools({}))
const response = (finishReason) => ({
  candidates: [{ content: { parts: [{ text: 'visible output' }] }, finishReason }],
  usageMetadata: usage
})

describe('Claude tool history conversion', () => {
  test('native preprocessing keeps actual tool calls and results without empty text blocks', () => {
    const source = {
      model: 'claude-sonnet-test',
      tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: '' },
            { type: 'input_text', text: ' ' },
            { type: 'input_text', text: 'read a file' }
          ]
        },
        { type: 'function_call', call_id: 'call1', name: 'read', arguments: '{"path":"a"}' },
        { type: 'function_call_output', call_id: 'call1', output: 'done' },
        { type: 'function_call', call_id: 'call2', name: 'read', arguments: '{"path":"b"}' },
        { type: 'function_call_output', call_id: 'call2', output: '' }
      ]
    }
    const { request } = buildResponsesProviderRequest(source, 'claude')
    const native = normalizeClaudeCodeToolsInRequest(request)
    sanitizeClaudeBodyFallbacks(native, { vendor: 'console' })
    normalizeClaudeRequestForModel(native, native.model)
    expect(native.messages[0].content).toEqual([
      { type: 'text', text: ' ' },
      { type: 'text', text: 'read a file' }
    ])
    expect(native.messages[1].content).toEqual([
      { type: 'tool_use', id: 'call1', name: 'read', input: { path: 'a' } }
    ])
    expect(native.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'call1', content: [{ type: 'text', text: 'done' }] }
    ])
    expect(native.messages[3].content).toEqual([
      { type: 'tool_use', id: 'call2', name: 'read', input: { path: 'b' } }
    ])
    expect(native.messages[4].content).toEqual([
      { type: 'tool_result', tool_use_id: 'call2', content: [] }
    ])
    expect(JSON.stringify(native)).not.toContain('"text":""')
    expect(source.input[0].content[0].text).toBe('')
  })
})

describe('Gemini finish reasons', () => {
  test('STOP is a completed response with unchanged usage', () => {
    const state = makeState()
    state.fromMessage(response('STOP'))
    expect(state.finish().response).toMatchObject({
      status: 'completed',
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
    })
  })
  test('MAX_TOKENS retains partial output and reports an output limit', () => {
    const state = makeState()
    state.fromMessage(response('MAX_TOKENS'))
    expect(state.finish().response).toMatchObject({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ content: [{ text: 'visible output' }] }]
    })
  })
  test.each([
    'SAFETY',
    'RECITATION',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'MODEL_ARMOR',
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
    'IMAGE_RECITATION'
  ])('%s retains partial output and usage as filtered incomplete', (reason) => {
    const state = makeState()
    state.fromMessage(response(reason))
    const result = state.finish()
    expect(result.response).toMatchObject({
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      usage: { total_tokens: 110 },
      output: [{ content: [{ text: 'visible output' }] }]
    })
    expect(result.response.error).toBeUndefined()
    expect(result.events.at(-1).type).toBe('response.incomplete')
  })
  test.each([
    'MALFORMED_FUNCTION_CALL',
    'UNEXPECTED_TOOL_CALL',
    'OTHER',
    'LANGUAGE',
    'NO_IMAGE',
    'IMAGE_OTHER',
    'FINISH_REASON_UNSPECIFIED',
    'NEW_UNKNOWN_REASON'
  ])('%s can never produce a successful terminal response', (reason) => {
    const state = makeState()
    state.fromMessage(response(reason))
    const result = state.finish()
    expect(result.response).toMatchObject({
      status: 'failed',
      error: { message: 'Provider response failed' },
      usage: { total_tokens: 110 },
      output: [{ content: [{ text: 'visible output' }] }]
    })
    expect(result.response.incomplete_details).toBeUndefined()
    expect(result.events.at(-1).type).toBe('response.failed')
    expect(result.events.some((event) => event.type === 'response.completed')).toBe(false)
  })
  test('prompt filtering retains content even without a candidate finishReason', () => {
    const state = makeState()
    state.observe({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] })
    state.observe({ promptFeedback: { blockReason: 'MODEL_ARMOR' }, usageMetadata: usage })
    expect(state.finish().response).toMatchObject({
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [{ content: [{ text: 'partial' }] }],
      usage: { total_tokens: 110 }
    })
  })
  test('an unspecified prompt blockReason does not override a normal STOP', () => {
    const state = makeState()
    state.fromMessage({
      ...response('STOP'),
      promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' }
    })
    expect(state.finish().response.status).toBe('completed')
  })
  test('EOF without a finishReason remains a failure', () => {
    const state = makeState()
    state.observe({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] })
    expect(state.finish().response).toMatchObject({
      status: 'failed',
      error: { code: 'upstream_stream_incomplete' }
    })
  })
})

describe('Gemini ordered content conversion', () => {
  test('merges only adjacent text of the same kind across chunks and preserves tool boundaries', () => {
    const state = makeState()
    const events = state.start()
    const chunks = [
      [{ text: 'before ' }],
      [{ text: 'tool' }],
      [{ functionCall: { id: 'call1', name: 'read', args: { path: 'a' } } }],
      [{ text: 'after tool' }],
      [{ thought: true, text: 'thought ' }],
      [{ thought: true, text: 'continuation' }],
      [{ text: 'answer' }]
    ]
    for (const parts of chunks) {
      events.push(...state.observe({ candidates: [{ content: { parts } }] }))
    }
    events.push(...state.observe({ candidates: [{ finishReason: 'STOP' }], usageMetadata: usage }))
    const result = state.finish()
    events.push(...result.events)
    expect(result.response.output).toMatchObject([
      { type: 'message', content: [{ text: 'before tool' }] },
      { type: 'function_call', call_id: 'call1', name: 'read', arguments: '{"path":"a"}' },
      { type: 'message', content: [{ text: 'after tool' }] },
      { type: 'reasoning', summary: [{ text: 'thought continuation' }] },
      { type: 'message', content: [{ text: 'answer' }] }
    ])
    expect(new Set(result.response.output.map((item) => item.id)).size).toBe(5)
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index))
    expect(
      events
        .filter((event) => event.type === 'response.output_item.done')
        .map((event) => event.output_index)
    ).toEqual([0, 1, 2, 3, 4])
    for (const event of events.filter((item) => item.type === 'response.output_item.done')) {
      expect(event.item).toEqual(result.response.output[event.output_index])
    }
  })
  test('one-shot JSON uses the same part order as streaming', () => {
    const state = makeState()
    state.fromMessage({
      candidates: [
        {
          content: {
            parts: [
              { text: 'A' },
              { functionCall: { id: 'call1', name: 'read', args: {} } },
              { text: 'B' }
            ]
          },
          finishReason: 'STOP'
        }
      ]
    })
    expect(state.finish().response.output).toMatchObject([
      { content: [{ text: 'A' }] },
      { type: 'function_call', name: 'read' },
      { content: [{ text: 'B' }] }
    ])
  })
})
