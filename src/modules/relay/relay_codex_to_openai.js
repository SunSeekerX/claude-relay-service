/**
 * Codex Responses API → OpenAI Chat Completions 格式转换器
 * 将 Codex/OpenAI Responses API 的 SSE 事件转为标准 chat.completion / chat.completion.chunk 格式
 */

export class CodexToOpenAIConverter {
  constructor() {
    // 工具名缩短映射（buildRequestFromOpenAI 填充，响应转换时逆向恢复）
    this._reverseToolNameMap = {}
  }

  createStreamState() {
    return {
      responseId: '',
      createdAt: 0,
      model: '',
      functionCallIndex: -1,
      hasReceivedArgumentsDelta: false,
      hasToolCallAnnounced: false,
      roleSent: false,
    }
  }

  /**
   * 流式转换: 单个已解析的 SSE 事件 → OpenAI chunk SSE 字符串数组
   * @param {Object} eventData - 已解析的 SSE JSON 对象
   * @param {string} model - 请求模型名
   * @param {Object} state - createStreamState() 的返回值
   * @returns {string[]} "data: {...}\n\n" 字符串数组（可能为空）
   */
  convertStreamChunk(eventData, model, state) {
    const { type } = eventData
    if (!type) {
      return []
    }

    switch (type) {
      case 'response.created':
        return this._handleResponseCreated(eventData, state)

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return this._emitChunk(state, model, { reasoning_content: eventData.delta })

      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_text.done':
      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done':
        // done/part 事件仅为结束或结构信号，delta 已通过 .delta 事件发送
        return []

      case 'response.output_text.delta':
        return this._emitChunk(state, model, { content: eventData.delta })

      case 'response.output_item.added':
        return this._handleOutputItemAdded(eventData, model, state)

      case 'response.function_call_arguments.delta':
        return this._handleArgumentsDelta(eventData, model, state)

      case 'response.function_call_arguments.done':
        return this._handleArgumentsDone(eventData, model, state)

      case 'response.custom_tool_call_input.delta':
        // Codex freeform/custom tool：按 function 参数流处理
        return this._handleArgumentsDelta(
          {
            ...eventData,
            delta: eventData.delta,
            call_id: eventData.call_id || eventData.item_id,
          },
          model,
          state,
        )

      case 'response.custom_tool_call_input.done':
        return this._handleArgumentsDone(eventData, model, state)

      case 'response.output_item.done':
        return this._handleOutputItemDone(eventData, model, state)

      case 'response.completed':
        return this._handleResponseCompleted(eventData, model, state)

      case 'response.failed':
      case 'response.incomplete':
        return this._handleResponseError(eventData, model, state)

      case 'response.metadata':
      case 'codex.response.metadata':
      case 'response.in_progress':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_text.done':
        return []

      case 'error':
        return this._handleStreamError(eventData, model, state)

      default:
        return []
    }
  }

  /**
   * 非流式转换: Codex 完整响应 → OpenAI chat.completion
   * @param {Object} responseData - Codex 响应对象或 response.completed 事件
   * @param {string} model - 请求模型名
   * @returns {Object}
   */
  convertResponse(responseData, model) {
    // 自动检测：response.completed 事件包装 vs 直接响应对象
    const resp = responseData.type === 'response.completed' ? responseData.response : responseData

    const message = { role: 'assistant', content: null }
    const toolCalls = []

    const output = resp.output || []
    for (const item of output) {
      if (item.type === 'reasoning') {
        const summaryTexts = (item.summary || []).filter((s) => s.type === 'summary_text').map((s) => s.text)
        if (summaryTexts.length > 0) {
          message.reasoning_content = (message.reasoning_content || '') + summaryTexts.join('')
        }
      } else if (item.type === 'message') {
        const contentTexts = (item.content || []).filter((c) => c.type === 'output_text').map((c) => c.text)
        if (contentTexts.length > 0) {
          message.content = (message.content || '') + contentTexts.join('')
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id || item.id,
          type: 'function',
          function: {
            name: this._restoreToolName(item.name),
            arguments: item.arguments || '{}',
          },
        })
      }
    }

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls
    }

    // response.failed → 返回 error 结构（与流式 _handleResponseError 一致）
    if (resp.status === 'failed') {
      const err = resp.error || {}
      return {
        error: {
          message: err.message || 'Response failed',
          type: err.type || 'server_error',
          code: err.code || null,
        },
      }
    }

    const finishReason = toolCalls.length > 0 ? 'tool_calls' : this._mapResponseStatus(resp)

    const result = {
      id: resp.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: this._parseCreatedAt(resp.created_at),
      model: resp.model || model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
    }

    const usage = this._mapUsage(resp.usage)
    if (usage) {
      result.usage = usage
    }

    return result
  }

  // --- 内部方法：流式事件处理 ---

  _handleResponseCreated(eventData, state) {
    const resp = eventData.response || {}
    state.responseId = resp.id || ''
    if (resp.created_at) {
      state.createdAt = this._parseCreatedAt(resp.created_at)
    }
    state.model = resp.model || ''
    return []
  }

  _handleOutputItemAdded(eventData, model, state) {
    const { item } = eventData
    if (!item) {
      return []
    }
    // function_call + custom_tool_call（Codex freeform）统一映射为 tool_calls
    if (item.type !== 'function_call' && item.type !== 'custom_tool_call') {
      return []
    }

    state.functionCallIndex++
    state.hasToolCallAnnounced = true
    state.hasReceivedArgumentsDelta = false
    const toolName = item.name || 'custom_tool'

    return this._emitChunk(state, model, {
      tool_calls: [
        {
          index: state.functionCallIndex,
          id: item.call_id || item.id,
          type: 'function',
          function: {
            name: this._restoreToolName(toolName),
            arguments: '',
          },
        },
      ],
    })
  }

  _handleArgumentsDelta(eventData, model, state) {
    state.hasReceivedArgumentsDelta = true
    return this._emitChunk(state, model, {
      tool_calls: [
        {
          index: state.functionCallIndex,
          function: { arguments: eventData.delta },
        },
      ],
    })
  }

  _handleArgumentsDone(eventData, model, state) {
    // 如果已收到增量 delta，done 不需要再输出
    if (state.hasReceivedArgumentsDelta) {
      return []
    }

    // custom_tool_call_input.done 用 input；function_call_arguments.done 用 arguments
    const argsRaw = eventData.arguments ?? eventData.input
    const args =
      argsRaw === null || argsRaw === undefined
        ? '{}'
        : typeof argsRaw === 'string'
          ? argsRaw || '{}'
          : JSON.stringify(argsRaw)

    // 没有收到 delta，一次性输出完整参数
    return this._emitChunk(state, model, {
      tool_calls: [
        {
          index: state.functionCallIndex,
          function: { arguments: args },
        },
      ],
    })
  }

  _handleOutputItemDone(eventData, model, state) {
    const { item } = eventData
    // function_call 与 custom_tool_call 均需落成 tool_calls
    if (!item || (item.type !== 'function_call' && item.type !== 'custom_tool_call')) {
      return []
    }

    // 如果已经通过 output_item.added 通知过，不重复输出
    if (state.hasToolCallAnnounced) {
      state.hasToolCallAnnounced = false
      // 若仅有 done 无 delta，补齐 arguments（custom_tool 常把完整 input 放在 item 上）
      const argsRaw = item.arguments ?? item.input
      if (argsRaw !== null && argsRaw !== undefined && !state.hasReceivedArgumentsDelta) {
        const args = typeof argsRaw === 'string' ? argsRaw || '{}' : JSON.stringify(argsRaw)
        return this._emitChunk(state, model, {
          tool_calls: [
            {
              index: state.functionCallIndex,
              function: { arguments: args },
            },
          ],
        })
      }
      return []
    }

    // Fallback：未收到 added 事件，输出完整 tool call
    state.functionCallIndex++
    const argsRaw = item.arguments ?? item.input
    const args =
      argsRaw === null || argsRaw === undefined
        ? '{}'
        : typeof argsRaw === 'string'
          ? argsRaw || '{}'
          : JSON.stringify(argsRaw)
    return this._emitChunk(state, model, {
      tool_calls: [
        {
          index: state.functionCallIndex,
          id: item.call_id || item.id,
          type: 'function',
          function: {
            name: this._restoreToolName(item.name || 'custom_tool'),
            arguments: args,
          },
        },
      ],
    })
  }

  _handleResponseCompleted(eventData, model, state) {
    const resp = eventData.response || {}
    const chunk = this._makeChunk(state, model)

    if (state.functionCallIndex >= 0) {
      chunk.choices[0].finish_reason = 'tool_calls'
    } else {
      chunk.choices[0].finish_reason = this._mapResponseStatus(resp)
    }

    const usage = this._mapUsage(resp.usage)
    if (usage) {
      chunk.usage = usage
    }

    return [`data: ${JSON.stringify(chunk)}\n\n`]
  }

  _handleResponseError(eventData, model, state) {
    const resp = eventData.response || {}
    const results = []

    // response.failed → 转为 error SSE 事件（保留错误语义）
    if (resp.status === 'failed') {
      const err = resp.error || {}
      results.push(
        `data: ${JSON.stringify({
          error: {
            message: err.message || 'Response failed',
            type: err.type || 'server_error',
            code: err.code || null,
          },
        })}\n\n`,
      )
    }

    // response.incomplete 及其他非 failed 状态 → 带 finish_reason 的终止 chunk
    if (resp.status !== 'failed') {
      const chunk = this._makeChunk(state, model)
      if (state.functionCallIndex >= 0) {
        chunk.choices[0].finish_reason = 'tool_calls'
      } else {
        chunk.choices[0].finish_reason = this._mapResponseStatus(resp)
      }
      const usage = this._mapUsage(resp.usage)
      if (usage) {
        chunk.usage = usage
      }
      results.push(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    return results
  }

  _handleStreamError(eventData) {
    // type: "error" → 转为 OpenAI 格式的 error SSE 事件
    const errorObj = {
      error: {
        message: eventData.message || 'Unknown error',
        type: 'server_error',
        code: eventData.code || null,
      },
    }
    return [`data: ${JSON.stringify(errorObj)}\n\n`]
  }

  // --- 工具方法 ---

  _emitChunk(state, model, delta) {
    const chunk = this._makeChunk(state, model)
    if (!state.roleSent) {
      delta.role = 'assistant'
      state.roleSent = true
    }
    chunk.choices[0].delta = delta
    return [`data: ${JSON.stringify(chunk)}\n\n`]
  }

  _makeChunk(state, model) {
    return {
      id: state.responseId || `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: state.createdAt || Math.floor(Date.now() / 1000),
      model: state.model || model,
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    }
  }

  _mapResponseStatus(resp) {
    const { status } = resp
    if (!status || status === 'completed') {
      return 'stop'
    }
    if (status === 'incomplete') {
      const reason = resp.incomplete_details?.reason
      if (reason === 'max_output_tokens') {
        return 'length'
      }
      if (reason === 'content_filter') {
        return 'content_filter'
      }
      return 'length'
    }
    // failed, cancelled, etc.
    return 'stop'
  }

  _parseCreatedAt(createdAt) {
    if (!createdAt) {
      return Math.floor(Date.now() / 1000)
    }
    if (typeof createdAt === 'number') {
      return createdAt
    }
    const ts = Math.floor(new Date(createdAt).getTime() / 1000)
    return isNaN(ts) ? Math.floor(Date.now() / 1000) : ts
  }

  _mapUsage(usage) {
    if (!usage) {
      return undefined
    }
    const result = {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    }
    if (usage.input_tokens_details?.cached_tokens > 0) {
      result.prompt_tokens_details = { cached_tokens: usage.input_tokens_details.cached_tokens }
    }
    if (usage.output_tokens_details?.reasoning_tokens > 0) {
      result.completion_tokens_details = {
        reasoning_tokens: usage.output_tokens_details.reasoning_tokens,
      }
    }
    return result
  }

  // ===
  // 请求转换: Chat Completions → Responses API
  // ===
  // ===

  /**
   * 将 OpenAI Chat Completions 请求体转为 Responses API 格式
   * @param {Object} chatBody - Chat Completions 格式请求体
   * @returns {Object} Responses API 格式请求体
   */
  buildRequestFromOpenAI(chatBody) {
    const result = {}

    if (chatBody.model) {
      result.model = chatBody.model
    }
    if (chatBody.stream !== undefined) {
      result.stream = chatBody.stream
    }

    // messages → input（instructions 由调用方设置，此处只转换消息到 input）
    const input = []

    for (const msg of chatBody.messages || []) {
      switch (msg.role) {
        case 'system':
        case 'developer':
          input.push({
            type: 'message',
            role: 'developer',
            content: this._wrapContent(msg.content, 'user'),
          })
          break

        case 'user':
          input.push({
            type: 'message',
            role: 'user',
            content: this._wrapContent(msg.content, 'user'),
          })
          break

        case 'assistant':
          if (msg.content) {
            input.push({
              type: 'message',
              role: 'assistant',
              content: this._wrapContent(msg.content, 'assistant'),
            })
          }
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            for (const tc of msg.tool_calls) {
              if (tc.type === 'function') {
                input.push({
                  type: 'function_call',
                  call_id: tc.id,
                  name: this._shortenToolName(tc.function?.name || ''),
                  arguments:
                    typeof tc.function?.arguments === 'string'
                      ? tc.function.arguments
                      : JSON.stringify(tc.function?.arguments ?? {}),
                })
              }
            }
          }
          break

        case 'tool':
          input.push({
            type: 'function_call_output',
            call_id: msg.tool_call_id,
            output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          })
          break
      }
    }

    result.input = input

    // temperature/top_p/max_output_tokens 不透传，与上游 Codex API 行为保持一致

    // reasoning 配置
    result.reasoning = {
      effort: chatBody.reasoning_effort || 'medium',
      summary: 'auto',
    }

    // 固定值
    result.parallel_tool_calls = true
    result.include = ['reasoning.encrypted_content']
    result.store = false

    // 收集所有工具名（tools + assistant.tool_calls），统一构建缩短映射
    const allToolNames = new Set()
    if (chatBody.tools) {
      for (const t of chatBody.tools) {
        if (t.type === 'function' && t.function?.name) {
          allToolNames.add(t.function.name)
        }
      }
    }
    for (const msg of chatBody.messages || []) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === 'function' && tc.function?.name) {
            allToolNames.add(tc.function.name)
          }
        }
      }
    }
    if (allToolNames.size > 0) {
      this._toolNameMap = this._buildShortNameMap([...allToolNames])
      this._reverseToolNameMap = {}
      for (const [orig, short] of Object.entries(this._toolNameMap)) {
        if (orig !== short) {
          this._reverseToolNameMap[short] = orig
        }
      }
    }

    // tools 展平
    if (chatBody.tools && chatBody.tools.length > 0) {
      result.tools = this._convertTools(chatBody.tools)
    }

    // tool_choice
    if (chatBody.tool_choice !== undefined) {
      result.tool_choice = this._convertToolChoice(chatBody.tool_choice)
    }

    // response_format → text.format
    if (chatBody.response_format) {
      const text = this._convertResponseFormat(chatBody.response_format)
      if (text && Object.keys(text).length > 0) {
        result.text = text
      }
    }

    // session 字段透传（handleResponses 用于 session hash）
    if (chatBody.session_id) {
      result.session_id = chatBody.session_id
    }
    if (chatBody.conversation_id) {
      result.conversation_id = chatBody.conversation_id
    }
    if (chatBody.prompt_cache_key) {
      result.prompt_cache_key = chatBody.prompt_cache_key
    }

    return result
  }

  // Responses API 请求 → OpenAI Chat Completions 请求（buildRequestFromOpenAI 的逆）
  buildChatRequestFromResponses(responsesBody = {}) {
    const body = responsesBody && typeof responsesBody === 'object' ? responsesBody : {}
    const result = {}

    if (body.model) {
      result.model = body.model
    }
    if (body.stream !== undefined) {
      result.stream = body.stream
    }
    if (body.temperature !== undefined) {
      result.temperature = body.temperature
    }
    if (body.top_p !== undefined) {
      result.top_p = body.top_p
    }
    if (body.max_output_tokens !== undefined) {
      result.max_tokens = body.max_output_tokens
    } else if (body.max_tokens !== undefined) {
      result.max_tokens = body.max_tokens
    }

    const messages = []
    // instructions → system
    if (typeof body.instructions === 'string' && body.instructions.trim()) {
      messages.push({ role: 'system', content: body.instructions })
    }

    const inputItems = Array.isArray(body.input)
      ? body.input
      : typeof body.input === 'string'
        ? [{ type: 'message', role: 'user', content: body.input }]
        : []

    // 合并连续 assistant 文本 + tool_calls
    let pendingAssistant = null
    const flushAssistant = () => {
      if (pendingAssistant) {
        messages.push(pendingAssistant)
        pendingAssistant = null
      }
    }
    const ensureAssistant = () => {
      if (!pendingAssistant) {
        pendingAssistant = { role: 'assistant', content: null, tool_calls: [] }
      }
      return pendingAssistant
    }

    const contentToChatParts = (content, _role) => {
      if (typeof content === 'string') {
        return content
      }
      if (!Array.isArray(content)) {
        return content === null || content === undefined ? '' : String(content)
      }
      const parts = []
      for (const part of content) {
        if (!part || typeof part !== 'object') {
          continue
        }
        if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
          parts.push({ type: 'text', text: part.text || '' })
        } else if (part.type === 'input_image' || part.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || part.image_url
          if (url) {
            parts.push({ type: 'image_url', image_url: { url } })
          }
        }
      }
      if (parts.length === 0) {
        return ''
      }
      // 纯文本折叠为 string，多模态保留 array
      if (parts.every((part) => part.type === 'text')) {
        return parts.map((part) => part.text).join('')
      }
      return parts
    }

    for (const item of inputItems) {
      if (!item || typeof item !== 'object') {
        continue
      }

      if (item.type === 'message' || item.role) {
        const role = item.role || 'user'
        if (role === 'system' || role === 'developer') {
          flushAssistant()
          const text = contentToChatParts(item.content, 'system')
          const str = typeof text === 'string' ? text : JSON.stringify(text)
          if (str) {
            messages.push({ role: 'system', content: str })
          }
          continue
        }
        if (role === 'assistant') {
          const assistant = ensureAssistant()
          const text = contentToChatParts(item.content, 'assistant')
          if (typeof text === 'string' && text) {
            assistant.content = (assistant.content || '') + text
          } else if (Array.isArray(text) && text.length) {
            const prev = typeof assistant.content === 'string' ? assistant.content : ''
            assistant.content = prev ? [{ type: 'text', text: prev }, ...text] : text
          }
          continue
        }
        // user
        flushAssistant()
        messages.push({
          role: 'user',
          content: contentToChatParts(item.content, 'user'),
        })
        continue
      }

      if (item.type === 'function_call') {
        const assistant = ensureAssistant()
        if (!Array.isArray(assistant.tool_calls)) {
          assistant.tool_calls = []
        }
        const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
        assistant.tool_calls.push({
          id: item.call_id || item.id || `call_${messages.length}_${assistant.tool_calls.length}`,
          type: 'function',
          function: {
            name: item.name || '',
            arguments: args,
          },
        })
        continue
      }

      if (item.type === 'function_call_output') {
        flushAssistant()
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        })
        continue
      }

      // reasoning 等控制项：Chat 无对等字段，跳过（thinking 不进 chat messages）
      if (item.type === 'reasoning') {
        continue
      }
    }
    flushAssistant()

    // 清理空 tool_calls
    for (const message of messages) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        if (message.tool_calls.length === 0) {
          delete message.tool_calls
        }
        if (message.content === null || message.content === '') {
          // OpenAI 允许 tool_calls 时 content 为 null
          if (message.tool_calls) {
            message.content = null
          } else {
            message.content = ''
          }
        }
      }
    }

    result.messages = messages

    // tools：Responses 扁平 function → Chat function wrapper
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      result.tools = body.tools
        .filter((tool) => tool && tool.type)
        .map((tool) => {
          if (tool.type !== 'function') {
            return tool
          }
          // 已是 Chat 形态
          if (tool.function && tool.function.name) {
            return tool
          }
          return {
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description || undefined,
              parameters: tool.parameters || { type: 'object', properties: {} },
              ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
            },
          }
        })
        .filter(Boolean)
    }

    // tool_choice
    if (body.tool_choice !== undefined) {
      const toolChoice = body.tool_choice
      if (typeof toolChoice === 'string') {
        result.tool_choice = toolChoice
      } else if (toolChoice && typeof toolChoice === 'object') {
        if (toolChoice.type === 'function' && toolChoice.name) {
          result.tool_choice = {
            type: 'function',
            function: { name: toolChoice.name },
          }
        } else {
          result.tool_choice = toolChoice
        }
      }
    }

    // text.format → response_format
    const format = body.text?.format
    if (format && format.type) {
      if (format.type === 'json_schema') {
        result.response_format = {
          type: 'json_schema',
          json_schema: {
            name: format.name || 'response',
            schema: format.schema || {},
            ...(format.strict !== undefined ? { strict: format.strict } : {}),
          },
        }
      } else if (format.type === 'json_object') {
        result.response_format = { type: 'json_object' }
      } else if (format.type === 'text') {
        result.response_format = { type: 'text' }
      }
    }

    // reasoning.effort → reasoning_effort（Chat 侧常见扩展字段）
    if (body.reasoning?.effort) {
      result.reasoning_effort = body.reasoning.effort
    }

    if (body.session_id) {
      result.session_id = body.session_id
    }
    if (body.conversation_id) {
      result.conversation_id = body.conversation_id
    }
    if (body.prompt_cache_key) {
      result.prompt_cache_key = body.prompt_cache_key
    }

    return result
  }

  // --- 请求转换辅助方法 ---

  _extractTextContent(content) {
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      return content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('')
    }
    return String(content || '')
  }

  _wrapContent(content, role) {
    const textType = role === 'assistant' ? 'output_text' : 'input_text'
    if (typeof content === 'string') {
      return [{ type: textType, text: content }]
    }
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          switch (item.type) {
            case 'text':
              return { type: textType, text: item.text }
            case 'image_url':
              return {
                type: 'input_image',
                image_url: item.image_url?.url || item.image_url,
              }
            default:
              return item
          }
        })
        .filter(Boolean)
    }
    return [{ type: textType, text: String(content || '') }]
  }

  _convertTools(tools) {
    return tools
      .filter((t) => t && t.type)
      .map((t) => {
        // 非 function 工具（web_search、code_interpreter 等）原样透传
        if (t.type !== 'function') {
          return t
        }
        // function 工具展平：去除 function wrapper
        if (!t.function) {
          return null
        }
        const tool = { type: 'function', name: this._shortenToolName(t.function.name) }
        if (t.function.description) {
          tool.description = t.function.description
        }
        if (t.function.parameters) {
          tool.parameters = t.function.parameters
        }
        if (t.function.strict !== undefined) {
          tool.strict = t.function.strict
        }
        return tool
      })
      .filter(Boolean)
  }

  _convertToolChoice(tc) {
    if (typeof tc === 'string') {
      return tc
    }
    if (tc && typeof tc === 'object') {
      if (tc.type === 'function' && tc.function?.name) {
        return { type: 'function', name: this._shortenToolName(tc.function.name) }
      }
      return tc
    }
    return tc
  }

  _convertResponseFormat(rf) {
    if (!rf || !rf.type) {
      return {}
    }
    if (rf.type === 'text') {
      return { format: { type: 'text' } }
    }
    if (rf.type === 'json_schema' && rf.json_schema) {
      const format = { type: 'json_schema' }
      if (rf.json_schema.name) {
        format.name = rf.json_schema.name
      }
      if (rf.json_schema.strict !== undefined) {
        format.strict = rf.json_schema.strict
      }
      if (rf.json_schema.schema) {
        format.schema = rf.json_schema.schema
      }
      return { format }
    }
    return {}
  }

  /**
   * 工具名缩短：优先使用唯一化 map，无 map 时做简单截断
   */
  _shortenToolName(name) {
    if (!name) {
      return name
    }
    if (this._toolNameMap && this._toolNameMap[name]) {
      return this._toolNameMap[name]
    }
    const LIMIT = 64
    if (name.length <= LIMIT) {
      return name
    }
    if (name.startsWith('mcp__')) {
      const idx = name.lastIndexOf('__')
      if (idx > 0) {
        const candidate = `mcp__${name.slice(idx + 2)}`
        return candidate.length > LIMIT ? candidate.slice(0, LIMIT) : candidate
      }
    }
    return name.slice(0, LIMIT)
  }

  /**
   * 构建工具名缩短映射（保证唯一）
   * 构建唯一缩短名映射，处理碰撞
   * @returns {Object} { originalName: shortName }
   */
  _buildShortNameMap(names) {
    const LIMIT = 64
    const used = new Set()
    const map = {}

    const baseCandidate = (n) => {
      if (n.length <= LIMIT) {
        return n
      }
      if (n.startsWith('mcp__')) {
        const idx = n.lastIndexOf('__')
        if (idx > 0) {
          const cand = `mcp__${n.slice(idx + 2)}`
          return cand.length > LIMIT ? cand.slice(0, LIMIT) : cand
        }
      }
      return n.slice(0, LIMIT)
    }

    const makeUnique = (cand) => {
      if (!used.has(cand)) {
        return cand
      }
      const base = cand
      for (let i = 1; ; i++) {
        const suffix = `_${i}`
        const allowed = LIMIT - suffix.length
        const tmp = (base.length > allowed ? base.slice(0, allowed) : base) + suffix
        if (!used.has(tmp)) {
          return tmp
        }
      }
    }

    for (const n of names) {
      const short = makeUnique(baseCandidate(n))
      used.add(short)
      map[n] = short
    }
    return map
  }

  /**
   * 逆向恢复工具名（用于响应转换）
   */
  _restoreToolName(shortName) {
    return this._reverseToolNameMap[shortName] || shortName
  }
}
