import { openAIContentToGeminiParts } from './translator/relay_translator_gemini_parts.js'
import { ensureThoughtSignaturesOnContents } from './translator/relay_translator_gemini_signature.js'
import { buildGeminiGenerateBody } from './relay_gemini_request.js'
import { cleanJsonSchemaForGemini, convertAntigravityToolSchema } from './relay_gemini_schema_cleaner.js'

const invalidRequest = (message) => Object.assign(new Error(message), { status: 400, code: 'invalid_request' })

const contentParts = (content) => {
  if (content === undefined || content === null) {
    return []
  }
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    if (Array.isArray(content.parts)) {
      return content.parts
    }
    if (typeof content.text === 'string') {
      return [{ text: content.text }]
    }
  }
  return openAIContentToGeminiParts(content)
}

const functionArguments = (value) => {
  if (value === undefined || value === '') {
    return {}
  }
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw invalidRequest('Tool arguments must be valid JSON')
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidRequest('Tool arguments must be a JSON object')
  }
  return parsed
}

const toolResponse = (message, names) => {
  const name = names.get(message.tool_call_id) ?? message.name
  if (!name) {
    throw invalidRequest(`No matching function call for tool result ${message.tool_call_id ?? ''}`)
  }
  const parts = contentParts(message.content)
  const text = parts
    .filter((part) => part.text !== undefined)
    .map((part) => part.text)
    .join('')
  let output = text
  if (typeof message.content === 'string') {
    try {
      output = JSON.parse(message.content)
    } catch {
      // 普通工具文本仍以 output 字段保留。
    }
  }
  const media = parts.filter((part) => part.text === undefined)
  return {
    functionResponse: {
      name,
      ...(message.tool_call_id ? { id: message.tool_call_id } : {}),
      response: output && typeof output === 'object' && !Array.isArray(output) ? output : { output },
      ...(media.length ? { parts: media } : {}),
    },
  }
}

const convertMessages = (messages) => {
  const contents = []
  const systemParts = []
  const names = new Map()
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      systemParts.push(...contentParts(message.content))
    } else if (message.role === 'assistant') {
      const parts = contentParts(message.content)
      for (const call of message.tool_calls ?? []) {
        if (call.type !== 'function' || !call.function?.name) {
          throw invalidRequest('Gemini requires named function tool calls')
        }
        names.set(call.id, call.function.name)
        const signature = call.extra_content?.google?.thought_signature
        parts.push({
          functionCall: {
            name: call.function.name,
            args: functionArguments(call.function.arguments),
            ...(call.id ? { id: call.id } : {}),
          },
          ...(signature ? { thoughtSignature: signature } : {}),
        })
      }
      if (parts.length) {
        contents.push({ role: 'model', parts })
      }
    } else if (message.role === 'tool') {
      const part = toolResponse(message, names)
      const previous = contents.at(-1)
      if (previous?.role === 'user' && previous.parts.every((item) => item.functionResponse)) {
        previous.parts.push(part)
      } else {
        contents.push({ role: 'user', parts: [part] })
      }
    } else if (message.role === 'user') {
      contents.push({ role: 'user', parts: contentParts(message.content) })
    } else {
      throw invalidRequest(`Unsupported message role: ${message.role}`)
    }
  }
  return {
    contents: ensureThoughtSignaturesOnContents(contents),
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
  }
}

const convertTools = (tools, vendor) => {
  const declarations = []
  const builtins = []
  for (const tool of tools) {
    if (tool.type === 'function') {
      const fn = tool.function
      if (!fn?.name) {
        throw invalidRequest('Gemini requires named function definitions')
      }
      const schema = fn.parameters ?? { type: 'object', properties: {} }
      declarations.push({
        name: fn.name,
        ...(fn.description !== undefined ? { description: fn.description } : {}),
        parametersJsonSchema:
          vendor === 'antigravity'
            ? convertAntigravityToolSchema(schema)
            : cleanJsonSchemaForGemini(schema, { preserveConstraints: true }),
      })
    } else if (['web_search', 'web_search_preview', 'google_search'].includes(tool.type) || tool.google_search) {
      builtins.push({ googleSearch: tool.google_search ?? {} })
    } else if (tool.code_execution || tool.type === 'code_execution') {
      builtins.push({ codeExecution: tool.code_execution ?? {} })
    } else if (tool.url_context || tool.type === 'url_context') {
      builtins.push({ urlContext: tool.url_context ?? {} })
    } else {
      throw invalidRequest(`Unsupported Gemini tool: ${tool.type ?? 'unknown'}`)
    }
  }
  return [...(declarations.length ? [{ functionDeclarations: declarations }] : []), ...builtins]
}

const functionCallingConfig = (choice) => {
  if (typeof choice === 'object' && choice?.type === 'function' && choice.function?.name) {
    return { mode: 'ANY', allowedFunctionNames: [choice.function.name] }
  }
  const mode = { auto: 'AUTO', none: 'NONE', required: 'ANY' }[choice]
  if (!mode) {
    throw invalidRequest('Unsupported Gemini tool_choice')
  }
  return { mode }
}

export const buildOpenAIChatGeminiRequest = (body, { vendor = null } = {}) => {
  if (Array.isArray(body.contents)) {
    return buildGeminiGenerateBody(body)
  }
  const result = convertMessages(body.messages)
  const generationConfig = { ...body.generationConfig }
  for (const [from, to] of [
    ['temperature', 'temperature'],
    ['top_p', 'topP'],
    ['max_tokens', 'maxOutputTokens'],
    ['max_completion_tokens', 'maxOutputTokens'],
    ['n', 'candidateCount'],
  ]) {
    if (body[from] !== undefined) {
      generationConfig[to] = body[from]
    }
  }
  if (body.stop !== undefined) {
    generationConfig.stopSequences = typeof body.stop === 'string' ? [body.stop] : body.stop
  }
  if (body.response_format?.type === 'json_object' || body.response_format?.type === 'json_schema') {
    generationConfig.responseMimeType = 'application/json'
    if (body.response_format.type === 'json_schema') {
      generationConfig.responseJsonSchema = body.response_format.json_schema.schema
    }
  }
  if (Object.keys(generationConfig).length) {
    result.generationConfig = generationConfig
  }
  if (Array.isArray(body.tools)) {
    result.tools = convertTools(body.tools, vendor)
  }
  if (body.tool_choice !== undefined) {
    result.toolConfig = { functionCallingConfig: functionCallingConfig(body.tool_choice) }
  }
  if (vendor !== 'antigravity' && result.tools?.length > 1 && result.tools[0].functionDeclarations) {
    result.toolConfig = { ...result.toolConfig, includeServerSideToolInvocations: true }
  }
  for (const field of ['cachedContent', 'safetySettings']) {
    if (body[field] !== undefined) {
      result[field] = body[field]
    }
  }
  return result
}
