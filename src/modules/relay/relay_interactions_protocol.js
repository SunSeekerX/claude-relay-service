import crypto from 'node:crypto'

export const interactionError = (message, code = 'interaction_feature_unsupported', statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode })

const array = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value])
const contentTypes = new Set(['text', 'image', 'audio', 'video', 'document'])
const safetyCategories = new Map(
  ['hate_speech', 'dangerous_content', 'harassment', 'sexually_explicit', 'jailbreak'].map((type) => [
    type,
    `HARM_CATEGORY_${type.toUpperCase()}`
  ])
)
const safetyThresholds = new Set(['block_low_and_above', 'block_medium_and_above', 'block_only_high', 'off'])
const toolModes = new Set(['auto', 'any', 'none', 'validated'])

const convertSafetySettings = (settings) => {
  if (!Array.isArray(settings)) {
    throw interactionError('safety_settings must be an array', 'invalid_argument')
  }
  return settings.map((setting) => {
    if (!safetyCategories.has(setting?.type) || !safetyThresholds.has(setting?.threshold)) {
      throw interactionError('Unsupported safety category or threshold', 'invalid_argument')
    }
    if (setting.method !== undefined && setting.method !== 'probability') {
      throw interactionError('This safety method requires native Interactions support')
    }
    return { category: safetyCategories.get(setting.type), threshold: setting.threshold.toUpperCase() }
  })
}

const convertToolChoice = (choice, declarations, hasServerTools) => {
  const allowed =
    typeof choice === 'string'
      ? { mode: choice }
      : choice && typeof choice === 'object' && !Array.isArray(choice)
        ? (choice.allowed_tools ?? {})
        : null
  if (!allowed || typeof allowed !== 'object' || Array.isArray(allowed)) {
    throw interactionError('tool_choice must be a mode or an allowed_tools configuration', 'invalid_argument')
  }
  if (allowed.mode !== undefined && !toolModes.has(allowed.mode)) {
    throw interactionError('Unsupported tool choice mode', 'invalid_argument')
  }
  if (allowed.tools !== undefined) {
    if (!Array.isArray(allowed.tools)) {
      throw interactionError('allowed_tools.tools must be an array', 'invalid_argument')
    }
    if (hasServerTools || allowed.tools.some((name) => !declarations.some((tool) => tool.name === name))) {
      throw interactionError('This tool selection requires native Interactions support')
    }
  }
  return {
    functionCallingConfig: {
      ...(allowed.mode === undefined ? {} : { mode: allowed.mode.toUpperCase() }),
      ...(allowed.tools === undefined || !['any', 'validated'].includes(allowed.mode)
        ? {}
        : { allowedFunctionNames: allowed.tools })
    },
    functionDeclarations:
      allowed.tools !== undefined && !['any', 'validated'].includes(allowed.mode)
        ? declarations.filter((tool) => allowed.tools.includes(tool.name))
        : declarations
  }
}

export const normalizeInteractionInput = (input) => {
  if (typeof input === 'string') {
    return [{ type: 'user_input', content: [{ type: 'text', text: input }] }]
  }
  const items = array(input)
  if (items.every((item) => contentTypes.has(item?.type))) {
    return [{ type: 'user_input', content: items }]
  }
  return items
}

export const assertStatelessInteraction = (body) => {
  for (const field of [
    'previous_interaction_id',
    'continuation_token',
    'agent',
    'agent_config',
    'environment',
    'environment_id',
    'webhook_config'
  ]) {
    if (body[field] !== undefined) {
      throw interactionError(`${field} requires a Gemini API account with native Interactions support`)
    }
  }
  if (body.background === true || body.store === true) {
    throw interactionError('OAuth Interactions supports stateless requests only; use store=false and background=false')
  }
}

const toGeminiParts = (content) =>
  array(content).map((part) => {
    if (typeof part === 'string') {
      return { text: part }
    }
    if (part?.type === 'text') {
      return { text: part.text ?? '' }
    }
    if (contentTypes.has(part?.type)) {
      if (part.processing || part.resolution || part.channels || part.sample_rate) {
        throw interactionError('This media processing option requires native Interactions support')
      }
      if (part.data !== undefined) {
        return { inlineData: { mimeType: part.mime_type, data: part.data } }
      }
      if (part.uri !== undefined) {
        return { fileData: { mimeType: part.mime_type, fileUri: part.uri } }
      }
    }
    throw interactionError(`Unsupported Interactions content type: ${part?.type ?? 'unknown'}`)
  })

export const interactionToGenerateContent = (body) => {
  assertStatelessInteraction(body)
  if (body.input === undefined || body.input === null) {
    throw interactionError('input is required', 'invalid_argument')
  }
  const contents = []
  const calls = new Map()
  let signature = null
  for (const step of normalizeInteractionInput(body.input)) {
    if (step?.type === 'thought') {
      signature = step.signature ?? null
      const parts = toGeminiParts(step.summary ?? [])
      if (parts.length) {
        contents.push({
          role: 'model',
          parts: parts.map((part) => ({
            ...part,
            thought: true,
            ...(signature ? { thoughtSignature: signature } : {})
          }))
        })
      }
    } else if (step?.type === 'user_input' || step?.type === 'model_output') {
      contents.push({ role: step.type === 'user_input' ? 'user' : 'model', parts: toGeminiParts(step.content) })
    } else if (step?.type === 'function_call') {
      calls.set(step.id, step.name)
      contents.push({
        role: 'model',
        parts: [
          {
            functionCall: { id: step.id, name: step.name, args: step.arguments },
            ...(signature ? { thoughtSignature: signature } : {})
          }
        ]
      })
      signature = null
    } else if (step?.type === 'function_result') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: step.call_id,
              name: step.name ?? calls.get(step.call_id),
              response: { output: step.result, ...(step.is_error === undefined ? {} : { is_error: step.is_error }) }
            }
          }
        ]
      })
    } else {
      throw interactionError(`Unsupported Interactions step: ${step?.type ?? 'unknown'}`)
    }
  }
  const request = { contents }
  if (body.system_instruction !== undefined) {
    request.systemInstruction = { parts: [{ text: body.system_instruction }] }
  }
  const source = body.generation_config ?? {}
  const generationConfig = {}
  for (const [from, to] of Object.entries({
    temperature: 'temperature',
    top_p: 'topP',
    seed: 'seed',
    stop_sequences: 'stopSequences',
    max_output_tokens: 'maxOutputTokens'
  })) {
    if (source[from] !== undefined) {
      generationConfig[to] = source[from]
    }
  }
  if (source.thinking_level !== undefined || source.thinking_summaries !== undefined) {
    generationConfig.thinkingConfig = {
      ...(source.thinking_level === undefined ? {} : { thinkingLevel: source.thinking_level.toUpperCase() }),
      ...(source.thinking_summaries === undefined ? {} : { includeThoughts: source.thinking_summaries !== 'none' })
    }
  }
  for (const field of ['video_config', 'transcription_config', 'structured_speech_config', 'image_config']) {
    if (source[field] !== undefined) {
      throw interactionError(`${field} requires native Interactions support`)
    }
  }
  if (body.response_format !== undefined) {
    throw interactionError('response_format requires native Interactions support')
  }
  if (body.response_modalities !== undefined) {
    generationConfig.responseModalities = body.response_modalities
  }
  if (body.response_mime_type !== undefined) {
    generationConfig.responseMimeType = body.response_mime_type
  }
  if (Object.keys(generationConfig).length) {
    request.generationConfig = generationConfig
  }
  if (body.safety_settings !== undefined) {
    request.safetySettings = convertSafetySettings(body.safety_settings)
  }
  const tools = []
  const declarations = []
  for (const tool of body.tools ?? []) {
    if (tool.type === 'function') {
      declarations.push({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })
    } else if (['google_search', 'url_context', 'code_execution'].includes(tool.type)) {
      const key = { google_search: 'googleSearch', url_context: 'urlContext', code_execution: 'codeExecution' }[
        tool.type
      ]
      const { type: _type, ...options } = tool
      tools.push({ [key]: options })
    } else {
      throw interactionError(`Tool ${tool.type} requires native Interactions support`)
    }
  }
  const toolChoice =
    source.tool_choice === undefined ? null : convertToolChoice(source.tool_choice, declarations, tools.length > 0)
  const functionDeclarations = toolChoice?.functionDeclarations ?? declarations
  if (functionDeclarations.length) {
    tools.push({ functionDeclarations })
  }
  if (tools.length) {
    request.tools = tools
  }
  if (toolChoice) {
    request.toolConfig = {
      functionCallingConfig: toolChoice.functionCallingConfig
    }
  }
  return { model: body.model, request, stream: body.stream === true }
}

export const geminiInteractionUsage = (usage = {}) => ({
  total_input_tokens: usage.promptTokenCount ?? 0,
  total_output_tokens: usage.candidatesTokenCount ?? 0,
  total_thought_tokens: usage.thoughtsTokenCount ?? 0,
  total_cached_tokens: usage.cachedContentTokenCount ?? 0,
  total_tool_use_tokens: usage.toolUsePromptTokenCount ?? 0,
  total_tokens: usage.totalTokenCount ?? 0
})

const interactionStatus = (response) => {
  const candidate = response.candidates?.[0]
  if (candidate?.finishReason === 'MAX_TOKENS') {
    return 'incomplete'
  }
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    return 'failed'
  }
  if (response.promptFeedback?.blockReason) {
    return 'failed'
  }
  if (!candidate?.finishReason) {
    return 'incomplete'
  }
  return candidate.content?.parts?.some((part) => part.functionCall) ? 'requires_action' : 'completed'
}

const fromGeminiPart = (part) => {
  if (part.functionCall) {
    return {
      type: 'function_call',
      id: part.functionCall.id ?? `call_${crypto.randomUUID()}`,
      name: part.functionCall.name,
      arguments: part.functionCall.args ?? {}
    }
  }
  if (part.thought || (part.thoughtSignature && part.text === undefined)) {
    return {
      type: 'thought',
      ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
      summary: part.text === undefined ? [] : [{ type: 'text', text: part.text }]
    }
  }
  if (part.text !== undefined) {
    return { type: 'model_output', content: [{ type: 'text', text: part.text }] }
  }
  if (part.inlineData || part.fileData) {
    const media = part.inlineData ?? part.fileData
    const type = media.mimeType?.startsWith('image/')
      ? 'image'
      : media.mimeType?.startsWith('audio/')
        ? 'audio'
        : media.mimeType?.startsWith('video/')
          ? 'video'
          : 'document'
    return {
      type: 'model_output',
      content: [
        { type, mime_type: media.mimeType, ...(part.inlineData ? { data: media.data } : { uri: media.fileUri }) }
      ]
    }
  }
  throw interactionError(
    'The upstream returned an unsupported Gemini content part',
    'unsupported_upstream_content',
    502
  )
}

export const generateContentToInteraction = (response, options = {}) => {
  const time = new Date().toISOString()
  const steps = (response.candidates?.[0]?.content?.parts ?? []).map(fromGeminiPart)
  return {
    id: options.id ?? `compat_${crypto.randomUUID()}`,
    object: 'interaction',
    model: options.model ?? response.modelVersion,
    created: options.created ?? time,
    updated: time,
    status: interactionStatus(response),
    steps,
    ...(response.usageMetadata === undefined ? {} : { usage: geminiInteractionUsage(response.usageMetadata) })
  }
}

export const createInteractionStreamState = (options = {}) => ({
  id: `compat_${crypto.randomUUID()}`,
  model: options.model,
  created: new Date().toISOString(),
  started: false,
  finished: false,
  steps: [],
  usage: null,
  activeText: null,
  hasTools: false
})

const event = (event_type, payload) => ({ event_type, ...payload })
const closeText = (state, events) => {
  if (state.activeText !== null) {
    events.push(event('step.stop', { index: state.activeText }))
    state.activeText = null
  }
}

export const generateContentToInteractionEvents = (chunk, state) => {
  if (state.finished) {
    return []
  }
  const events = []
  if (chunk.error) {
    closeText(state, events)
    state.finished = true
    events.push(
      event('error', {
        error: {
          code: String(chunk.error.code ?? 'upstream_error'),
          message: chunk.error.message ?? 'Upstream request failed'
        }
      })
    )
    return events
  }
  if (!state.started) {
    state.started = true
    events.push(
      event('interaction.created', {
        interaction: {
          id: state.id,
          model: state.model,
          object: 'interaction',
          status: 'in_progress',
          created: state.created,
          updated: state.created
        }
      })
    )
  }
  if (chunk.usageMetadata !== undefined) {
    state.usage = chunk.usageMetadata
  }
  for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
    const step = fromGeminiPart(part)
    if (step.type === 'model_output' && step.content?.[0]?.type === 'text') {
      if (state.activeText === null) {
        state.activeText = state.steps.length
        state.steps.push({ type: 'model_output', content: [{ type: 'text', text: '' }] })
        events.push(event('step.start', { index: state.activeText, step: { type: 'model_output' } }))
      }
      const { text } = step.content[0]
      state.steps[state.activeText].content[0].text += text
      events.push(event('step.delta', { index: state.activeText, delta: { type: 'text', text } }))
    } else {
      closeText(state, events)
      const index = state.steps.length
      state.steps.push(step)
      if (step.type === 'function_call') {
        state.hasTools = true
      }
      events.push(event('step.start', { index, step }), event('step.stop', { index }))
    }
  }
  const reason = chunk.candidates?.[0]?.finishReason
  if (reason || chunk.promptFeedback?.blockReason) {
    closeText(state, events)
    state.finished = true
    const interaction = generateContentToInteraction(chunk, {
      id: state.id,
      model: state.model,
      created: state.created
    })
    interaction.steps = state.steps
    if (reason === 'STOP' && state.hasTools) {
      interaction.status = 'requires_action'
    }
    if (state.usage) {
      interaction.usage = geminiInteractionUsage(state.usage)
    }
    events.push(event('interaction.completed', { interaction }))
  }
  return events
}

export const finishInteractionStream = (state) => {
  if (state.finished) {
    return []
  }
  state.finished = true
  const events = []
  closeText(state, events)
  events.push(
    event('error', {
      error: { code: 'upstream_stream_incomplete', message: 'Upstream stream ended before its terminal event' }
    })
  )
  return events
}
