import crypto from 'node:crypto'

const invalid = (message) =>
  Object.assign(new Error(message), { statusCode: 400, code: 'unsupported_tool' })
const identity = (namespace, name) => JSON.stringify([namespace ?? '', name])
const flatName = (namespace, name) => {
  if (typeof name !== 'string' || !name) {
    throw invalid('Tool name is required')
  }
  const full = namespace ? `${namespace}__${name}` : name
  const safe = full.replace(/[^a-zA-Z0-9_-]/g, '_')
  return safe === full && safe.length <= 64
    ? safe
    : `${safe.slice(0, 43)}_${crypto.createHash('sha256').update(full).digest('hex').slice(0, 20)}`
}

export const requiresResponsesToolAdapter = (body) =>
  ['tools', 'additional_tools'].some(
    (field) => body[field] !== undefined && !Array.isArray(body[field])
  ) ||
  body.additional_tools?.length > 0 ||
  body.tools?.some((tool) => ['namespace', 'tool_search', 'custom'].includes(tool.type)) ||
  body.input?.some?.(
    (item) =>
      item?.namespace ||
      [
        'tool_search_call',
        'tool_search_output',
        'additional_tools',
        'custom_tool_call',
        'custom_tool_call_output'
      ].includes(item?.type),
  )

export const adaptResponsesTools = (source) => {
  for (const field of ['tools', 'additional_tools']) {
    if (source[field] !== undefined && !Array.isArray(source[field])) {
      throw invalid(`${field} must be an array`)
    }
  }
  const names = new Map()
  const declared = new Set()
  const tools = []
  const add = (tool, namespace = null) => {
    if (!tool || typeof tool !== 'object') {
      throw invalid('Tool definitions must be objects')
    }
    if (tool.type === 'namespace') {
      for (const child of tool.tools ?? tool.children ?? []) {
        add(child, tool.name)
      }
      return
    }
    if (!['function', 'custom', 'tool_search'].includes(tool.type)) {
      tools.push(tool)
      return
    }
    if (tool.type === 'tool_search' && tool.execution !== 'client') {
      throw invalid('This target supports client-executed tool search only')
    }
    if (tool.type === 'custom' && tool.format?.type === 'grammar') {
      throw invalid('This target cannot enforce a custom tool grammar')
    }
    const original = tool.type === 'tool_search' ? '_crs_tool_search' : tool.name
    if (typeof original !== 'string' || !original) {
      throw invalid('Tool name is required')
    }
    const wire = flatName(namespace, original)
    const entry = { namespace, name: original, type: tool.type }
    if (
      names.has(wire) &&
      identity(names.get(wire).namespace, names.get(wire).name) !== identity(namespace, original)
    ) {
      throw invalid('Tool names collide after namespace conversion')
    }
    if (names.has(wire) && names.get(wire).type !== entry.type) {
      throw invalid('Conflicting tool declarations')
    }
    names.set(wire, entry)
    if (declared.has(wire)) {
      return
    }
    declared.add(wire)
    const parameters =
      tool.type === 'custom'
        ? {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
            additionalProperties: false
          }
        : tool.type === 'tool_search'
          ? (tool.parameters ?? {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query']
            })
          : tool.parameters
    tools.push({
      ...tool,
      type: 'function',
      name: wire,
      parameters,
      execution: undefined,
      format: undefined
    })
  }
  for (const tool of source.tools ?? []) {
    add(tool)
  }
  for (const tool of source.additional_tools ?? []) {
    add(tool)
  }
  const { input } = source
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type === 'additional_tools') {
      if (!Array.isArray(item.tools)) {
        throw invalid('additional_tools input must contain a tools array')
      }
      for (const tool of item.tools) {
        add(tool)
      }
    } else if (item?.type === 'tool_search_output') {
      for (const tool of item.tools ?? []) {
        add(tool)
      }
    }
  }
  const rewrite = (item) => {
    if (!item || typeof item !== 'object') {
      return item
    }
    if (item.type === 'tool_search_call') {
      if (item.execution && item.execution !== 'client') {
        throw invalid('Server tool search history cannot be replayed to this target')
      }
      return {
        type: 'function_call',
        call_id: item.call_id ?? item.id,
        name: '_crs_tool_search',
        arguments: JSON.stringify(item.arguments ?? {})
      }
    }
    if (item.type === 'tool_search_output') {
      return {
        type: 'function_call_output',
        call_id: item.call_id,
        output: JSON.stringify({ tools: item.tools ?? [] })
      }
    }
    if (item.type === 'custom_tool_call_output') {
      return { ...item, type: 'function_call_output' }
    }
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const wire = flatName(item.namespace, item.name)
      if (!names.has(wire)) {
        names.set(wire, {
          name: item.name,
          namespace: item.namespace,
          type: item.type === 'custom_tool_call' ? 'custom' : 'function'
        })
      }
      const result = { ...item, type: 'function_call', name: wire }
      delete result.namespace
      if (item.type === 'custom_tool_call') {
        result.arguments = JSON.stringify({ input: item.input ?? '' })
        delete result.input
      }
      return result
    }
    return item
  }
  const body = { ...source }
  delete body.additional_tools
  if (source.tools || tools.length) {
    body.tools = tools
  }
  if (Array.isArray(input)) {
    body.input = input.filter((item) => item?.type !== 'additional_tools').map(rewrite)
  }
  const choice = source.tool_choice
  if (choice?.type === 'function' || choice?.type === 'custom') {
    body.tool_choice = {
      type: 'function',
      name: flatName(choice.namespace, choice.name ?? choice.function?.name)
    }
  } else if (choice?.type === 'namespace') {
    body.tools = tools.filter((tool) => names.get(tool.name)?.namespace === choice.name)
    if (body.tools.length === 0) {
      throw invalid('Selected tool namespace is unavailable')
    }
    body.tool_choice = 'required'
  }
  const restoreItem = (item) => {
    if (item?.type !== 'function_call') {
      return item
    }
    const entry = names.get(item.name)
    if (!entry) {
      return item
    }
    const result = {
      ...item,
      name: entry.name,
      ...(entry.namespace ? { namespace: entry.namespace } : {})
    }
    if (entry.type === 'custom') {
      result.type = 'custom_tool_call'
      result.input = item.arguments ? (JSON.parse(item.arguments).input ?? '') : ''
      delete result.arguments
    } else if (entry.type === 'tool_search') {
      result.type = 'tool_search_call'
      result.execution = 'client'
      result.arguments = item.arguments ? JSON.parse(item.arguments) : {}
      delete result.name
    }
    return result
  }
  const restoreResponse = (response) => ({
    ...response,
    ...(Array.isArray(response.output) ? { output: response.output.map(restoreItem) } : {})
  })
  const streamItems = new Map()
  const restoreFrame = (event) => {
    const output = []
    const key = event.item_id ?? event.item?.id ?? `index:${event.output_index}`
    if (event.type === 'response.output_item.added') {
      streamItems.set(key, event.item)
      if (event.output_index !== undefined) {
        streamItems.set(`index:${event.output_index}`, event.item)
      }
    }
    const item = event.item ?? streamItems.get(key)
    const entry = names.get(item?.name)
    if (
      entry &&
      ['custom', 'tool_search'].includes(entry.type) &&
      event.type === 'response.function_call_arguments.delta'
    ) {
      return []
    }
    if (
      entry &&
      ['custom', 'tool_search'].includes(entry.type) &&
      event.type === 'response.function_call_arguments.done'
    ) {
      const restored = restoreItem({ ...item, arguments: event.arguments })
      if (entry.type === 'custom') {
        const { arguments: _arguments, ...fields } = event
        output.push({
          ...fields,
          type: 'response.custom_tool_call_input.delta',
          delta: restored.input
        })
        output.push({
          ...fields,
          type: 'response.custom_tool_call_input.done',
          input: restored.input
        })
      }
      return output
    }
    return [
      {
        ...event,
        ...(event.item ? { item: restoreItem(event.item) } : {}),
        ...(event.response ? { response: restoreResponse(event.response) } : {})
      }
    ]
  }
  let streamSequence = 0
  const restoreEvent = (event) =>
    restoreFrame(event).map((output) => ({ ...output, sequence_number: streamSequence++ }))
  return { body, names, restoreItem, restoreResponse, restoreEvent }
}
