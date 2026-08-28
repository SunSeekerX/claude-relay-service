// Claude Messages ↔ OpenAI Responses 双向转换（对齐 CLIProxyAPI/sub2api 核心字段）
import * as thinkingMap from './relay_translator_thinking.js'
import { TranslatorFormat, TranslatorQuality } from './relay_translator_formats.js'
import { registerTranslator } from './relay_translator_registry.js'

const generateId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 12)}`

const safeJsonParse = (text, fallback = {}) => {
  if (typeof text !== 'string') {
    return text ?? fallback
  }
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

const extractSystemText = (system) => {
  if (!system) {
    return ''
  }
  if (typeof system === 'string') {
    return system
  }
  if (Array.isArray(system)) {
    return system
      .filter((block) => block && block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('\n\n')
  }
  return ''
}

const claudeContentToResponsesInputParts = (content) => {
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }]
  }
  if (!Array.isArray(content)) {
    return [{ type: 'input_text', text: String(content ?? '') }]
  }
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue
    }
    if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text || '' })
    } else if (block.type === 'image' && block.source) {
      if (block.source.type === 'base64') {
        const mediaType = block.source.media_type || 'image/png'
        parts.push({
          type: 'input_image',
          image_url: `data:${mediaType};base64,${block.source.data || ''}`,
        })
      } else if (block.source.type === 'url' && block.source.url) {
        parts.push({ type: 'input_image', image_url: block.source.url })
      }
    }
    // tool_use / tool_result / thinking 在消息级处理
  }
  return parts.length > 0 ? parts : [{ type: 'input_text', text: '' }]
}

export const convertClaudeRequestToResponses = (claudeRequest, options = {}) => {
  const body = claudeRequest && typeof claudeRequest === 'object' ? claudeRequest : {}
  const input = []
  const instructions = extractSystemText(body.system)

  for (const message of body.messages || []) {
    if (!message) {
      continue
    }
    if (message.role === 'user') {
      const { content } = message
      if (Array.isArray(content)) {
        const toolResults = content.filter((block) => block && block.type === 'tool_result')
        const other = content.filter((block) => block && block.type !== 'tool_result')
        for (const result of toolResults) {
          input.push({
            type: 'function_call_output',
            call_id: result.tool_use_id,
            output: typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? ''),
          })
        }
        if (other.length > 0) {
          input.push({
            type: 'message',
            role: 'user',
            content: claudeContentToResponsesInputParts(other),
          })
        }
      } else {
        input.push({
          type: 'message',
          role: 'user',
          content: claudeContentToResponsesInputParts(content),
        })
      }
      continue
    }

    if (message.role === 'assistant') {
      const { content } = message
      if (Array.isArray(content)) {
        const thinkingBlocks = content.filter((block) => block && block.type === 'thinking')
        const toolUses = content.filter((block) => block && block.type === 'tool_use')
        const texts = content.filter((block) => block && block.type === 'text')
        // redacted_thinking 不进 reasoning 明文

        if (thinkingBlocks.length > 0) {
          const summary = thinkingBlocks
            .map((block) => block.thinking || '')
            .filter((text) => text.trim())
            .map((text) => ({ type: 'summary_text', text }))
          const encrypted = thinkingBlocks.find((block) => block.signature)?.signature
          const reasoningItem = {
            type: 'reasoning',
            summary,
          }
          if (encrypted) {
            reasoningItem.encrypted_content = encrypted
          }
          input.push(reasoningItem)
        }

        if (texts.length > 0) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: texts.map((block) => ({ type: 'output_text', text: block.text || '' })),
          })
        }

        for (const tool of toolUses) {
          input.push({
            type: 'function_call',
            call_id: tool.id || generateId('call'),
            name: tool.name,
            arguments: JSON.stringify(tool.input || {}),
          })
        }
      } else if (typeof content === 'string') {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: content }],
        })
      }
    }
  }

  const result = {
    model: body.model,
    input,
    stream: body.stream === true,
    store: false,
    parallel_tool_calls: options.parallelToolCalls !== false,
  }

  if (instructions) {
    result.instructions = instructions
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools
      .filter((tool) => tool && tool.name)
      .map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} },
        strict: tool.strict === true,
      }))
  }

  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') {
      result.tool_choice = 'auto'
    } else if (body.tool_choice.type === 'any') {
      result.tool_choice = 'required'
    } else if (body.tool_choice.type === 'none') {
      result.tool_choice = 'none'
    } else if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
      result.tool_choice = { type: 'function', name: body.tool_choice.name }
    }
  }

  const effort = thinkingMap.claudeThinkingToEffort(body.thinking, body.output_config)
  if (effort && effort !== 'none') {
    result.reasoning = {
      effort: effort === 'auto' ? 'medium' : effort,
      summary: 'auto',
    }
    result.include = ['reasoning.encrypted_content']
  }

  if (Number.isFinite(body.max_tokens)) {
    result.max_output_tokens = body.max_tokens
  }

  return result
}

export const convertResponsesRequestToClaude = (responsesRequest, options = {}) => {
  const body = responsesRequest && typeof responsesRequest === 'object' ? responsesRequest : {}
  const messages = []
  let system = body.instructions || ''

  const pushAssistantBlocks = (blocks) => {
    if (blocks.length === 0) {
      return
    }
    messages.push({ role: 'assistant', content: blocks })
  }

  const inputItems = Array.isArray(body.input)
    ? body.input
    : typeof body.input === 'string'
      ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }]
      : []

  let pendingAssistant = []

  const flushAssistant = () => {
    if (pendingAssistant.length > 0) {
      pushAssistantBlocks(pendingAssistant)
      pendingAssistant = []
    }
  }

  for (const item of inputItems) {
    if (!item || typeof item !== 'object') {
      continue
    }
    if (item.type === 'message' || item.role) {
      const role = item.role || 'user'
      if (role === 'system' || role === 'developer') {
        const texts = []
        const { content } = item
        if (typeof content === 'string') {
          texts.push(content)
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === 'input_text' || part?.type === 'text') {
              texts.push(part.text || '')
            }
          }
        }
        system = [system, ...texts].filter(Boolean).join('\n\n')
        continue
      }
      if (role === 'assistant') {
        flushAssistant()
        const blocks = []
        const { content } = item
        if (typeof content === 'string') {
          blocks.push({ type: 'text', text: content })
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === 'output_text' || part?.type === 'text') {
              blocks.push({ type: 'text', text: part.text || '' })
            }
          }
        }
        pendingAssistant.push(...blocks)
        continue
      }
      // user
      flushAssistant()
      const parts = []
      const { content } = item
      if (typeof content === 'string') {
        parts.push({ type: 'text', text: content })
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part) {
            continue
          }
          if (part.type === 'input_text' || part.type === 'text') {
            parts.push({ type: 'text', text: part.text || '' })
          } else if (part.type === 'input_image') {
            const url = part.image_url?.url || part.image_url
            if (typeof url === 'string' && url.startsWith('data:')) {
              const match = url.match(/^data:([^;]+);base64,(.+)$/)
              if (match) {
                parts.push({
                  type: 'image',
                  source: { type: 'base64', media_type: match[1], data: match[2] },
                })
              }
            } else if (typeof url === 'string') {
              parts.push({ type: 'image', source: { type: 'url', url } })
            }
          }
        }
      }
      messages.push({ role: 'user', content: parts.length ? parts : [{ type: 'text', text: '' }] })
      continue
    }

    if (item.type === 'reasoning') {
      const summaryText = Array.isArray(item.summary) ? item.summary.map((entry) => entry?.text || '').join('\n') : ''
      const thinkingBlock = {
        type: 'thinking',
        thinking: summaryText || '',
      }
      // 仅 encrypted_content 可作 Claude signature；禁止 item.id / 占位串
      if (item.encrypted_content) {
        thinkingBlock.signature = item.encrypted_content
      }
      pendingAssistant.push(thinkingBlock)
      continue
    }

    if (item.type === 'function_call') {
      pendingAssistant.push({
        type: 'tool_use',
        id: item.call_id || item.id || generateId('toolu'),
        name: item.name,
        input: safeJsonParse(item.arguments, {}),
      })
      continue
    }

    if (item.type === 'function_call_output') {
      flushAssistant()
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: item.call_id,
            content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
          },
        ],
      })
    }
  }
  flushAssistant()

  const claude = {
    model: body.model,
    messages,
    max_tokens: body.max_output_tokens || options.defaultMaxTokens || 4096,
    stream: body.stream === true,
  }

  if (system) {
    claude.system = system
  }

  if (Array.isArray(body.tools)) {
    claude.tools = body.tools
      .filter((tool) => tool && (tool.type === 'function' || tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.parameters || tool.input_schema || { type: 'object', properties: {} },
      }))
  }

  if (body.tool_choice === 'auto') {
    claude.tool_choice = { type: 'auto' }
  } else if (body.tool_choice === 'required') {
    claude.tool_choice = { type: 'any' }
  } else if (body.tool_choice === 'none') {
    claude.tool_choice = { type: 'none' }
  } else if (body.tool_choice?.type === 'function' && body.tool_choice.name) {
    claude.tool_choice = { type: 'tool', name: body.tool_choice.name }
  }

  const effort = body.reasoning?.effort
  if (effort) {
    const mapped = thinkingMap.effortToClaudeThinking(effort, { supportsAdaptive: true })
    if (mapped?.thinking) {
      claude.thinking = mapped.thinking
    }
    if (mapped?.output_config) {
      claude.output_config = mapped.output_config
    }
    thinkingMap.applyThinkingSamplingRules(claude, thinkingMap.isThinkingEnabled(claude.thinking))
  }

  return claude
}

export const convertResponsesResultToClaudeMessage = (responseData) => {
  const response = responseData?.response || responseData || {}
  const output = Array.isArray(response.output) ? response.output : []
  const content = []
  let stopReason = 'end_turn'

  for (const item of output) {
    if (!item) {
      continue
    }
    if (item.type === 'reasoning') {
      const text = Array.isArray(item.summary) ? item.summary.map((entry) => entry?.text || '').join('\n') : ''
      content.push({
        type: 'thinking',
        thinking: text,
        // 仅 encrypted_content 才是可回传的签名；item.id 不是 signature，伪会造成续聊失败
        ...(item.encrypted_content ? { signature: item.encrypted_content } : {}),
      })
    } else if (item.type === 'message') {
      const parts = Array.isArray(item.content) ? item.content : []
      for (const part of parts) {
        if (part?.type === 'output_text') {
          content.push({ type: 'text', text: part.text || '' })
        }
      }
    } else if (item.type === 'function_call') {
      stopReason = 'tool_use'
      content.push({
        type: 'tool_use',
        id: item.call_id || item.id || generateId('toolu'),
        name: item.name,
        input: safeJsonParse(item.arguments, {}),
      })
    }
  }

  const usage = response.usage || {}
  const inputTokens = usage.input_tokens || 0
  const outputTokens = usage.output_tokens || 0
  const cached = usage.input_tokens_details?.cached_tokens || 0

  return {
    id: response.id || generateId('msg'),
    type: 'message',
    role: 'assistant',
    model: response.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, inputTokens - cached),
      output_tokens: outputTokens,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: usage.input_tokens_details?.cache_write_tokens || 0,
    },
  }
}

export const createClaudeFromResponsesStreamState = () => ({
  messageId: generateId('msg'),
  model: '',
  contentIndex: -1,
  textStarted: false,
  thinkingStarted: false,
  toolIndexByCallId: new Map(),
  started: false,
  stopped: false,
})

// Responses SSE event → Anthropic SSE event 对象数组
export const convertResponsesStreamEventToClaude = (eventData, state) => {
  if (!eventData || !eventData.type) {
    return []
  }
  const events = []
  const { type } = eventData

  const push = (event, data) => {
    events.push({ event, data: { type: event, ...data } })
  }

  if (type === 'response.created') {
    state.messageId = eventData.response?.id || state.messageId
    state.model = eventData.response?.model || state.model
    if (!state.started) {
      state.started = true
      push('message_start', {
        message: {
          id: state.messageId,
          type: 'message',
          role: 'assistant',
          model: state.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    }
    return events
  }

  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    if (!state.thinkingStarted) {
      state.contentIndex += 1
      state.thinkingStarted = true
      push('content_block_start', {
        index: state.contentIndex,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      })
    }
    push('content_block_delta', {
      index: state.contentIndex,
      delta: { type: 'thinking_delta', thinking: eventData.delta || '' },
    })
    return events
  }

  if (type === 'response.output_text.delta') {
    // 文本块开始前必须先关闭 thinking block，否则 Anthropic SSE 非法
    if (state.thinkingStarted) {
      push('content_block_stop', { index: state.contentIndex })
      state.thinkingStarted = false
    }
    if (!state.textStarted) {
      state.contentIndex += 1
      state.textStarted = true
      push('content_block_start', {
        index: state.contentIndex,
        content_block: { type: 'text', text: '' },
      })
    }
    push('content_block_delta', {
      index: state.contentIndex,
      delta: { type: 'text_delta', text: eventData.delta || '' },
    })
    return events
  }

  if (type === 'response.output_item.added' && eventData.item?.type === 'function_call') {
    if (state.textStarted || state.thinkingStarted) {
      push('content_block_stop', { index: state.contentIndex })
      state.textStarted = false
      state.thinkingStarted = false
    }
    state.contentIndex += 1
    const callId = eventData.item.call_id || eventData.item.id || generateId('toolu')
    state.toolIndexByCallId.set(callId, state.contentIndex)
    push('content_block_start', {
      index: state.contentIndex,
      content_block: {
        type: 'tool_use',
        id: callId,
        name: eventData.item.name,
        input: {},
      },
    })
    return events
  }

  if (type === 'response.function_call_arguments.delta') {
    const callId = eventData.call_id || eventData.item_id
    const index = state.toolIndexByCallId.get(callId) ?? state.contentIndex
    push('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: eventData.delta || '' },
    })
    return events
  }

  if (type === 'response.function_call_arguments.done' || type === 'response.output_item.done') {
    if (eventData.item?.type === 'function_call' || type === 'response.function_call_arguments.done') {
      const callId = eventData.item?.call_id || eventData.call_id || eventData.item_id
      const index = state.toolIndexByCallId.get(callId) ?? state.contentIndex
      push('content_block_stop', { index })
    }
    return events
  }

  if (type === 'response.completed') {
    if (state.textStarted || state.thinkingStarted) {
      push('content_block_stop', { index: state.contentIndex })
      state.textStarted = false
      state.thinkingStarted = false
    }
    const usage = eventData.response?.usage || {}
    const cached = usage.input_tokens_details?.cached_tokens || 0
    const hasTool = Array.isArray(eventData.response?.output)
      ? eventData.response.output.some((item) => item?.type === 'function_call')
      : false
    push('message_delta', {
      delta: { stop_reason: hasTool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: {
        output_tokens: usage.output_tokens || 0,
        input_tokens: Math.max(0, (usage.input_tokens || 0) - cached),
        cache_read_input_tokens: cached,
      },
    })
    push('message_stop', {})
    state.stopped = true
    return events
  }

  if (type === 'response.failed' || type === 'error') {
    push('error', {
      error: {
        type: 'api_error',
        message: eventData.response?.error?.message || eventData.message || 'upstream failed',
      },
    })
  }

  return events
}

export const registerClaudeResponsesTranslators = () => {
  registerTranslator({
    from: TranslatorFormat.claudeMessages,
    to: TranslatorFormat.openaiResponses,
    quality: TranslatorQuality.good,
    convertRequest: (request, options) => convertClaudeRequestToResponses(request, options),
    convertResponse: (response) => convertResponsesResultToClaudeMessage(response),
    createStreamState: () => createClaudeFromResponsesStreamState(),
    convertStreamChunk: (chunk, state) => convertResponsesStreamEventToClaude(chunk, state),
  })

  registerTranslator({
    from: TranslatorFormat.openaiResponses,
    to: TranslatorFormat.claudeMessages,
    quality: TranslatorQuality.good,
    convertRequest: (request, options) => convertResponsesRequestToClaude(request, options),
    convertResponse: (response) => convertResponsesResultToClaudeMessage(response),
  })
}
