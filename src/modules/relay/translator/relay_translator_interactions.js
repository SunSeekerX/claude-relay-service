// Gemini Interactions 协议转换（对齐 CLIProxyAPI interactions 主路径字段）
// Interactions 请求大致：{ model, input: Step[], system_instruction?, stream?, tools?, generation_config? }
// Step：user_input | model_output | thought | function_call | function_response ...

import { TranslatorFormat, TranslatorQuality } from './relay_translator_formats.js'
import { registerTranslator } from './relay_translator_registry.js'
import * as thinkingMap from './relay_translator_thinking.js'
import {
  interactionToGenerateContent,
  generateContentToInteraction,
  createInteractionStreamState,
  generateContentToInteractionEvents,
  finishInteractionStream,
  normalizeInteractionInput,
  assertStatelessInteraction
} from '../relay_interactions_protocol.js'
import { buildResponsesToolMap, visibleReplayText, unsupportedReplay } from './relay_translator_response_tools.js'

export { finishInteractionStream }

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
export const convertInteractionsToGemini = (body = {}) => interactionToGenerateContent(body)

// ---------- Gemini → Interactions response (non-stream) ----------
export const convertGeminiToInteractions = (geminiResponse, options = {}) =>
  generateContentToInteraction(geminiResponse, options)

// ---------- Interactions ↔ Claude Messages ----------
export const convertInteractionsToClaude = (body = {}) => {
  assertStatelessInteraction(body)
  const messages = []
  for (const step of normalizeInteractionInput(body.input)) {
    if (!step) {
      continue
    }
    const type = step.type || 'user_input'
    if (type === 'user_input') {
      messages.push({ role: 'user', content: textFromInteractionsContent(step.content) || '' })
    } else if (type === 'model_output') {
      messages.push({ role: 'assistant', content: textFromInteractionsContent(step.content) || '' })
    } else if (type === 'thought') {
      const text = textFromInteractionsContent(step.summary)
      if (text) {
        messages.push({ role: 'assistant', content: text })
      }
    } else if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: step.id || step.call_id || `toolu_${Date.now()}`,
            name: step.name,
            input: step.arguments || step.args || {}
          }
        ]
      })
    } else if (type === 'function_result') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: step.call_id,
            content: typeof step.result === 'string' ? step.result : JSON.stringify(step.result)
          }
        ]
      })
    }
  }

  const claude = {
    model: body.model,
    messages,
    max_tokens: body.generation_config?.max_output_tokens || body.max_tokens || 4096,
    stream: body.stream === true
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
        input_schema: tool.parameters || { type: 'object', properties: {} }
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
            type: 'function_result',
            call_id: result.tool_use_id,
            result: result.content
          })
        }
        if (texts.length) {
          input.push({
            type: 'user_input',
            content: texts.map((block) => ({ type: 'text', text: block.text || '' }))
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
              type: 'model_output',
              content: [{ type: 'text', text: block.thinking || '' }]
            })
          } else if (block?.type === 'text') {
            input.push({ type: 'model_output', content: [{ type: 'text', text: block.text || '' }] })
          } else if (block?.type === 'tool_use') {
            input.push({
              type: 'function_call',
              id: block.id,
              name: block.name,
              arguments: block.input || {}
            })
          }
        }
      } else {
        input.push({
          type: 'model_output',
          content: [{ type: 'text', text: String(message.content || '') }]
        })
      }
    }
  }

  const out = {
    model: body.model,
    input,
    stream: body.stream === true
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
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || tool.parameters
    }))
  }
  out.generation_config = {
    ...(body.max_tokens === undefined ? {} : { max_output_tokens: body.max_tokens }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(body.top_p === undefined ? {} : { top_p: body.top_p }),
    ...(thinkingMap.isThinkingEnabled(body.thinking) ? { thinking_summaries: 'auto' } : {})
  }
  return out
}

// ---------- Interactions ↔ OpenAI Chat ----------
export const convertInteractionsToOpenAIChat = (body = {}) => {
  assertStatelessInteraction(body)
  const messages = []
  if (body.system_instruction) {
    messages.push({ role: 'system', content: body.system_instruction })
  }
  for (const step of normalizeInteractionInput(body.input)) {
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
        content: textFromInteractionsContent(step.summary)
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
              arguments: JSON.stringify(step.arguments || {})
            }
          }
        ]
      })
    } else if (type === 'function_result') {
      messages.push({
        role: 'tool',
        tool_call_id: step.call_id,
        content: typeof step.result === 'string' ? step.result : JSON.stringify(step.result)
      })
    }
  }
  return {
    model: body.model,
    messages,
    stream: body.stream === true,
    max_tokens: body.generation_config?.max_output_tokens,
    temperature: body.generation_config?.temperature
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
          content: [{ type: 'text', text: message.reasoning_content }]
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
          })()
        })
      }
    } else if (message.role === 'tool') {
      input.push({
        type: 'function_result',
        call_id: message.tool_call_id,
        result: message.content
      })
    }
  }
  const out = { model: body.model, input, stream: body.stream === true }
  if (systemInstruction) {
    out.system_instruction = systemInstruction
  }
  if (body.reasoning_effort) {
    out.generation_config = {
      thinking_summaries: 'auto',
      thinking_level: body.reasoning_effort
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
        output: message.content
      })
      continue
    }
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments
        })
      }
      if (message.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: String(message.content) }]
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
          text: String(message.content || '')
        }
      ]
    })
  }
  const system = chat.messages?.find((message) => message.role === 'system')?.content
  const result = {
    model: body.model,
    input,
    stream: body.stream === true,
    store: false
  }
  if (system) {
    result.instructions = system
  }
  return result
}

export const convertResponsesToInteractions = (body = {}) => {
  if (body.previous_response_id) {
    throw unsupportedReplay('Responses continuation requires its original provider')
  }
  const toolMap = buildResponsesToolMap(body)
  const input = []
  const items =
    typeof body.input === 'string'
      ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }]
      : asArray(body.input)
  for (const item of items) {
    if (!item) {
      continue
    }
    if (item.type === 'message') {
      const text = asArray(item.content)
        .map((part) => part?.text || '')
        .join('')
      input.push({
        type: item.role === 'assistant' ? 'model_output' : 'user_input',
        content: [{ type: 'text', text }]
      })
    } else if (['reasoning', 'compaction', 'agent_message'].includes(item.type)) {
      const text = visibleReplayText(item)
      if (text) {
        input.push({
          type: item.type === 'reasoning' ? 'model_output' : 'user_input',
          content: [{ type: 'text', text }]
        })
      }
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      input.push({
        type: 'function_call',
        id: item.call_id,
        name: toolMap.name(item.name, item.namespace),
        arguments:
          item.type === 'custom_tool_call'
            ? { input: item.input ?? '' }
            : (() => {
                try {
                  return JSON.parse(item.arguments || '{}')
                } catch {
                  return {}
                }
              })()
      })
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      input.push({ type: 'function_result', call_id: item.call_id, result: item.output })
    }
  }
  return {
    model: body.model,
    input,
    stream: body.stream === true,
    system_instruction: body.instructions || '',
    tools: toolMap.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }))
  }
}

export const registerInteractionsTranslators = () => {
  const pairs = [
    {
      from: TranslatorFormat.geminiInteractions,
      to: TranslatorFormat.geminiGenerate,
      convertRequest: convertInteractionsToGemini,
      quality: TranslatorQuality.good
    },
    {
      from: TranslatorFormat.geminiGenerate,
      to: TranslatorFormat.geminiInteractions,
      convertResponse: (response, options) => convertGeminiToInteractions(response, options),
      quality: TranslatorQuality.good
    },
    {
      from: TranslatorFormat.geminiInteractions,
      to: TranslatorFormat.claudeMessages,
      convertRequest: convertInteractionsToClaude,
      quality: TranslatorQuality.good
    },
    {
      from: TranslatorFormat.claudeMessages,
      to: TranslatorFormat.geminiInteractions,
      convertRequest: convertClaudeToInteractions,
      quality: TranslatorQuality.good
    },
    {
      from: TranslatorFormat.geminiInteractions,
      to: TranslatorFormat.openaiChat,
      convertRequest: convertInteractionsToOpenAIChat,
      quality: TranslatorQuality.fair
    },
    {
      from: TranslatorFormat.openaiChat,
      to: TranslatorFormat.geminiInteractions,
      convertRequest: convertOpenAIChatToInteractions,
      quality: TranslatorQuality.fair
    },
    {
      from: TranslatorFormat.geminiInteractions,
      to: TranslatorFormat.openaiResponses,
      convertRequest: convertInteractionsToResponses,
      quality: TranslatorQuality.fair
    },
    {
      from: TranslatorFormat.openaiResponses,
      to: TranslatorFormat.geminiInteractions,
      convertRequest: convertResponsesToInteractions,
      quality: TranslatorQuality.fair
    }
  ]

  for (const entry of pairs) {
    registerTranslator(entry)
  }
}

// ---------- Gemini generateContent SSE → Interactions 流事件 ----------
export const createGeminiToInteractionsStreamState = (options = {}) => createInteractionStreamState(options)

// 输入：已解析的 Gemini stream chunk JSON；输出：Interactions 事件对象数组
export const convertGeminiStreamChunkToInteractionsEvents = (chunk, state) =>
  generateContentToInteractionEvents(chunk, state)

export const formatInteractionsSse = (events) => {
  let out = ''
  for (const event of events) {
    out += `data: ${JSON.stringify(event)}\n\n`
  }
  return out
}
