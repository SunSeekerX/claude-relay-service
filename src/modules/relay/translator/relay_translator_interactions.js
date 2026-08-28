// Gemini Interactions 协议转换（对齐 CLIProxyAPI interactions 主路径字段）
// Interactions 请求大致：{ model, input: Step[], system_instruction?, stream?, tools?, generation_config? }
// Step：user_input | model_output | thought | function_call | function_response ...

import { TranslatorFormat, TranslatorQuality } from './relay_translator_formats.js'
import { registerTranslator } from './relay_translator_registry.js'
import * as thinkingMap from './relay_translator_thinking.js'

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : [])

const textFromInteractionsContent = (content) => {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) => {
      if (!part) {
        return ''
      }
      if (typeof part === 'string') {
        return part
      }
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
        return part.text || ''
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

// ---------- Interactions → Gemini generateContent ----------
export const convertInteractionsToGemini = (body = {}) => {
  const contents = []
  const input = asArray(body.input)

  for (const step of input) {
    if (!step || typeof step !== 'object') {
      continue
    }
    const type = step.type || 'user_input'
    if (type === 'user_input') {
      const parts = []
      const text = textFromInteractionsContent(step.content)
      if (text) {
        parts.push({ text })
      }
      // inline media
      for (const part of asArray(step.content)) {
        if (part?.inline_data || part?.inlineData) {
          const inline = part.inline_data || part.inlineData
          parts.push({ inlineData: { mimeType: inline.mime_type || inline.mimeType, data: inline.data } })
        }
      }
      contents.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] })
      continue
    }
    if (type === 'model_output' || type === 'thought') {
      const parts = []
      const text = textFromInteractionsContent(step.content)
      if (type === 'thought') {
        parts.push({ text: text || '', thought: true })
      } else if (text) {
        parts.push({ text })
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] })
      continue
    }
    if (type === 'function_call' || type === 'tool_call') {
      contents.push({
        role: 'model',
        parts: [
          {
            functionCall: {
              name: step.name,
              args: step.arguments || step.args || {},
              id: step.id || step.call_id,
            },
          },
        ],
      })
      continue
    }
    if (type === 'function_response' || type === 'tool_result') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: step.name,
              response: typeof step.response === 'object' ? step.response : { output: step.response || step.content },
              id: step.id || step.call_id,
            },
          },
        ],
      })
    }
  }

  const request = {
    contents,
    generationConfig: {},
  }

  if (body.system_instruction || body.systemInstruction) {
    const sys = body.system_instruction || body.systemInstruction
    request.systemInstruction = {
      role: 'user',
      parts: [{ text: typeof sys === 'string' ? sys : textFromInteractionsContent(sys) }],
    }
  }

  const generationConfig = body.generation_config || body.generationConfig || {}
  if (generationConfig && typeof generationConfig === 'object') {
    request.generationConfig = {
      ...request.generationConfig,
      temperature: generationConfig.temperature,
      topP: generationConfig.top_p ?? generationConfig.topP,
      topK: generationConfig.top_k ?? generationConfig.topK,
      maxOutputTokens: generationConfig.max_output_tokens ?? generationConfig.maxOutputTokens,
    }
    const thinking = generationConfig.thinking_config || generationConfig.thinkingConfig
    if (thinking) {
      request.generationConfig.thinkingConfig = {
        includeThoughts: thinking.include_thoughts ?? thinking.includeThoughts ?? true,
        thinkingBudget: thinking.thinking_budget ?? thinking.thinkingBudget,
        thinkingLevel: thinking.thinking_level ?? thinking.thinkingLevel,
      }
    }
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const functionDeclarations = []
    for (const tool of body.tools) {
      if (!tool) {
        continue
      }
      if (tool.function_declarations || tool.functionDeclarations) {
        functionDeclarations.push(...(tool.function_declarations || tool.functionDeclarations))
      } else if (tool.name) {
        functionDeclarations.push({
          name: tool.name,
          description: tool.description || '',
          parametersJsonSchema: tool.parameters || tool.parametersJsonSchema || { type: 'object' },
        })
      }
    }
    if (functionDeclarations.length > 0) {
      request.tools = [{ functionDeclarations }]
    }
  }

  return { model: body.model, request, stream: body.stream === true }
}

// ---------- Gemini → Interactions response (non-stream) ----------
export const convertGeminiToInteractions = (geminiResponse, options = {}) => {
  const model = options.model || geminiResponse?.modelVersion || ''
  const candidate = geminiResponse?.candidates?.[0]
  const parts = candidate?.content?.parts || []
  const outputs = []

  for (const part of parts) {
    if (!part) {
      continue
    }
    if (part.thought) {
      outputs.push({
        type: 'thought',
        content: [{ type: 'text', text: part.text || '' }],
      })
      continue
    }
    if (part.functionCall) {
      outputs.push({
        type: 'function_call',
        name: part.functionCall.name,
        arguments: part.functionCall.args || {},
        id: part.functionCall.id,
      })
      continue
    }
    if (part.text) {
      outputs.push({
        type: 'model_output',
        content: [{ type: 'text', text: part.text }],
      })
    }
  }

  const usage = geminiResponse?.usageMetadata || {}
  return {
    id: geminiResponse?.responseId || `interaction_${Date.now()}`,
    object: 'interaction',
    model,
    output: outputs,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
      total_tokens: usage.totalTokenCount || 0,
      thoughts_tokens: usage.thoughtsTokenCount || 0,
      cached_tokens: usage.cachedContentTokenCount || 0,
    },
    status: 'completed',
  }
}

// ---------- Interactions ↔ Claude Messages ----------
export const convertInteractionsToClaude = (body = {}) => {
  const messages = []
  for (const step of asArray(body.input)) {
    if (!step) {
      continue
    }
    const type = step.type || 'user_input'
    if (type === 'user_input') {
      messages.push({ role: 'user', content: textFromInteractionsContent(step.content) || '' })
    } else if (type === 'model_output') {
      messages.push({ role: 'assistant', content: textFromInteractionsContent(step.content) || '' })
    } else if (type === 'thought') {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: textFromInteractionsContent(step.content) || '',
            signature: step.signature || 'interactions_thought',
          },
          { type: 'text', text: '' },
        ],
      })
    } else if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: step.id || step.call_id || `toolu_${Date.now()}`,
            name: step.name,
            input: step.arguments || step.args || {},
          },
        ],
      })
    } else if (type === 'function_response' || type === 'tool_result') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: step.id || step.call_id,
            content:
              typeof step.response === 'string' ? step.response : JSON.stringify(step.response || step.content || {}),
          },
        ],
      })
    }
  }

  const claude = {
    model: body.model,
    messages,
    max_tokens: body.generation_config?.max_output_tokens || body.max_tokens || 4096,
    stream: body.stream === true,
  }
  if (body.system_instruction) {
    claude.system = body.system_instruction
  }
  if (Array.isArray(body.tools)) {
    claude.tools = body.tools
      .filter((tool) => tool?.name)
      .map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.parameters || { type: 'object', properties: {} },
      }))
  }
  return claude
}

export const convertClaudeToInteractions = (body = {}) => {
  const input = []
  if (body.system) {
    // system 进 system_instruction，不进 input
  }
  for (const message of body.messages || []) {
    if (!message) {
      continue
    }
    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        const toolResults = message.content.filter((block) => block?.type === 'tool_result')
        const texts = message.content.filter((block) => block?.type === 'text')
        for (const result of toolResults) {
          input.push({
            type: 'function_response',
            id: result.tool_use_id,
            response: result.content,
          })
        }
        if (texts.length) {
          input.push({
            type: 'user_input',
            content: texts.map((block) => ({ type: 'text', text: block.text || '' })),
          })
        }
      } else {
        input.push({ type: 'user_input', content: [{ type: 'text', text: String(message.content || '') }] })
      }
      continue
    }
    if (message.role === 'assistant') {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === 'thinking') {
            input.push({
              type: 'thought',
              content: [{ type: 'text', text: block.thinking || '' }],
              signature: block.signature,
            })
          } else if (block?.type === 'text') {
            input.push({ type: 'model_output', content: [{ type: 'text', text: block.text || '' }] })
          } else if (block?.type === 'tool_use') {
            input.push({
              type: 'function_call',
              id: block.id,
              name: block.name,
              arguments: block.input || {},
            })
          }
        }
      } else {
        input.push({
          type: 'model_output',
          content: [{ type: 'text', text: String(message.content || '') }],
        })
      }
    }
  }

  const out = {
    model: body.model,
    input,
    stream: body.stream === true,
  }
  if (body.system) {
    out.system_instruction =
      typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((block) => block.text || '').join('\n')
          : ''
  }
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || tool.parameters,
    }))
  }
  if (body.thinking && thinkingMap.isThinkingEnabled(body.thinking)) {
    out.generation_config = {
      thinking_config: {
        include_thoughts: true,
        thinking_budget: body.thinking.budget_tokens,
      },
    }
  }
  return out
}

// ---------- Interactions ↔ OpenAI Chat ----------
export const convertInteractionsToOpenAIChat = (body = {}) => {
  const messages = []
  if (body.system_instruction) {
    messages.push({ role: 'system', content: body.system_instruction })
  }
  for (const step of asArray(body.input)) {
    if (!step) {
      continue
    }
    const type = step.type || 'user_input'
    if (type === 'user_input') {
      messages.push({ role: 'user', content: textFromInteractionsContent(step.content) })
    } else if (type === 'model_output') {
      messages.push({ role: 'assistant', content: textFromInteractionsContent(step.content) })
    } else if (type === 'thought') {
      messages.push({
        role: 'assistant',
        content: textFromInteractionsContent(step.content),
        reasoning_content: textFromInteractionsContent(step.content),
      })
    } else if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: step.id || `call_${Date.now()}`,
            type: 'function',
            function: {
              name: step.name,
              arguments: JSON.stringify(step.arguments || {}),
            },
          },
        ],
      })
    } else if (type === 'function_response') {
      messages.push({
        role: 'tool',
        tool_call_id: step.id || step.call_id,
        content: typeof step.response === 'string' ? step.response : JSON.stringify(step.response || {}),
      })
    }
  }
  return {
    model: body.model,
    messages,
    stream: body.stream === true,
    max_tokens: body.generation_config?.max_output_tokens,
    temperature: body.generation_config?.temperature,
  }
}

export const convertOpenAIChatToInteractions = (body = {}) => {
  const input = []
  let systemInstruction = ''
  for (const message of body.messages || []) {
    if (!message) {
      continue
    }
    if (message.role === 'system' || message.role === 'developer') {
      systemInstruction += (systemInstruction ? '\n' : '') + (message.content || '')
      continue
    }
    if (message.role === 'user') {
      input.push({ type: 'user_input', content: [{ type: 'text', text: String(message.content || '') }] })
    } else if (message.role === 'assistant') {
      if (message.reasoning_content) {
        input.push({
          type: 'thought',
          content: [{ type: 'text', text: message.reasoning_content }],
        })
      }
      if (message.content) {
        input.push({ type: 'model_output', content: [{ type: 'text', text: String(message.content) }] })
      }
      for (const toolCall of message.tool_calls || []) {
        input.push({
          type: 'function_call',
          id: toolCall.id,
          name: toolCall.function?.name,
          arguments: (() => {
            try {
              return JSON.parse(toolCall.function?.arguments || '{}')
            } catch {
              return {}
            }
          })(),
        })
      }
    } else if (message.role === 'tool') {
      input.push({
        type: 'function_response',
        id: message.tool_call_id,
        response: message.content,
      })
    }
  }
  const out = { model: body.model, input, stream: body.stream === true }
  if (systemInstruction) {
    out.system_instruction = systemInstruction
  }
  if (body.reasoning_effort) {
    out.generation_config = {
      thinking_config: { include_thoughts: true },
    }
  }
  return out
}

// ---------- Interactions ↔ Responses (via chat shape loosely) ----------
export const convertInteractionsToResponses = (body = {}) => {
  const chat = convertInteractionsToOpenAIChat(body)
  // 轻量：instructions + input messages
  const input = []
  for (const message of chat.messages || []) {
    if (message.role === 'system') {
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content,
      })
      continue
    }
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })
      }
      if (message.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: String(message.content) }],
        })
      }
      continue
    }
    input.push({
      type: 'message',
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [
        {
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: String(message.content || ''),
        },
      ],
    })
  }
  const system = chat.messages?.find((message) => message.role === 'system')?.content
  const result = {
    model: body.model,
    input,
    stream: body.stream === true,
    store: false,
  }
  if (system) {
    result.instructions = system
  }
  return result
}

export const convertResponsesToInteractions = (body = {}) => {
  // 把 responses input 近似映射为 interactions input
  const input = []
  for (const item of asArray(body.input)) {
    if (!item) {
      continue
    }
    if (item.type === 'message') {
      const text = asArray(item.content)
        .map((part) => part?.text || '')
        .join('')
      input.push({
        type: item.role === 'assistant' ? 'model_output' : 'user_input',
        content: [{ type: 'text', text }],
      })
    } else if (item.type === 'reasoning') {
      const text = asArray(item.summary)
        .map((part) => part?.text || '')
        .join('')
      input.push({ type: 'thought', content: [{ type: 'text', text }] })
    } else if (item.type === 'function_call') {
      input.push({
        type: 'function_call',
        id: item.call_id,
        name: item.name,
        arguments: (() => {
          try {
            return JSON.parse(item.arguments || '{}')
          } catch {
            return {}
          }
        })(),
      })
    } else if (item.type === 'function_call_output') {
      input.push({ type: 'function_response', id: item.call_id, response: item.output })
    }
  }
  return {
    model: body.model,
    input,
    stream: body.stream === true,
    system_instruction: body.instructions || '',
  }
}

export const registerInteractionsTranslators = () => {
  const pairs = [
    {
      from: TranslatorFormat.geminiInteractions,
      to: TranslatorFormat.geminiGenerate,
      convertRequest: convertInteractionsToGemini,
      quality: TranslatorQuality.good,
    },
    {
      from: TranslatorFormat.geminiGenerate,
      to: TranslatorFormat.geminiInteractions,
      convertResponse: (response, options) => convertGeminiToInteractions(response, options),
      quality: TranslatorQuality.good,
    },
    {
      from: TranslatorFormat.geminiInteractions,
      to: TranslatorFormat.claudeMessages,
      convertRequest: convertInteractionsToClaude,
      quality: TranslatorQuality.good,
    },
    {
      from: TranslatorFormat.claudeMessages,
      to: TranslatorFormat.geminiInteractions,
      convertRequest: convertClaudeToInteractions,
      quality: TranslatorQuality.good,
    },
    {
      from: TranslatorFormat.geminiInteractions,
      to: TranslatorFormat.openaiChat,
      convertRequest: convertInteractionsToOpenAIChat,
      quality: TranslatorQuality.fair,
    },
    {
      from: TranslatorFormat.openaiChat,
      to: TranslatorFormat.geminiInteractions,
      convertRequest: convertOpenAIChatToInteractions,
      quality: TranslatorQuality.fair,
    },
    {
      from: TranslatorFormat.geminiInteractions,
      to: TranslatorFormat.openaiResponses,
      convertRequest: convertInteractionsToResponses,
      quality: TranslatorQuality.fair,
    },
    {
      from: TranslatorFormat.openaiResponses,
      to: TranslatorFormat.geminiInteractions,
      convertRequest: convertResponsesToInteractions,
      quality: TranslatorQuality.fair,
    },
  ]

  for (const entry of pairs) {
    registerTranslator(entry)
  }
}

// ---------- Gemini generateContent SSE → Interactions 流事件 ----------
export const createGeminiToInteractionsStreamState = (options = {}) => ({
  id: `interaction_${Date.now()}`,
  model: options.model || '',
  started: false,
  textStepIndex: 0,
  thoughtStepIndex: 1,
  toolStepIndex: 2,
  textStarted: false,
  thoughtStarted: false,
  finished: false,
  usage: null,
})

const writeInteractionEvent = (eventType, payload) => ({
  event_type: eventType,
  ...payload,
})

// 输入：已解析的 Gemini stream chunk JSON；输出：Interactions 事件对象数组
export const convertGeminiStreamChunkToInteractionsEvents = (chunk, state) => {
  if (!chunk || typeof chunk !== 'object' || chunk.error) {
    if (chunk?.error) {
      return [writeInteractionEvent('error', { error: chunk.error })]
    }
    return []
  }

  const events = []
  if (!state.started) {
    state.started = true
    events.push(
      writeInteractionEvent('interaction.created', {
        interaction: { id: state.id, model: state.model, object: 'interaction', status: 'in_progress' },
      }),
    )
  }

  if (chunk.usageMetadata) {
    state.usage = chunk.usageMetadata
  }

  const parts = chunk.candidates?.[0]?.content?.parts || []
  for (const part of parts) {
    if (!part) {
      continue
    }
    if (part.thought && part.text) {
      if (!state.thoughtStarted) {
        state.thoughtStarted = true
        events.push(
          writeInteractionEvent('step.start', {
            index: state.thoughtStepIndex,
            step: { type: 'thought', id: `thought_${state.thoughtStepIndex}` },
          }),
        )
      }
      events.push(
        writeInteractionEvent('step.delta', {
          index: state.thoughtStepIndex,
          delta: { type: 'thought_summary', text: part.text },
        }),
      )
      continue
    }
    if (part.functionCall) {
      events.push(
        writeInteractionEvent('step.start', {
          index: state.toolStepIndex,
          step: {
            type: 'function_call',
            name: part.functionCall.name,
            id: part.functionCall.id || `fc_${state.toolStepIndex}`,
            call_id: part.functionCall.id,
          },
        }),
      )
      events.push(
        writeInteractionEvent('step.delta', {
          index: state.toolStepIndex,
          delta: {
            type: 'arguments_delta',
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        }),
      )
      state.toolStepIndex += 1
      continue
    }
    if (part.text) {
      if (!state.textStarted) {
        state.textStarted = true
        events.push(
          writeInteractionEvent('step.start', {
            index: state.textStepIndex,
            step: { type: 'model_output', id: `text_${state.textStepIndex}` },
          }),
        )
      }
      events.push(
        writeInteractionEvent('step.delta', {
          index: state.textStepIndex,
          delta: { type: 'text', text: part.text },
        }),
      )
    }
  }

  const finishReason = chunk.candidates?.[0]?.finishReason
  if (finishReason && !state.finished) {
    state.finished = true
    const usage = state.usage || {}
    events.push(
      writeInteractionEvent('interaction.completed', {
        interaction: {
          id: state.id,
          model: state.model,
          object: 'interaction',
          status: 'completed',
          usage: {
            input_tokens: usage.promptTokenCount || 0,
            output_tokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
            total_tokens: usage.totalTokenCount || 0,
            thoughts_tokens: usage.thoughtsTokenCount || 0,
            cached_tokens: usage.cachedContentTokenCount || 0,
          },
        },
      }),
    )
  }

  return events
}

export const formatInteractionsSse = (events) => {
  let out = ''
  for (const event of events) {
    out += `data: ${JSON.stringify(event)}\n\n`
  }
  return out
}
