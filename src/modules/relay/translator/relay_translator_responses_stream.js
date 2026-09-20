import { buildAnthropicClientErrorBody } from '../../../common/client_error_builder.js'
import { normalizeOpenAITokenUsage } from '../relay_request_detail_helper.js'
import { getResponsesTerminalType, isResponsesRateLimitError } from '../relay_responses_stream_state.js'

export const createClaudeFromResponsesStreamState = () => ({
  messageId: `msg_${Math.random().toString(36).slice(2, 12)}`,
  model: '',
  blocks: [],
  blocksByKey: new Map(),
  nextBlock: 0,
  contentIndex: 0,
  started: false,
  stopped: false,
})

const event = (type, fields = {}) => ({ event: type, data: { type, ...fields } })

const startMessage = (state) => {
  if (state.started) {
    return []
  }
  state.started = true
  return [
    event('message_start', {
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
    }),
  ]
}

const getBlock = (state, data, item = null, kind = null) => {
  const keys = []
  if (data.output_index !== undefined) {
    keys.push(`output:${data.output_index}`)
  }
  for (const id of [item?.id, data.item_id]) {
    if (id) {
      keys.push(`item:${id}`)
    }
  }
  for (const id of [item?.call_id, data.call_id]) {
    if (id) {
      keys.push(`call:${id}`)
    }
  }
  let block = keys.map((key) => state.blocksByKey.get(key)).find(Boolean)
  if (!block) {
    if (!kind) {
      throw new Error('Tool arguments arrived without a matching function call')
    }
    block = {
      kind,
      text: '',
      reasoningText: '',
      emitted: 0,
      signature: '',
      callId: item?.call_id ?? item?.id,
      name: item?.name,
      index: null,
      started: false,
      done: false,
      closed: false,
    }
    state.blocks.push(block)
  }
  for (const key of keys) {
    const existing = state.blocksByKey.get(key)
    if (existing && existing !== block) {
      throw new Error('Conflicting Responses item identifiers')
    }
    state.blocksByKey.set(key, block)
  }
  return block
}

const reconcileText = (block, text) => {
  if (typeof text !== 'string' || !text) {
    return
  }
  if (text === block.text) {
    return
  }
  if (!text.startsWith(block.text) && block.emitted > 0) {
    throw new Error('Final Responses content conflicts with emitted deltas')
  }
  if (block.closed && text !== block.text) {
    throw new Error('Responses content changed after the block ended')
  }
  block.text = text
}

// Anthropic 内容块按创建顺序输出；并行工具的后续块缓存到前一块关闭。
const drainBlocks = (state) => {
  const events = []
  while (state.nextBlock < state.blocks.length) {
    const block = state.blocks[state.nextBlock]
    if (!block.started) {
      if (block.kind !== 'tool_use' && !block.text && !block.signature) {
        if (block.done) {
          state.nextBlock += 1
          continue
        }
        break
      }
      events.push(...startMessage(state))
      block.index = state.contentIndex++
      block.started = true
      const content =
        block.kind === 'tool_use'
          ? { type: 'tool_use', id: block.callId, name: block.name, input: {} }
          : block.kind === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : { type: 'text', text: '' }
      events.push(event('content_block_start', { index: block.index, content_block: content }))
    }
    if (block.emitted < block.text.length) {
      const delta = block.text.slice(block.emitted)
      events.push(
        event('content_block_delta', {
          index: block.index,
          delta:
            block.kind === 'tool_use'
              ? { type: 'input_json_delta', partial_json: delta }
              : block.kind === 'thinking'
                ? { type: 'thinking_delta', thinking: delta }
                : { type: 'text_delta', text: delta },
        }),
      )
      block.emitted = block.text.length
    }
    if (!block.done) {
      break
    }
    if (block.kind === 'tool_use' && block.text) {
      JSON.parse(block.text)
    }
    if (block.kind === 'thinking' && block.signature) {
      events.push(
        event('content_block_delta', {
          index: block.index,
          delta: { type: 'signature_delta', signature: block.signature },
        }),
      )
    }
    events.push(event('content_block_stop', { index: block.index }))
    block.closed = true
    state.nextBlock += 1
  }
  return events
}

const finishItem = (state, data, item, { terminal = false } = {}) => {
  const kind =
    item.type === 'function_call'
      ? 'tool_use'
      : item.type === 'reasoning'
        ? 'thinking'
        : item.type === 'message'
          ? 'text'
          : null
  if (!kind) {
    return
  }
  const block = getBlock(state, data, item, kind)
  if (kind === 'tool_use') {
    if (!block.callId || !block.name) {
      throw new Error('Function call is missing its identity')
    }
    reconcileText(block, item.arguments)
  } else if (kind === 'thinking') {
    const summary = item.summary?.map((part) => part.text ?? '').join('\n')
    const content = item.content
      ?.filter((part) => part.type === 'reasoning_text')
      .map((part) => part.text ?? '')
      .join('')
    const text = summary || block.text || content || block.reasoningText
    reconcileText(block, text)
    block.signature = item.encrypted_content ?? block.signature
  } else {
    const text = item.content
      ?.filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('')
    reconcileText(block, text)
  }
  // 一些兼容上游只在最终 response.output 补全密文；关闭 thinking 前等待它。
  block.done = kind !== 'thinking' || Boolean(block.signature) || terminal
}

export const finishClaudeFromResponsesStream = (state, upstreamError = null) => {
  if (state.stopped) {
    return []
  }
  state.stopped = true
  const errorBody = buildAnthropicClientErrorBody({
    statusCode: isResponsesRateLimitError(upstreamError) ? 429 : 502,
    upstreamBody: upstreamError ? { error: upstreamError } : null,
  })
  return [event('error', { error: errorBody.error })]
}

export const convertResponsesStreamEventToClaude = (data, state) => {
  if (!data || state.stopped) {
    return []
  }
  try {
    const type = getResponsesTerminalType(data) ?? data.type
    if (type === 'response.created') {
      state.messageId = data.response?.id ?? state.messageId
      state.model = data.response?.model ?? state.model
      return startMessage(state)
    }
    if (
      type === 'error' ||
      type === 'response.failed' ||
      data.error ||
      data.response?.error ||
      type === 'response.cancelled' ||
      type === 'response.canceled'
    ) {
      return finishClaudeFromResponsesStream(state, data.response?.error ?? data.error)
    }
    if (type === 'response.output_item.added') {
      const item = data.item ?? {}
      const kind =
        item.type === 'function_call'
          ? 'tool_use'
          : item.type === 'reasoning'
            ? 'thinking'
            : item.type === 'message'
              ? 'text'
              : null
      if (kind) {
        const block = getBlock(state, data, item, kind)
        if (kind === 'thinking') {
          block.signature = item.encrypted_content ?? block.signature
        }
        if (kind === 'tool_use') {
          if (!block.callId || !block.name) {
            throw new Error('Function call is missing its identity')
          }
          reconcileText(block, item.arguments)
        }
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const block = getBlock(state, data)
      if (block.closed || block.kind !== 'tool_use') {
        throw new Error('Tool delta references a closed or non-tool block')
      }
      block.text += data.delta ?? ''
    } else if (type === 'response.function_call_arguments.done') {
      const block = getBlock(state, data)
      reconcileText(block, data.arguments)
      block.done = true
    } else if (type === 'response.reasoning_text.delta') {
      const block = getBlock(state, data, null, 'thinking')
      block.reasoningText += data.delta ?? ''
    } else if (type === 'response.reasoning_summary_text.delta') {
      const block = getBlock(state, data, null, 'thinking')
      if (block.closed) {
        throw new Error('Reasoning delta references a closed block')
      }
      if (data.summary_index !== undefined && block.summaryIndex !== data.summary_index) {
        if (block.text) {
          block.text += '\n'
        }
        block.summaryIndex = data.summary_index
      }
      block.text += data.delta ?? ''
    } else if (type === 'response.output_text.delta') {
      const block = getBlock(state, data, null, 'text')
      if (block.closed) {
        throw new Error('Text delta references a closed block')
      }
      block.text += data.delta ?? ''
    } else if (type === 'response.output_text.done') {
      const block = getBlock(state, data, null, 'text')
      if (!block.text) {
        reconcileText(block, data.text)
      }
    } else if (type === 'response.reasoning_text.done') {
      const block = getBlock(state, data, null, 'thinking')
      block.reasoningText = data.text ?? block.reasoningText
    } else if (type === 'response.reasoning_summary_text.done') {
      const block = getBlock(state, data, null, 'thinking')
      if (!block.text) {
        reconcileText(block, data.text)
      }
    } else if (type === 'response.output_item.done' && data.item) {
      finishItem(state, data, data.item)
    } else if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete') {
      const response = data.response ?? {}
      if (Array.isArray(response.output)) {
        response.output.forEach((item, outputIndex) =>
          finishItem(state, { output_index: outputIndex }, item, { terminal: true }),
        )
      }
      const reason = response.incomplete_details?.reason
      if (type === 'response.incomplete' && !['max_output_tokens', 'max_tokens', 'content_filter'].includes(reason)) {
        return finishClaudeFromResponsesStream(state)
      }
      for (const block of state.blocks) {
        if (block.kind === 'thinking' && !block.text) {
          block.text = block.reasoningText
        }
        block.done = true
      }
      const events = [...startMessage(state), ...drainBlocks(state)]
      const usage = normalizeOpenAITokenUsage(response.usage ?? {})
      const stopReason =
        type === 'response.incomplete'
          ? reason === 'content_filter'
            ? 'refusal'
            : 'max_tokens'
          : state.blocks.some((block) => block.kind === 'tool_use')
            ? 'tool_use'
            : 'end_turn'
      events.push(
        event('message_delta', {
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_read_input_tokens: usage.cacheReadTokens,
            cache_creation_input_tokens: usage.cacheCreateTokens,
          },
        }),
        event('message_stop'),
      )
      state.stopped = true
      return events
    }
    return drainBlocks(state)
  } catch {
    return finishClaudeFromResponsesStream(state)
  }
}
