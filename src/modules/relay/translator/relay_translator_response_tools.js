import { adaptResponsesTools } from '../relay_responses_tools.js'

export const unsupportedReplay = (message) =>
  Object.assign(new Error(message), {
    statusCode: 400,
    code: 'unsupported_cross_provider_state'
  })

export const visibleReplayText = (item) => {
  const text = [
    typeof item.content === 'string' ? item.content : '',
    ...(Array.isArray(item.content) ? item.content.map((part) => part?.text ?? '') : []),
    ...(Array.isArray(item.summary) ? item.summary.map((part) => part?.text ?? '') : [])
  ]
    .filter(Boolean)
    .join('\n')
  if (['compaction', 'agent_message'].includes(item.type) && !text) {
    throw unsupportedReplay(
      'This encrypted task or compacted context cannot be recovered on another provider; use the original provider or start a new conversation'
    )
  }
  return text
}

const identity = (namespace, name) => JSON.stringify([namespace ?? '', name])

export const buildResponsesToolMap = (body) => {
  const adapter = adaptResponsesTools(body)
  const names = new Map()
  for (const [wire, entry] of adapter.names) {
    names.set(identity(entry.namespace, entry.name), wire)
    if (entry.type === 'tool_search') {
      names.set(identity('', 'tool_search'), wire)
    }
  }
  const tools = (adapter.body.tools ?? []).map((tool) => {
    if (tool.type !== 'function') {
      throw unsupportedReplay(`Tool ${tool.type} cannot execute on a Claude backend`)
    }
    return {
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.parameters ?? { type: 'object', properties: {} }
    }
  })
  return {
    tools,
    name: (name, namespace = '') => {
      const wire = names.get(identity(namespace, name))
      if (wire) {
        return wire
      }
      if (namespace) {
        throw unsupportedReplay('The namespaced tool was not declared or discovered')
      }
      return name
    }
  }
}
