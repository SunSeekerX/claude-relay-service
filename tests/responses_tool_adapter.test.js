import { expect, test } from '@jest/globals'
import { adaptResponsesTools, requiresResponsesToolAdapter } from '../src/modules/relay/relay_responses_tools.js'

test('promotes Codex Lite input carriers while preserving schemas, history, and client tool names', () => {
  const parameters = {
    type: 'object',
    properties: { additional_tools: { type: 'boolean', default: false } },
    additionalProperties: false,
  }
  const source = {
    model: 'grok-4.7',
    tools: [{ type: 'function', name: 'existing', parameters: {} }],
    input: [
      { type: 'message', role: 'user', content: 'keep additional_tools in text' },
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          { type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read', parameters, strict: false }] },
        ],
      },
      {
        type: 'function_call',
        namespace: 'files',
        name: 'read',
        call_id: 'call1',
        arguments: '{"additional_tools":false}',
      },
      { type: 'function_call_output', call_id: 'call1', output: 'unchanged' },
      { type: 'reasoning', encrypted_content: 'opaque' },
    ],
  }
  const original = structuredClone(source)
  expect(requiresResponsesToolAdapter(source)).toBe(true)
  const adapter = adaptResponsesTools(source)
  expect(adapter.body.tools.map((tool) => tool.name)).toEqual(['existing', 'files__read'])
  expect(adapter.body.tools[1]).toMatchObject({ parameters, strict: false })
  expect(adapter.body.input.map((item) => item.type)).toEqual([
    'message',
    'function_call',
    'function_call_output',
    'reasoning',
  ])
  expect(adapter.body.input[2]).toEqual(source.input[3])
  expect(adapter.body.input[3]).toEqual(source.input[4])
  expect(adapter.restoreItem({ ...adapter.body.input[1], id: 'fc1' })).toMatchObject(source.input[2])
  expect(source).toEqual(original)
})

test('handles empty carriers and rejects malformed carrier tool arrays', () => {
  expect(requiresResponsesToolAdapter({ input: [{ type: 'additional_tools', tools: [] }] })).toBe(true)
  expect(adaptResponsesTools({ input: [{ type: 'additional_tools', tools: [] }] }).body.input).toEqual([])
  expect(() => adaptResponsesTools({ input: [{ type: 'additional_tools', tools: {} }] })).toThrow('tools array')
})

test('flattens namespace definitions and replay calls and restores the identical client identity', () => {
  const source = {
    tools: [
      {
        type: 'namespace',
        name: 'mcp_fs',
        tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }]
      }
    ],
    input: [
      { type: 'function_call', namespace: 'mcp_fs', name: 'read', call_id: 'c', arguments: '{}' }
    ]
  }
  const adapter = adaptResponsesTools(source)
  expect(adapter.body.tools[0]).toMatchObject({ type: 'function', name: 'mcp_fs__read' })
  expect(adapter.body.input[0].namespace).toBeUndefined()
  expect(adapter.restoreItem({ ...adapter.body.input[0], id: 'fc_1' })).toMatchObject(
    source.input[0]
  )
  expect(source.tools[0].type).toBe('namespace')
})
test('rejects collisions instead of silently dropping tools', () => {
  expect(() =>
    adaptResponsesTools({
      tools: [
        { type: 'function', name: 'a__b' },
        { type: 'namespace', name: 'a', tools: [{ type: 'function', name: 'b' }] }
      ]
    })
  ).toThrow('collide')
})
test('client search loads discovered tools and restores a search call', () => {
  const adapter = adaptResponsesTools({
    tools: [{ type: 'tool_search', execution: 'client' }],
    input: [
      {
        type: 'tool_search_output',
        call_id: 'search1',
        execution: 'client',
        tools: [{ type: 'function', name: 'found', parameters: {} }]
      }
    ]
  })
  expect(adapter.body.tools.map((tool) => tool.name)).toEqual(['_crs_tool_search', 'found'])
  expect(adapter.body.input[0]).toMatchObject({ type: 'function_call_output', call_id: 'search1' })
  expect(
    adapter.restoreItem({
      type: 'function_call',
      call_id: 'search2',
      name: '_crs_tool_search',
      arguments: '{"query":"files"}'
    })
  ).toMatchObject({ type: 'tool_search_call', execution: 'client', arguments: { query: 'files' } })
})
test('custom tool streaming unwraps JSON input once with strictly increasing sequence numbers', () => {
  const adapter = adaptResponsesTools({ tools: [{ type: 'custom', name: 'patch' }] })
  const events = [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc1', call_id: 'c', name: 'patch', arguments: '' }
    },
    { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"input":' },
    {
      type: 'response.function_call_arguments.done',
      item_id: 'fc1',
      arguments: '{"input":"a\\nb"}'
    },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', id: 'fc1', name: 'patch', arguments: '{"input":"a\\nb"}' }
    }
  ].flatMap((event) => adapter.restoreEvent(event))
  expect(
    events
      .filter((event) => event.type === 'response.custom_tool_call_input.delta')
      .map((event) => event.delta)
  ).toEqual(['a\nb'])
  expect(events.map((event) => event.sequence_number)).toEqual([0, 1, 2, 3])
  expect(events.at(-1).item).toMatchObject({
    type: 'custom_tool_call',
    name: 'patch',
    input: 'a\nb'
  })
})
