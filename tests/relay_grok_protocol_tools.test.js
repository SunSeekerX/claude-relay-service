import {
  normalizeToolsForResponses,
  chatToResponsesBody,
  isChatBridgeEligible,
} from '../src/modules/relay/relay_grok_protocol.js'

describe('normalizeToolsForResponses', () => {
  it('flattens chat function tools to responses top-level name', () => {
    const tools = normalizeToolsForResponses([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'd',
          parameters: { type: 'object' },
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'lookup',
        description: 'd',
        parameters: { type: 'object' },
        strict: undefined,
      },
    ])
    expect(tools[0].function).toBeUndefined()
  })

  it('keeps already-flat responses tools', () => {
    const tools = normalizeToolsForResponses([
      { type: 'function', name: 'lookup', description: 'd', parameters: { type: 'object' } },
    ])
    expect(tools[0]).toMatchObject({ type: 'function', name: 'lookup' })
  })

  it('preserves web_search and x_search', () => {
    const tools = normalizeToolsForResponses([{ type: 'web_search' }, { type: 'x_search' }])
    expect(tools).toEqual([{ type: 'web_search' }, { type: 'x_search' }])
  })

  it('drops function tools missing name to avoid upstream 422', () => {
    const tools = normalizeToolsForResponses([
      { type: 'function', function: { description: 'no name' } },
      { type: 'function', function: { name: 123 } },
      { type: 'function', function: { name: '   ' } },
      { type: 'function', function: { name: 'ok' } },
    ])
    expect(tools).toEqual([
      {
        type: 'function',
        name: 'ok',
        description: undefined,
        parameters: undefined,
        strict: undefined,
      },
    ])
  })

  it('accepts responses-shaped tools in bridge eligibility', () => {
    const req = {
      model: 'grok-4',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    }
    expect(isChatBridgeEligible(req).ok).toBe(true)
    const mapped = chatToResponsesBody(req)
    expect(mapped.tools[0].name).toBe('lookup')
  })

  it('rejects non-string tool names in eligibility', () => {
    expect(
      isChatBridgeEligible({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 1 } }],
      }).ok,
    ).toBe(false)
  })
})

describe('chatToResponsesBody tools', () => {
  it('omits tools when all entries are invalid', () => {
    const body = chatToResponsesBody({
      model: 'grok-4',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: {} }],
    })
    expect(body.tools).toBeUndefined()
  })

  it('still marks chat body with valid tools as bridge eligible', () => {
    const req = {
      model: 'grok-4',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    }
    expect(isChatBridgeEligible(req).ok).toBe(true)
    const mapped = chatToResponsesBody(req)
    expect(mapped.tools[0].name).toBe('lookup')
  })
})
