import { describe, expect, it } from '@jest/globals'
import {
  convertResponsesResultToClaudeMessage,
  createClaudeFromResponsesStreamState,
  convertResponsesStreamEventToClaude,
} from '../src/modules/relay/translator/relay_translator_claude_responses.js'
import { buildClientError } from '../src/common/client_error_builder.js'

const message = {
  type: 'message',
  id: 'message',
  content: [{ type: 'refusal', refusal: 'Cannot help with this request.' }],
}
const response = {
  id: 'response',
  model: 'fixture',
  status: 'completed',
  output: [message],
  usage: { input_tokens: 10, output_tokens: 8 },
}
const deltaText = (events) =>
  events
    .filter((event) => event.data.delta?.type === 'text_delta')
    .map((event) => event.data.delta.text)
    .join('')

describe('Responses refusal survives Claude response conversion', () => {
  it('preserves nonstream refusal text, stop reason and reported usage', () => {
    expect(convertResponsesResultToClaudeMessage(response)).toMatchObject({
      content: [{ type: 'text', text: 'Cannot help with this request.' }],
      stop_reason: 'refusal',
      usage: { input_tokens: 10, output_tokens: 8 },
    })
  })

  it.each(['delta', 'done', 'terminal'])('emits a refusal reported through %s exactly once', (kind) => {
    const events = [{ type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } }]
    if (kind === 'delta') {
      events.push(
        { type: 'response.refusal.delta', item_id: 'message', delta: 'Cannot help ' },
        { type: 'response.refusal.delta', item_id: 'message', delta: 'with this request.' },
      )
    }
    if (kind !== 'terminal') {
      events.push({ type: 'response.refusal.done', item_id: 'message', refusal: message.content[0].refusal })
    }
    events.push(
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response },
    )
    const state = createClaudeFromResponsesStreamState()
    const output = events.flatMap((event) => convertResponsesStreamEventToClaude(event, state))
    expect(deltaText(output)).toBe('Cannot help with this request.')
    expect(output.filter((event) => event.event === 'content_block_start')).toHaveLength(1)
    expect(output.filter((event) => event.event === 'content_block_stop')).toHaveLength(1)
    expect(output.find((event) => event.event === 'message_delta').data.delta.stop_reason).toBe('refusal')
    expect(output.filter((event) => event.event === 'message_stop')).toHaveLength(1)
    expect(output.filter((event) => event.event === 'error')).toEqual([])
    expect(convertResponsesStreamEventToClaude({ type: 'response.completed', response }, state)).toEqual([])
  })

  it('retains mixed visible text and refusal without changing normal completion', () => {
    const mixed = { ...message, content: [{ type: 'output_text', text: 'Visible. ' }, message.content[0]] }
    const state = createClaudeFromResponsesStreamState()
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      { type: 'response.output_text.delta', item_id: 'message', delta: 'Visible. ' },
      { type: 'response.refusal.delta', item_id: 'message', delta: message.content[0].refusal },
      { type: 'response.refusal.done', item_id: 'message', refusal: message.content[0].refusal },
      { type: 'response.completed', response: { ...response, output: [mixed] } },
    ].flatMap((event) => convertResponsesStreamEventToClaude(event, state))
    expect(deltaText(events)).toBe('Visible. Cannot help with this request.')
    expect(events.filter((event) => event.event === 'error')).toEqual([])
    expect(
      convertResponsesResultToClaudeMessage({
        ...response,
        output: [{ ...message, content: [{ type: 'output_text', text: 'Normal.' }] }],
      }).stop_reason,
    ).toBe('end_turn')
  })
})

describe('public request error codes retain client recovery semantics', () => {
  it.each(['invalid_image', 'invalid_encrypted_content', 'context_length_exceeded', 'previous_response_not_found'])(
    'preserves %s while sanitizing text',
    (code) => {
      const result = buildClientError({
        statusCode: 400,
        upstreamBody: {
          error: {
            code,
            param: 'input[0].content[1].image_url',
            message: 'bad input https://private.example/v1 [account/secret]',
          },
        },
      })
      expect(result.body.error).toEqual({
        type: 'invalid_request_error',
        code,
        param: 'input[0].content[1].image_url',
        message: 'bad input [upstream]',
      })
    },
  )

  it.each([401, 403, 429, 500])('keeps upstream credentials and request metadata hidden for %s', (statusCode) => {
    const result = buildClientError({
      statusCode,
      upstreamBody: {
        error: { code: 'invalid_image', param: 'input[0]', message: 'private account sk-ant-abcdefgh123456' },
      },
    })
    expect(result.body.error.code).not.toBe('invalid_image')
    expect(result.body.error.param).toBeNull()
    expect(result.body.error.message).not.toContain('private account')
  })

  it('does not expose arbitrary provider codes or credential-shaped parameter strings', () => {
    expect(
      buildClientError({ statusCode: 400, upstreamBody: { error: { code: 'sk-ant-privatecredentialvalue' } } }).body
        .error.code,
    ).toBe('invalid_request_error')
    const { body } = buildClientError({
      statusCode: 400,
      upstreamBody: { error: { code: 'invalid_image', param: 'Bearer sk-ant-abcdefgh123456' } },
    })
    expect(body.error.code).toBe('invalid_image')
    expect(body.error.param).toBeNull()
    expect(
      buildClientError({
        statusCode: 400,
        upstreamBody: { error: { code: 'invalid_image', param: 'AIza012345678901234567890123456789' } },
      }).body.error.param,
    ).toBeNull()
    expect(
      buildClientError({ statusCode: 400, protocol: 'anthropic', upstreamBody: { error: { code: 'invalid_image' } } })
        .body,
    ).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } })
    expect(
      buildClientError({ statusCode: 400, protocol: 'gemini', upstreamBody: { error: { code: 'invalid_image' } } }).body
        .error.code,
    ).toBe(400)
  })
})
