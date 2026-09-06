// OpenAI/Codex 容量降载错误码出站改写
// DEC_20260905_100000 对齐 sub2api：code 或文案命中均改写；SSE 支持 \n\n 与 \r\n\r\n
// 内部限流/换号仍看原始 payload，本函数只改「写给客户端」的副本

const CAPACITY_SHED_CODES = new Set(['server_is_overloaded', 'slow_down'])
export const OPENAI_CAPACITY_SHED_RETRYABLE_CLIENT_CODE = 'server_error'

// 容量降载文案（无 code 时也要命中）
const CAPACITY_SHED_MESSAGE_RE =
  /server is overloaded|servers are overloaded|servers are currently overloaded|currently overloaded|at capacity|model is at capacity|selected model is at capacity/i

const readErrorCode = (obj) => {
  if (!obj || typeof obj !== 'object') {
    return ''
  }
  const raw = obj.code
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

const readErrorMessage = (obj) => {
  if (!obj || typeof obj !== 'object') {
    return ''
  }
  if (typeof obj.message === 'string') {
    return obj.message
  }
  if (typeof obj.msg === 'string') {
    return obj.msg
  }
  return ''
}

export const isOpenAICapacityShedMessage = (text) => {
  if (typeof text !== 'string' || !text.trim()) {
    return false
  }
  return CAPACITY_SHED_MESSAGE_RE.test(text)
}

const extractCapacitySignals = (body) => {
  if (!body || typeof body !== 'object') {
    return { code: '', message: '', errorPath: null }
  }
  if (body.error && typeof body.error === 'object') {
    return {
      code: readErrorCode(body.error),
      message: readErrorMessage(body.error),
      errorPath: 'error',
    }
  }
  if (body.response && typeof body.response === 'object' && body.response.error) {
    return {
      code: readErrorCode(body.response.error),
      message: readErrorMessage(body.response.error),
      errorPath: 'response.error',
    }
  }
  if (typeof body.message === 'string') {
    return { code: readErrorCode(body), message: body.message, errorPath: null }
  }
  return { code: '', message: '', errorPath: null }
}

export const isOpenAICapacityShedPayload = (payload) => {
  if (!payload) {
    return false
  }
  let body = payload
  if (typeof payload === 'string') {
    const lower = payload.toLowerCase()
    if (
      !lower.includes('overloaded') &&
      !lower.includes('at capacity') &&
      !lower.includes('server_is_overloaded') &&
      !lower.includes('slow_down')
    ) {
      return false
    }
    try {
      body = JSON.parse(payload.trim())
    } catch {
      return isOpenAICapacityShedMessage(payload) || /server_is_overloaded|slow_down/i.test(payload)
    }
  }
  if (typeof body !== 'object' || !body) {
    return false
  }
  const signal = extractCapacitySignals(body)
  if (CAPACITY_SHED_CODES.has(signal.code)) {
    return true
  }
  if (isOpenAICapacityShedMessage(signal.message)) {
    return true
  }
  if (typeof body.message === 'string' && isOpenAICapacityShedMessage(body.message)) {
    return true
  }
  return false
}

const rewriteErrorObject = (errorObj) => {
  if (!errorObj || typeof errorObj !== 'object') {
    return { changed: false, error: errorObj }
  }
  const code = readErrorCode(errorObj)
  const message = readErrorMessage(errorObj)
  const capacityByCode = CAPACITY_SHED_CODES.has(code)
  const capacityByMessage = isOpenAICapacityShedMessage(message)
  if (!capacityByCode && !capacityByMessage) {
    return { changed: false, error: errorObj }
  }
  // 对齐 sub2api：已有非空且非降载 code（含 rate_limit_*）不改
  if (code && !CAPACITY_SHED_CODES.has(code)) {
    return { changed: false, error: errorObj }
  }
  if (code === OPENAI_CAPACITY_SHED_RETRYABLE_CLIENT_CODE) {
    return { changed: false, error: errorObj }
  }
  // code 为空或为降载码：写入 server_error，消息原样保留
  return {
    changed: true,
    error: { ...errorObj, code: OPENAI_CAPACITY_SHED_RETRYABLE_CLIENT_CODE },
  }
}

export const sanitizeOpenAICapacityShedForClient = (payload) => {
  if (payload === null || payload === undefined) {
    return { payload, changed: false }
  }

  const asString = typeof payload === 'string'
  let body = payload
  if (asString) {
    const trimmed = payload.trim()
    if (!trimmed || trimmed === '[DONE]') {
      return { payload, changed: false }
    }
    try {
      body = JSON.parse(trimmed)
    } catch {
      return { payload, changed: false }
    }
  }

  if (!body || typeof body !== 'object') {
    return { payload, changed: false }
  }

  if (!isOpenAICapacityShedPayload(body)) {
    return { payload, changed: false }
  }

  let changed = false
  let next = body

  if (body.error && typeof body.error === 'object') {
    const rewritten = rewriteErrorObject(body.error)
    if (rewritten.changed) {
      next = { ...next, error: rewritten.error }
      changed = true
    }
  }

  if (body.response && typeof body.response === 'object' && body.response.error) {
    const rewritten = rewriteErrorObject(body.response.error)
    if (rewritten.changed) {
      next = {
        ...next,
        response: { ...next.response, error: rewritten.error },
      }
      changed = true
    }
  }

  // 顶层无 error 对象但 message 命中：补一个可重试 error
  if (!changed && typeof body.message === 'string' && isOpenAICapacityShedMessage(body.message)) {
    next = {
      ...body,
      error: {
        message: body.message,
        type: body.type || 'server_error',
        code: OPENAI_CAPACITY_SHED_RETRYABLE_CLIENT_CODE,
      },
    }
    changed = true
  }

  if (!changed) {
    return { payload, changed: false }
  }

  return {
    payload: asString ? JSON.stringify(next) : next,
    changed: true,
  }
}

export const sanitizeOpenAICapacityShedSseDataLine = (line) => {
  if (typeof line !== 'string') {
    return { line, changed: false }
  }
  // 兼容 data: 与 data:（可能带 \r）
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!normalized.startsWith('data: ')) {
    return { line, changed: false }
  }
  const data = normalized.slice(6)
  const { payload, changed } = sanitizeOpenAICapacityShedForClient(data)
  if (!changed) {
    return { line, changed: false }
  }
  const suffix = line.endsWith('\r') ? '\r' : ''
  return { line: `data: ${payload}${suffix}`, changed: true }
}

const hasEventBoundary = (text) => text.includes('\n\n') || text.includes('\r\n\r\n')

const splitSseEvents = (text) => {
  // 优先按 \r\n\r\n，再按 \n\n；混合时统一处理
  if (text.includes('\r\n\r\n')) {
    // 若同时有 \n\n，先把 \r\n\r\n 切，残留再按 \n\n
    const parts = text.split('\r\n\r\n')
    return { parts, joiner: '\r\n\r\n' }
  }
  const parts = text.split('\n\n')
  return { parts, joiner: '\n\n' }
}

const splitSseLines = (block) => {
  // 保留 \r 以便 data 行改写后还原
  if (block.includes('\r\n')) {
    return block.split('\r\n')
  }
  return block.split('\n')
}

const joinSseLines = (lines, block) => {
  if (block.includes('\r\n')) {
    return lines.join('\r\n')
  }
  return lines.join('\n')
}

// 流式 SSE 出站改写器：跨 TCP chunk 缓冲；同时认 \n\n 与 \r\n\r\n
// DEC_20260905_100000
export const createCapacityShedSseRewriteStream = () => {
  let buffer = ''

  const rewriteEventBlock = (block) => {
    if (
      !block.includes('server_is_overloaded') &&
      !block.includes('slow_down') &&
      !/overloaded|at capacity/i.test(block)
    ) {
      return block
    }
    const lines = splitSseLines(block)
    const rewritten = lines.map((line) => sanitizeOpenAICapacityShedSseDataLine(line).line)
    return joinSseLines(rewritten, block)
  }

  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      buffer += text
      if (!hasEventBoundary(buffer)) {
        return ''
      }
      const { parts, joiner } = splitSseEvents(buffer)
      buffer = parts.pop() || ''
      const out = []
      for (const part of parts) {
        out.push(rewriteEventBlock(part))
      }
      return out.length ? `${out.join(joiner)}${joiner}` : ''
    },
    flush() {
      if (!buffer) {
        return ''
      }
      const rest = rewriteEventBlock(buffer)
      buffer = ''
      return rest
    },
  }
}
