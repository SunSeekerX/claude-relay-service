// Claude Messages ↔ OpenAI Responses 双向转换（对齐 CLIProxyAPI/sub2api 核心字段）
import * as thinkingMap from './relay_translator_thinking.js'
import { TranslatorFormat, TranslatorQuality } from './relay_translator_formats.js'
import { registerTranslator } from './relay_translator_registry.js'
import { normalizeOpenAITokenUsage } from '../relay_request_detail_helper.js'
import { buildAnthropicClientErrorBody } from '../../../common/client_error_builder.js'
import {
  createClaudeFromResponsesStreamState,
  convertResponsesStreamEventToClaude,
} from './relay_translator_responses_stream.js'
export {
  createClaudeFromResponsesStreamState,
  convertResponsesStreamEventToClaude,
  finishClaudeFromResponsesStream,
} from './relay_translator_responses_stream.js'

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
    } else if (block.type === 'document' && block.source) {
      const { source } = block
      if (source.type === 'text') {
        parts.push({ type: 'input_text', text: source.data ?? '' })
      } else if (source.type === 'content') {
        parts.push(...claudeContentToResponsesInputParts(source.content))
      } else if (source.type === 'base64') {
        parts.push({
          type: 'input_file',
          filename: block.title ?? 'document.pdf',
          file_data: `data:${source.media_type ?? 'application/pdf'};base64,${source.data ?? ''}`,
        })
      } else if (source.type === 'url') {
        parts.push({ type: 'input_file', file_url: source.url })
      } else {
        throw Object.assign(new Error('This document source cannot be shared across providers'), {
          statusCode: 400,
          code: 'unsupported_document_source',
        })
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
        const toolResultFiles = []
        for (const result of toolResults) {
          const parts = Array.isArray(result.content) ? claudeContentToResponsesInputParts(result.content) : null
          const files = parts?.filter((part) => part.type === 'input_file') ?? []
          const outputParts = parts?.filter((part) => part.type !== 'input_file')
          input.push({
            type: 'function_call_output',
            call_id: result.tool_use_id,
            output: parts ? (outputParts.length ? outputParts : '') : String(result.content ?? ''),
          })
          toolResultFiles.push(...files)
        }
        if (other.length > 0 || toolResultFiles.length > 0) {
          input.push({
            type: 'message',
            role: 'user',
            content: [...(other.length ? claudeContentToResponsesInputParts(other) : []), ...toolResultFiles],
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
        for (const block of content) {
          if (block?.type === 'thinking') {
            const reasoningItem = {
              type: 'reasoning',
              summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [],
            }
            if (block.signature) {
              reasoningItem.encrypted_content = block.signature
            }
            input.push(reasoningItem)
          } else if (block?.type === 'text') {
            const previous = input.at(-1)
            const part = { type: 'output_text', text: block.text ?? '' }
            if (previous?.type === 'message' && previous.role === 'assistant') {
              previous.content.push(part)
            } else {
              input.push({ type: 'message', role: 'assistant', content: [part] })
            }
          } else if (block?.type === 'tool_use') {
            input.push({
              type: 'function_call',
              call_id: block.id || generateId('call'),
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            })
          }
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
    parallel_tool_calls: options.parallelToolCalls !== false && body.tool_choice?.disable_parallel_tool_use !== true,
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
  if (response.error || response.status === 'failed' || response.status === 'cancelled') {
    return buildAnthropicClientErrorBody({ statusCode: 502, upstreamBody: response })
  }
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

  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason
    if (reason === 'max_output_tokens' || reason === 'max_tokens') {
      stopReason = 'max_tokens'
    } else if (reason === 'content_filter') {
      stopReason = 'refusal'
    } else {
      return buildAnthropicClientErrorBody({ statusCode: 502 })
    }
  }
  const usage = normalizeOpenAITokenUsage(response.usage ?? {})

  return {
    id: response.id || generateId('msg'),
    type: 'message',
    role: 'assistant',
    model: response.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      cache_creation_input_tokens: usage.cacheCreateTokens,
    },
  }
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
