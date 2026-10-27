import {
  interactionToGenerateContent,
  generateContentToInteraction,
  createInteractionStreamState,
  generateContentToInteractionEvents,
  finishInteractionStream
} from '../src/modules/relay/relay_interactions_protocol.js'

const response = (finishReason, parts = [{ text: '中文' }]) => ({
  candidates: [{ finishReason, content: { parts } }],
  usageMetadata: {
    promptTokenCount: 10,
    cachedContentTokenCount: 4,
    candidatesTokenCount: 2,
    thoughtsTokenCount: 3,
    totalTokenCount: 15
  }
})

it('keeps official text, media and explicit zero/false values', () => {
  expect(interactionToGenerateContent({ model: 'gemini-test', input: 'Hello', store: false }).request.contents).toEqual(
    [{ role: 'user', parts: [{ text: 'Hello' }] }]
  )
  const body = interactionToGenerateContent({
    input: [
      { type: 'text', text: 'look' },
      { type: 'image', data: 'YWJj', mime_type: 'image/png' }
    ],
    generation_config: { temperature: 0, top_p: 0, max_output_tokens: 1, thinking_summaries: 'none' }
  })
  expect(body.request.contents[0].parts).toEqual([
    { text: 'look' },
    { inlineData: { mimeType: 'image/png', data: 'YWJj' } }
  ])
  expect(body.request.generationConfig).toMatchObject({
    temperature: 0,
    topP: 0,
    maxOutputTokens: 1,
    thinkingConfig: { includeThoughts: false }
  })
})

it('matches function results by official call_id and preserves a false result', () => {
  const result = interactionToGenerateContent({
    input: [
      { type: 'function_call', id: 'call-1', name: 'lookup', arguments: {} },
      { type: 'function_result', call_id: 'call-1', result: false, is_error: false }
    ]
  })
  expect(result.request.contents[1].parts[0].functionResponse).toEqual({
    id: 'call-1',
    name: 'lookup',
    response: { output: false, is_error: false }
  })
})

it.each(['auto', 'any', 'none', 'validated'])('maps the official allowed_tools object with mode %s', (mode) => {
  const result = interactionToGenerateContent({
    input: 'hello',
    tools: [
      { type: 'function', name: 'lookup', parameters: { type: 'object' } },
      { type: 'function', name: 'other', parameters: { type: 'object' } }
    ],
    generation_config: { tool_choice: { allowed_tools: { mode, tools: ['lookup'] } } }
  })
  expect(result.request.toolConfig).toEqual({
    functionCallingConfig: { mode: mode.toUpperCase(), allowedFunctionNames: ['lookup'] }
  })
})

it('preserves string tool modes and an empty official tool choice', () => {
  expect(
    interactionToGenerateContent({ input: 'hello', generation_config: { tool_choice: 'none' } }).request.toolConfig
  ).toEqual({ functionCallingConfig: { mode: 'NONE' } })
  expect(
    interactionToGenerateContent({ input: 'hello', generation_config: { tool_choice: {} } }).request.toolConfig
  ).toEqual({ functionCallingConfig: {} })
})

it('rejects a server tool allowlist that OAuth cannot enforce', () => {
  expect(() =>
    interactionToGenerateContent({
      input: 'hello',
      tools: [{ type: 'google_search' }],
      generation_config: { tool_choice: { allowed_tools: { mode: 'any', tools: ['google_search'] } } }
    })
  ).toThrow(/native/)
})

it.each(['hate_speech', 'dangerous_content', 'harassment', 'sexually_explicit', 'jailbreak'])(
  'maps official safety category %s and preserves its probability threshold',
  (type) => {
    const result = interactionToGenerateContent({
      input: 'hello',
      safety_settings: [{ type, threshold: 'off', method: 'probability' }]
    })
    expect(result.request.safetySettings).toEqual([
      { category: `HARM_CATEGORY_${type.toUpperCase()}`, threshold: 'OFF' }
    ])
  }
)

it.each(['block_low_and_above', 'block_medium_and_above', 'block_only_high'])(
  'maps safety threshold %s without weakening it',
  (threshold) => {
    const result = interactionToGenerateContent({
      input: 'hello',
      safety_settings: [{ type: 'harassment', threshold }]
    })
    expect(result.request.safetySettings[0].threshold).toBe(threshold.toUpperCase())
  }
)

it('rejects an unrepresentable safety method instead of silently ignoring it', () => {
  expect(() =>
    interactionToGenerateContent({
      input: 'hello',
      safety_settings: [{ type: 'harassment', threshold: 'block_only_high', method: 'severity' }]
    })
  ).toThrow(/native/)
})

it.each([
  { previous_interaction_id: 'other' },
  { store: true },
  { background: true },
  { agent: 'agent' },
  { continuation_token: 'opaque' },
  { webhook_config: { uris: [] } },
  { environment: 'env' }
])('rejects unavailable OAuth state before any forwarding: %j', (extra) => {
  expect(() => interactionToGenerateContent({ input: 'hello', ...extra })).toThrow(/native|stateless/)
})

it.each([
  ['STOP', 'completed'],
  ['MAX_TOKENS', 'incomplete'],
  ['SAFETY', 'failed'],
  [undefined, 'incomplete']
])('maps finish reason %s to %s without inventing completion', (reason, expected) => {
  const converted = generateContentToInteraction(response(reason), { model: 'gemini-test' })
  expect(converted.status).toBe(expected)
  expect(converted.steps).toEqual([{ type: 'model_output', content: [{ type: 'text', text: '中文' }] }])
  expect(converted).not.toHaveProperty('output')
  expect(converted.usage).toEqual({
    total_input_tokens: 10,
    total_cached_tokens: 4,
    total_output_tokens: 2,
    total_thought_tokens: 3,
    total_tokens: 15,
    total_tool_use_tokens: 0
  })
})

it('marks a complete tool call as requiring action', () => {
  expect(
    generateContentToInteraction(response('STOP', [{ functionCall: { id: 'c1', name: 'lookup', args: {} } }])).status
  ).toBe('requires_action')
})

it('closes every streaming step and retains interleaved thought/tool/text content', () => {
  const state = createInteractionStreamState({ model: 'gemini-test' })
  const events = [
    response(undefined, [{ thought: true, text: 'summary', thoughtSignature: 'signature' }]),
    response(undefined, [{ text: 'first' }]),
    response(undefined, [{ text: ' second' }]),
    response('STOP', [{ functionCall: { id: 'c1', name: 'lookup', args: { n: 0 } } }])
  ].flatMap((chunk) => generateContentToInteractionEvents(chunk, state))
  expect(events.filter((x) => x.event_type === 'step.start').map((x) => x.index)).toEqual(
    events.filter((x) => x.event_type === 'step.stop').map((x) => x.index)
  )
  const final = events.at(-1).interaction
  expect(final.status).toBe('requires_action')
  expect(final.steps[1].content[0].text).toBe('first second')
  expect(final.steps[0].signature).toBe('signature')
  expect(finishInteractionStream(state)).toEqual([])
})

it('never converts an upstream error or EOF into successful completion', () => {
  const state = createInteractionStreamState()
  const events = generateContentToInteractionEvents({ error: { code: 500, message: 'failed' } }, state)
  expect(events.map((x) => x.event_type)).toEqual(['error'])
  expect(finishInteractionStream(state)).toEqual([])
  const truncated = createInteractionStreamState()
  generateContentToInteractionEvents(response(undefined), truncated)
  const tail = finishInteractionStream(truncated)
  expect(tail.at(-1)).toMatchObject({ event_type: 'error', error: { code: 'upstream_stream_incomplete' } })
  expect(tail.some((x) => x.event_type === 'interaction.completed')).toBe(false)
})
