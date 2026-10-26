import { expect, test } from '@jest/globals'
import { adaptResponsesTools } from '../src/modules/relay/relay_responses_tools.js'

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
