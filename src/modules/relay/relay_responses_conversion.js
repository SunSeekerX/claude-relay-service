import crypto from 'node:crypto'
import { LIMITS } from '../../infra/redis_key.js'
import { adaptResponsesTools } from './relay_responses_tools.js'
import { buildOpenAIChatGeminiRequest } from './relay_openai_gemini_request.js'
import {
  effortToClaudeThinking,
  convertLevelToBudget
} from './translator/relay_translator_thinking.js'
import { normalizeGeminiTokenUsage } from './relay_request_detail_helper.js'

export const responsesConversionError = (message, code = 'unsupported_parameter') =>
  Object.assign(new Error(message), { statusCode: 400, code })
const encodeSignature = (provider, value) =>
  value ? `crs:${provider}:v1:${Buffer.from(value).toString('base64url')}` : undefined
const decodeSignature = (provider, value) =>
  typeof value === 'string' && value.startsWith(`crs:${provider}:v1:`)
    ? Buffer.from(value.slice(`crs:${provider}:v1:`.length), 'base64url').toString()
    : null
const textOf = (parts) =>
  typeof parts === 'string' ? parts : (parts ?? []).map((part) => part.text ?? '').join('\n')
const responseId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

const validateParts = (content) => {
  if (typeof content === 'string') {
    return
  }
  if (!Array.isArray(content)) {
    throw responsesConversionError('Content must be text or content parts')
  }
  for (const part of content) {
    if (
      ![
        'input_text',
        'output_text',
        'text',
        'input_image',
        'image_url',
        'input_file',
        'refusal'
      ].includes(part.type)
    ) {
      throw responsesConversionError(`Unsupported content part: ${part.type}`)
    }
    if (part.type === 'input_file' && !part.file_data && !part.file_url) {
      throw responsesConversionError('Provider-scoped file IDs cannot be shared across providers')
    }
  }
}

export const buildResponsesProviderRequest = (source, provider) => {
  if (
    source.max_output_tokens !== undefined &&
    (!Number.isSafeInteger(source.max_output_tokens) || source.max_output_tokens <= 0)
  ) {
    throw responsesConversionError('max_output_tokens must be a positive integer')
  }
  for (const field of ['background', 'conversation']) {
    if (source[field]) {
      throw responsesConversionError(`${field} is unavailable on this provider bridge`)
    }
  }
  const adapter = adaptResponsesTools(source)
  const { body } = adapter
  const messages = []
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions })
  }
  const input =
    typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input
  if (!Array.isArray(input)) {
    throw responsesConversionError('input must be text or an array', 'invalid_request')
  }
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      throw responsesConversionError('Invalid input item', 'invalid_request')
    }
    if (item.type === 'compaction' || item.type === 'agent_message') {
      const text = textOf(item.summary ?? item.content)
      if (!text) {
        throw responsesConversionError(
          'This private compaction block cannot be recovered; resend visible conversation history',
          'compaction_not_replayable'
        )
      }
      messages.push({ role: 'assistant', content: text })
    } else if (item.type === 'reasoning') {
      const text = textOf(item.summary ?? item.content)
      const signature = decodeSignature(provider, item.encrypted_content)
      if (text || signature) {
        messages.push({ role: 'assistant', content: text, _thinkingSignature: signature })
      }
    } else if (item.type === 'function_call') {
      let args
      try {
        args = JSON.parse(item.arguments ?? '{}')
      } catch {
        throw responsesConversionError(
          'Tool arguments must be valid JSON',
          'invalid_tool_arguments'
        )
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw responsesConversionError('Tool arguments must be a JSON object')
      }
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: item.call_id ?? item.id,
            type: 'function',
            function: { name: item.name, arguments: JSON.stringify(args) },
            extra_content: {
              google: { thought_signature: decodeSignature('gemini', item.encrypted_content) }
            }
          }
        ]
      })
    } else if (item.type === 'function_call_output') {
      const content =
        typeof item.output === 'string' || Array.isArray(item.output)
          ? item.output
          : JSON.stringify(item.output ?? '')
      validateParts(content)
      messages.push({ role: 'tool', tool_call_id: item.call_id, content })
    } else if (item.type === 'message' || item.role) {
      const content = item.content ?? ''
      validateParts(content)
      messages.push({ role: item.role, content })
    } else {
      throw responsesConversionError(`Unsupported input item: ${item.type}`)
    }
  }
  if (messages.every((message) => ['system', 'developer'].includes(message.role))) {
    throw responsesConversionError('At least one conversation item is required')
  }
  const chat = {
    model: body.model,
    messages,
    stream: body.stream === true,
    max_tokens: body.max_output_tokens ?? 4096,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.tools
      ? {
          tools: body.tools.map((tool) =>
            tool.type === 'function'
              ? {
                  type: 'function',
                  function: {
                    name: tool.name,
                    parameters: tool.parameters,
                    description: tool.description,
                    strict: tool.strict
                  }
                }
              : tool
          )
        }
      : {})
  }
  if (body.tool_choice !== undefined) {
    chat.tool_choice =
      typeof body.tool_choice === 'object'
        ? { type: 'function', function: { name: body.tool_choice.name } }
        : body.tool_choice
  }
  if (body.text?.format) {
    chat.response_format =
      body.text.format.type === 'json_schema'
        ? { type: 'json_schema', json_schema: body.text.format }
        : body.text.format
  }
  if (provider === 'gemini') {
    if (body.parallel_tool_calls === false) {
      throw responsesConversionError('This Gemini target cannot disable parallel tool calls')
    }
    if (body.service_tier && !['auto', 'default'].includes(body.service_tier)) {
      throw responsesConversionError('This service_tier has no Gemini equivalent')
    }
    const native = buildOpenAIChatGeminiRequest(chat)
    if (body.reasoning?.effort) {
      native.generationConfig ??= {}
      native.generationConfig.thinkingConfig = /^gemini-3/i.test(body.model)
        ? {
            thinkingLevel:
              {
                none: 'MINIMAL',
                minimal: 'MINIMAL',
                low: 'LOW',
                medium: 'MEDIUM',
                high: 'HIGH',
                xhigh: 'HIGH',
                max: 'HIGH'
              }[body.reasoning.effort] ?? 'HIGH'
          }
        : {
            thinkingBudget:
              body.reasoning.effort === 'none'
                ? 0
                : convertLevelToBudget(body.reasoning.effort).budget
          }
    }
    return { request: { ...native, model: body.model, stream: body.stream === true }, adapter }
  }
  const parts = (content) => {
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }]
    }
    return content.map((part) => {
      if (['input_text', 'output_text', 'text', 'refusal'].includes(part.type)) {
        return { type: 'text', text: part.text ?? part.refusal ?? '' }
      }
      const image = part.type === 'input_image' || part.type === 'image_url'
      const value = image
        ? (part.image_url?.url ?? part.image_url)
        : (part.file_data ?? part.file_url)
      if (typeof value !== 'string') {
        throw responsesConversionError('A media URL or base64 value is required')
      }
      const data = value.match(/^data:([^;]+);base64,(.+)$/s)
      const mediaSource = data
        ? { type: 'base64', media_type: data[1], data: data[2] }
        : /^https?:\/\//.test(value)
          ? { type: 'url', url: value }
          : !image
            ? { type: 'base64', media_type: 'application/pdf', data: value }
            : null
      if (!mediaSource) {
        throw responsesConversionError('Unsupported media source')
      }
      return {
        type: image ? 'image' : 'document',
        source: mediaSource,
        ...(!image && part.filename ? { title: part.filename } : {})
      }
    })
  }
  const native = {
    model: body.model,
    max_tokens: chat.max_tokens,
    stream: chat.stream,
    messages: []
  }
  const system = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      system.push(...parts(message.content))
      continue
    }
    if (message.role === 'tool') {
      native.messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id,
            content: parts(message.content)
          }
        ]
      })
      continue
    }
    if (!['assistant', 'user'].includes(message.role)) {
      throw responsesConversionError('Unsupported message role')
    }
    const content = message._thinkingSignature
      ? [
          {
            type: 'thinking',
            thinking: textOf(message.content),
            signature: message._thinkingSignature
          }
        ]
      : parts(message.content)
    for (const call of message.tool_calls ?? []) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments)
      })
    }
    native.messages.push({ role: message.role, content })
  }
  if (system.length) {
    native.system = system
  }
  if (body.tools) {
    native.tools = body.tools.map((tool) => {
      if (tool.type !== 'function') {
        throw responsesConversionError(`Unsupported Claude tool: ${tool.type}`)
      }
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters ?? { type: 'object', properties: {} }
      }
    })
  }
  if (body.tool_choice !== undefined) {
    native.tool_choice =
      typeof body.tool_choice === 'object'
        ? { type: 'tool', name: body.tool_choice.name }
        : { type: { auto: 'auto', none: 'none', required: 'any' }[body.tool_choice] }
    if (!native.tool_choice.type) {
      throw responsesConversionError('Unsupported tool_choice')
    }
    if (body.parallel_tool_calls === false) {
      native.tool_choice.disable_parallel_tool_use = true
    }
  } else if (body.parallel_tool_calls === false && native.tools?.length) {
    native.tool_choice = { type: 'auto', disable_parallel_tool_use: true }
  }
  for (const field of ['temperature', 'top_p']) {
    if (body[field] !== undefined) {
      native[field] = body[field]
    }
  }
  if (body.service_tier !== undefined) {
    if (!['auto', 'default'].includes(body.service_tier)) {
      throw responsesConversionError('This service_tier has no Claude equivalent')
    }
    native.service_tier = body.service_tier === 'default' ? 'standard_only' : 'auto'
  }
  if (body.text?.format?.type === 'json_object') {
    native.output_config = {
      format: { type: 'json_schema', schema: { type: 'object', additionalProperties: true } }
    }
  }
  if (body.text?.format?.type === 'json_schema') {
    native.output_config = { format: { type: 'json_schema', schema: body.text.format.schema } }
  }
  const thinking = effortToClaudeThinking(body.reasoning?.effort, { modelId: body.model })
  if (thinking) {
    Object.assign(native, thinking, {
      output_config: { ...native.output_config, ...thinking.output_config }
    })
  }
  if (native.thinking?.type === 'enabled') {
    if (native.max_tokens <= 1024) {
      throw responsesConversionError('Thinking requires max_output_tokens greater than 1024')
    }
    native.thinking.budget_tokens = Math.min(native.thinking.budget_tokens, native.max_tokens - 1)
  }
  return { request: native, adapter }
}

export class ProviderResponsesState {
  constructor(provider, model, adapter) {
    this.provider = provider
    this.adapter = adapter
    this.id = responseId('resp')
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.output = []
    this.blocks = new Map()
    this.sequence = 0
    this.stopReason = null
    this.usage = null
    this.error = null
    this.ended = false
    this.outputBytes = 0
  }
  event(type, data = {}) {
    return { type, sequence_number: this.sequence++, ...data }
  }
  adaptedEvent(event) {
    const events = this.adapter.restoreEvent(event)
    this.sequence += events.length - 1
    return events.map((output, index) => ({
      ...output,
      sequence_number: event.sequence_number + index
    }))
  }
  response(status = 'in_progress') {
    return {
      id: this.id,
      object: 'response',
      created_at: this.created,
      model: this.model,
      status,
      output: this.output.map((item) => this.adapter.restoreItem({ ...item })),
      usage: this.usage
    }
  }
  start() {
    return [
      this.event('response.created', { response: this.response() }),
      this.event('response.in_progress', { response: this.response() })
    ]
  }
  addBlock(key, block) {
    this.outputBytes += Buffer.byteLength(JSON.stringify(block))
    if (this.outputBytes > LIMITS.responsesContextBytes) {
      throw new Error('Provider output exceeds the bridge resource budget')
    }
    if (!['tool_use', 'thinking', 'text'].includes(block.type)) {
      throw new Error('Unsupported provider content block')
    }
    const outputIndex = this.output.length
    const item =
      block.type === 'tool_use'
        ? {
            type: 'function_call',
            id: responseId('fc'),
            call_id: block.id ?? responseId('call'),
            name: block.name,
            arguments: '',
            status: 'in_progress'
          }
        : block.type === 'thinking'
          ? {
              type: 'reasoning',
              id: responseId('rs'),
              summary: [{ type: 'summary_text', text: block.thinking ?? '' }]
            }
          : {
              type: 'message',
              id: responseId('msg'),
              role: 'assistant',
              status: 'in_progress',
              content: [{ type: 'output_text', text: block.text ?? '', annotations: [] }]
            }
    if (block.signature) {
      item.encrypted_content = encodeSignature(this.provider, block.signature)
    }
    this.blocks.set(key, { item, outputIndex, args: '', initialInput: block.input, closed: false })
    this.output.push(item)
    const added =
      item.type === 'message'
        ? { ...item, content: [] }
        : item.type === 'reasoning'
          ? { ...item, summary: [] }
          : { ...item }
    const events = this.adaptedEvent(
      this.event('response.output_item.added', { output_index: outputIndex, item: added })
    )
    if (item.type === 'message') {
      events.push(
        this.event('response.content_part.added', {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          part: { ...item.content[0], text: '' }
        })
      )
    }
    if (item.type === 'reasoning') {
      events.push(
        this.event('response.reasoning_summary_part.added', {
          item_id: item.id,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' }
        })
      )
    }
    if (block.text || block.thinking) {
      events.push(
        this.event(
          item.type === 'reasoning'
            ? 'response.reasoning_summary_text.delta'
            : 'response.output_text.delta',
          {
            item_id: item.id,
            output_index: outputIndex,
            ...(item.type === 'reasoning' ? { summary_index: 0 } : { content_index: 0 }),
            delta: block.text ?? block.thinking
          }
        )
      )
    }
    return events
  }
  delta(key, delta) {
    this.outputBytes += Buffer.byteLength(
      delta.text ?? delta.thinking ?? delta.partial_json ?? delta.signature ?? ''
    )
    if (this.outputBytes > LIMITS.responsesContextBytes) {
      throw new Error('Provider output exceeds the bridge resource budget')
    }
    const block = this.blocks.get(key)
    if (!block || block.closed) {
      throw new Error('Provider delta references an unavailable content block')
    }
    const { item, outputIndex } = block
    const common = { item_id: item.id, output_index: outputIndex }
    if (delta.type === 'signature_delta') {
      item.encrypted_content = encodeSignature(this.provider, delta.signature)
      return []
    }
    if (item.type === 'function_call') {
      block.args += delta.partial_json ?? ''
      item.arguments = block.args
      return this.adaptedEvent(
        this.event('response.function_call_arguments.delta', {
          ...common,
          delta: delta.partial_json ?? ''
        })
      )
    }
    const thinking = item.type === 'reasoning'
    const text = delta.text ?? delta.thinking ?? ''
    if (thinking) {
      item.summary[0].text += text
    } else {
      item.content[0].text += text
    }
    return [
      this.event(
        thinking ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta',
        { ...common, ...(thinking ? { summary_index: 0 } : { content_index: 0 }), delta: text }
      )
    ]
  }
  close(key) {
    const block = this.blocks.get(key)
    if (!block || block.closed) {
      return []
    }
    block.closed = true
    const { item, outputIndex } = block
    const common = { item_id: item.id, output_index: outputIndex }
    const events = []
    if (item.type === 'function_call') {
      item.arguments = block.args || JSON.stringify(block.initialInput ?? {})
      JSON.parse(item.arguments)
      events.push(
        ...this.adaptedEvent(
          this.event('response.function_call_arguments.done', {
            ...common,
            arguments: item.arguments
          })
        )
      )
    } else if (item.type === 'message') {
      events.push(
        this.event('response.output_text.done', {
          ...common,
          content_index: 0,
          text: item.content[0].text
        })
      )
      events.push(
        this.event('response.content_part.done', {
          ...common,
          content_index: 0,
          part: item.content[0]
        })
      )
    } else {
      events.push(
        this.event('response.reasoning_summary_text.done', {
          ...common,
          summary_index: 0,
          text: item.summary[0].text
        })
      )
      events.push(
        this.event('response.reasoning_summary_part.done', {
          ...common,
          summary_index: 0,
          part: item.summary[0]
        })
      )
    }
    if (item.type !== 'reasoning') {
      item.status = 'completed'
    }
    events.push(
      this.event('response.output_item.done', {
        output_index: outputIndex,
        item: this.adapter.restoreItem({ ...item })
      })
    )
    return events
  }
  updateUsage(raw) {
    if (!raw) {
      return
    }
    if (this.provider === 'gemini') {
      const usage = normalizeGeminiTokenUsage(raw)
      this.usage = {
        input_tokens: usage.inputTokens + usage.cacheReadTokens,
        output_tokens: usage.outputTokens + (raw.thoughtsTokenCount ?? 0),
        total_tokens:
          usage.inputTokens +
          usage.cacheReadTokens +
          usage.outputTokens +
          (raw.thoughtsTokenCount ?? 0),
        input_tokens_details: { cached_tokens: usage.cacheReadTokens },
        output_tokens_details: { reasoning_tokens: raw.thoughtsTokenCount ?? 0 }
      }
    } else {
      const previous = this.usage ?? { input_tokens: 0, output_tokens: 0, input_tokens_details: {} }
      const cached = raw.cache_read_input_tokens ?? previous.input_tokens_details.cached_tokens ?? 0
      const created =
        raw.cache_creation_input_tokens ?? previous.input_tokens_details.cache_write_tokens ?? 0
      this.usage = {
        input_tokens:
          (raw.input_tokens ??
            previous.input_tokens -
              (previous.input_tokens_details.cached_tokens ?? 0) -
              (previous.input_tokens_details.cache_write_tokens ?? 0)) +
          cached +
          created,
        output_tokens: raw.output_tokens ?? previous.output_tokens,
        input_tokens_details: { cached_tokens: cached, cache_write_tokens: created }
      }
      this.usage.total_tokens = this.usage.input_tokens + this.usage.output_tokens
    }
  }
  observe(data) {
    if (data.error || data.type === 'error') {
      this.error = data.error ?? { message: 'Provider stream failed' }
      return []
    }
    if (this.provider === 'claude') {
      if (data.type === 'message_start') {
        this.updateUsage(data.message?.usage)
        return []
      }
      if (data.type === 'content_block_start') {
        return this.addBlock(data.index, data.content_block)
      }
      if (data.type === 'content_block_delta') {
        return this.delta(data.index, data.delta)
      }
      if (data.type === 'content_block_stop') {
        return this.close(data.index)
      }
      if (data.type === 'message_delta') {
        this.updateUsage(data.usage)
        this.stopReason = data.delta?.stop_reason ?? this.stopReason
      }
      if (data.type === 'message_stop') {
        this.ended = true
      }
      return []
    }
    const response = data.response ?? data
    this.updateUsage(response.usageMetadata)
    const events = []
    const candidate = response.candidates?.[0]
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        const key = part.functionCall.id ?? responseId('tool')
        events.push(
          ...this.addBlock(key, {
            type: 'tool_use',
            id: key,
            name: part.functionCall.name,
            input: part.functionCall.args,
            signature: part.thoughtSignature
          })
        )
        events.push(...this.close(key))
      } else if (typeof part.text === 'string') {
        const key = part.thought ? 'thinking' : 'text'
        if (!this.blocks.has(key)) {
          events.push(...this.addBlock(key, { type: part.thought ? 'thinking' : 'text' }))
        }
        events.push(
          ...this.delta(key, {
            type: part.thought ? 'thinking_delta' : 'text_delta',
            text: part.text
          })
        )
        if (part.thoughtSignature) {
          this.blocks.get(key).item.encrypted_content = encodeSignature(
            'gemini',
            part.thoughtSignature
          )
        }
      } else {
        throw new Error('Unsupported provider output content')
      }
    }
    if (candidate?.finishReason) {
      this.stopReason = candidate.finishReason
      this.ended = true
    }
    if (response.promptFeedback?.blockReason) {
      this.error = { code: 'content_filter', message: 'Provider blocked the request' }
      this.ended = true
    }
    return events
  }
  fromMessage(message) {
    if (this.provider === 'gemini') {
      this.observe(message)
      return
    }
    if (message.type !== 'message') {
      throw new Error('Provider did not return a message')
    }
    this.updateUsage(message.usage)
    for (const [index, block] of (message.content ?? []).entries()) {
      this.addBlock(index, block)
      this.close(index)
    }
    this.stopReason = message.stop_reason
    this.ended = typeof message.stop_reason === 'string'
  }
  finish() {
    const events = [...this.blocks.keys()].flatMap((key) => this.close(key))
    if (!this.ended && !this.error) {
      this.error = {
        code: 'upstream_stream_incomplete',
        message: 'Provider stream ended without a terminal event'
      }
    }
    const incomplete = [
      'max_tokens',
      'MAX_TOKENS',
      'SAFETY',
      'RECITATION',
      'content_filter'
    ].includes(this.stopReason)
    const response = this.response(this.error ? 'failed' : incomplete ? 'incomplete' : 'completed')
    if (this.error) {
      response.error = {
        type: 'api_error',
        code: this.error.code ?? 'upstream_error',
        message: 'Provider response failed'
      }
    }
    if (incomplete) {
      response.incomplete_details = {
        reason: ['max_tokens', 'MAX_TOKENS'].includes(this.stopReason)
          ? 'max_output_tokens'
          : 'content_filter'
      }
    }
    return {
      response,
      events: [...events, this.event(`response.${response.status}`, { response })]
    }
  }
}
