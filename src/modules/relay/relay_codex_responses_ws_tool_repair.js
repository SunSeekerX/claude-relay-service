// Responses WS/HTTP 工具调用修复
// - 补齐残缺 function_call 参数 JSON
// - 去掉空 name / 非法 call_id
// - 保证 function_call_output 能对上 call_id
// - 禁止改写 custom 工具；禁止向下游发送内部字段

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const safeJsonParse = (text) => {
  if (typeof text !== 'string' || !text.trim()) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const normalizeArguments = (args) => {
  if (args === null || args === undefined) {
    return '{}'
  }
  if (typeof args === 'object') {
    try {
      return JSON.stringify(args)
    } catch {
      return '{}'
    }
  }
  const text = String(args)
  const parsed = safeJsonParse(text)
  if (parsed !== null) {
    return JSON.stringify(parsed)
  }
  let candidate = text.trim()
  if (!candidate) {
    return '{}'
  }
  if (candidate.startsWith('{') && !candidate.endsWith('}')) {
    const open = (candidate.match(/\{/g) || []).length
    const close = (candidate.match(/\}/g) || []).length
    candidate += '}'.repeat(Math.max(0, open - close))
    const fixed = safeJsonParse(candidate)
    if (fixed !== null) {
      return JSON.stringify(fixed)
    }
  }
  return JSON.stringify({ _raw: text })
}

const normalizeFunctionCallItem = (item) => {
  if (!isPlainObject(item)) {
    return item
  }
  // 仅修标准 function_call / 兼容 tool_call；custom_tool_call 原样保留
  if (item.type === 'custom_tool_call' || item.type === 'custom') {
    return item
  }
  if (item.type !== 'function_call' && item.type !== 'tool_call') {
    return item
  }
  const next = { ...item, type: 'function_call' }
  if (!next.name || typeof next.name !== 'string') {
    return null
  }
  if (!next.call_id && next.id) {
    next.call_id = next.id
  }
  if (!next.call_id || typeof next.call_id !== 'string') {
    next.call_id = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }
  next.arguments = normalizeArguments(next.arguments ?? next.input ?? next.parameters)
  return next
}

const normalizeFunctionCallOutput = (item, _knownCallIds) => {
  if (!isPlainObject(item)) {
    return item
  }
  if (item.type !== 'function_call_output' && item.type !== 'tool_result') {
    return item
  }
  const next = { ...item, type: 'function_call_output' }
  if (!next.call_id && next.tool_call_id) {
    next.call_id = next.tool_call_id
  }
  if (!next.call_id || typeof next.call_id !== 'string') {
    return null
  }
  // 不匹配也不打内部字段——严格上游会拒 _crs_*
  if (next.output === undefined && next.content !== undefined) {
    next.output = typeof next.content === 'string' ? next.content : JSON.stringify(next.content)
  }
  if (next.output === undefined) {
    next.output = ''
  }
  if (typeof next.output !== 'string') {
    try {
      next.output = JSON.stringify(next.output)
    } catch {
      next.output = String(next.output)
    }
  }
  // 剥内部字段
  delete next._crs_unmatched_call
  return next
}

const repairInputItems = (items) => {
  if (!Array.isArray(items)) {
    return items
  }
  const knownCallIds = new Set()
  const out = []
  for (const item of items) {
    if (!isPlainObject(item)) {
      out.push(item)
      continue
    }
    // custom 工具整段原样
    if (item.type === 'custom_tool_call' || item.type === 'custom') {
      out.push(item)
      continue
    }
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const fixed = normalizeFunctionCallItem(item)
      if (!fixed) {
        continue
      }
      knownCallIds.add(fixed.call_id)
      out.push(fixed)
      continue
    }
    if (item.type === 'function_call_output' || item.type === 'tool_result') {
      const fixed = normalizeFunctionCallOutput(item, knownCallIds)
      if (!fixed) {
        continue
      }
      out.push(fixed)
      continue
    }
    out.push(item)
  }
  return out
}

// 修复 responses body 内 function_call / output；tools 定义不改写 custom
export const repairResponsesToolCallsInBody = (body) => {
  if (!isPlainObject(body)) {
    return body
  }
  const next = { ...body }
  if (Array.isArray(next.input)) {
    next.input = repairInputItems(next.input)
  }
  if (Array.isArray(next.tools)) {
    next.tools = next.tools
      .map((tool) => {
        if (!isPlainObject(tool)) {
          return null
        }
        // custom / freeform 工具：完整保留 grammar/format 等字段
        if (tool.type === 'custom' || tool.type === 'custom_tool') {
          return { ...tool }
        }
        // 仅规范化标准 function 工具
        if (tool.type === 'function' || (!tool.type && (tool.name || tool.function?.name))) {
          const name = tool.name || tool.function?.name
          if (!name) {
            return null
          }
          const parameters = tool.parameters ||
            tool.function?.parameters ||
            tool.input_schema || { type: 'object', properties: {} }
          const normalized = {
            type: 'function',
            name,
            description: tool.description || tool.function?.description || '',
            parameters: isPlainObject(parameters) ? parameters : { type: 'object', properties: {} },
          }
          // 保留其它未知官方字段（除已映射）
          for (const [key, value] of Object.entries(tool)) {
            if (['type', 'name', 'description', 'parameters', 'function', 'input_schema'].includes(key)) {
              continue
            }
            if (normalized[key] === undefined) {
              normalized[key] = value
            }
          }
          return normalized
        }
        // 其它类型原样
        return tool
      })
      .filter(Boolean)
  }
  return next
}
