import { jest } from '@jest/globals'
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: new Proxy({}, { get: () => jest.fn() }) }))
const { convertResponsesRequestToClaude, convertClaudeRequestToResponses } =
  await import('../src/modules/relay/translator/relay_translator_claude_responses.js')
const { convertResponsesToInteractions, convertInteractionsToOpenAIChat } =
  await import('../src/modules/relay/translator/relay_translator_interactions.js')

it('uses the shared namespace/custom-tool adapter and keeps declaration, call and choice names consistent', () => {
  const result = convertResponsesRequestToClaude({
    model: 'claude-test',
    tools: [{ type: 'namespace', name: 'files', tools: [{ type: 'custom', name: 'patch' }] }],
    tool_choice: { type: 'custom', namespace: 'files', name: 'patch' },
    input: [
      { type: 'message', role: 'user', content: 'patch it' },
      { type: 'custom_tool_call', namespace: 'files', name: 'patch', call_id: 'call-1', input: 'raw patch text' },
      { type: 'custom_tool_call_output', call_id: 'call-1', output: 'done' }
    ]
  })
  const tool = result.tools[0]
  expect(tool.input_schema.properties.input.type).toBe('string')
  expect(result.messages[1].content[0]).toMatchObject({
    type: 'tool_use',
    id: 'call-1',
    name: tool.name,
    input: { input: 'raw patch text' }
  })
  expect(result.tool_choice.name).toBe(tool.name)
  expect(result.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-1', content: 'done' })
})

it('keeps visible reasoning summaries and never copies provider ciphertext into Claude signatures', () => {
  const result = convertResponsesRequestToClaude({
    model: 'claude-test',
    input: [
      { type: 'reasoning', encrypted_content: 'openai-only', summary: [{ text: 'visible summary' }] },
      { type: 'message', role: 'user', content: 'continue' }
    ]
  })
  expect(JSON.stringify(result)).toContain('visible summary')
  expect(JSON.stringify(result)).not.toContain('openai-only')
  expect(JSON.stringify(result)).not.toContain('signature')
  const inverse = convertClaudeRequestToResponses({
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'visible summary', signature: 'claude-only' }] }
    ]
  })
  expect(JSON.stringify(inverse)).not.toContain('claude-only')
  expect(JSON.stringify(inverse)).toContain('visible summary')
})

it.each(['compaction', 'agent_message'])('rejects unreadable %s instead of executing without its context', (type) => {
  const body = { model: 'claude-test', input: [{ type, encrypted_content: 'private', role: 'user' }] }
  expect(() => convertResponsesRequestToClaude(body)).toThrow(/cannot be recovered/)
  expect(() => convertResponsesToInteractions(body)).toThrow(/cannot be recovered/)
})

it('keeps files and images in tool results and rejects provider-scoped file references', () => {
  const result = convertResponsesRequestToClaude({
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_file', file_data: 'data:application/pdf;base64,cGRm' }]
      },
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,YWJj' }]
      }
    ]
  })
  expect(result.messages[0].content[0]).toMatchObject({
    type: 'document',
    source: { media_type: 'application/pdf', data: 'cGRm' }
  })
  expect(result.messages[1].content[0].content[0]).toMatchObject({ type: 'image', source: { data: 'YWJj' } })
  expect(() =>
    convertResponsesRequestToClaude({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'file-private' }] }]
    })
  ).toThrow(/provider-scoped/)
})

it('recovers a visible compaction summary and preserves official Interactions function result identity', () => {
  const converted = convertResponsesToInteractions({
    input: [
      { type: 'compaction', content: [{ text: 'summary' }] },
      { type: 'function_call_output', call_id: 'call-1', output: false }
    ]
  })
  expect(converted.input[0]).toMatchObject({ type: 'user_input', content: [{ type: 'text', text: 'summary' }] })
  expect(converted.input[1]).toEqual({ type: 'function_result', call_id: 'call-1', result: false })
  expect(convertInteractionsToOpenAIChat({ input: [converted.input[1]] }).messages[0]).toMatchObject({
    role: 'tool',
    tool_call_id: 'call-1',
    content: 'false'
  })
})
