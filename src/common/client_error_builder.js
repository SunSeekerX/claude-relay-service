// 上游错误 → 返回给客户端的包装/脱敏响应（纯函数）
// 原则：默认不裸透传上游原文。状态码归一化 + 按客户端协议的干净 error + 脱敏。
// 仅对"客户端请求自身问题"类（普通 4xx，如 400/404/422）透传脱敏后的上游 message，便于客户端修正。
// 上游账户/渠道标识、上游 URL、认证细节一律不出现在返回体里（运维信息走 recordErrorHistory）。
//
// DEC_20260904_162520 客户端可自愈/会话策略类错误(如 session_blocked_by_cyber_policy)保留 4xx 并透传脱敏 message; 禁止藏成 502 致客户端误重试

// 上游状态码 → 客户端看到的状态码（隐藏账户/上游内部细节）
export const normalizeStatusCode = (upstreamStatus) => {
  if (!Number.isInteger(upstreamStatus)) {
    return 502
  }
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    // 隐藏"我方账户认证问题"，免得客户端以为是自己的 key 错
    return 502
  }
  if (upstreamStatus === 529) {
    return 503
  }
  if (upstreamStatus === 429) {
    // 保留限流语义，让客户端退避
    return 429
  }
  if (upstreamStatus >= 500) {
    return 502
  }
  // 普通 4xx(400/404/422...) 原样，属客户端请求问题
  return upstreamStatus
}

// 是否把（脱敏后的）上游 message 透给客户端：仅普通 4xx（客户端请求自身问题，需知道哪错了）
export const shouldExposeUpstreamMessage = (clientStatus) =>
  clientStatus >= 400 && clientStatus < 500 && clientStatus !== 429

// 凭证形态正则：即便透传普通 4xx 的上游 message，也按形态脱敏，防夹带 key
// Bearer 必须优先于 sk- 系列，否则先剥 sk- 后 Bearer 规则因长度不够而漏网
const SECRET_PATTERNS = [
  /Bearer\s+[a-zA-Z0-9._-]{12,}/gi,
  /sk-ant-[a-zA-Z0-9_-]{8,}/g,
  /sk-[a-zA-Z0-9_-]{16,}/g,
  /AIza[a-zA-Z0-9_-]{10,}/g,
  /ya29\.[a-zA-Z0-9._-]{10,}/g,
]

// 从上游 body 提取 message 并脱敏（去账户/渠道标记、URL、凭证形态，限长）
export const extractSafeMessage = (upstreamBody) => {
  let msg = ''
  if (typeof upstreamBody === 'string') {
    msg = upstreamBody
  } else if (upstreamBody && typeof upstreamBody === 'object') {
    const err = upstreamBody.error
    msg = (err && (err.message || err.msg)) || upstreamBody.message || ''
  }
  if (typeof msg !== 'string') {
    return ''
  }
  let cleaned = msg.replace(/ \[[^\]/]+\/[^\]]+\]/g, '').replace(/https?:\/\/[^\s"']+/g, '[upstream]')
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, '***')
  }
  return cleaned.trim().slice(0, 500)
}

// 生产日志用：只保留安全字段，禁止 console.error(axiosError) 整包（会带 Authorization/URL/config）
// DEC_20260905_163148
// DEC_20260905_163907 message 也走 extractSafeMessage，去掉 URL/凭证/账户标记
export const summarizeErrorForLog = (error) => {
  if (!error) {
    return { message: 'unknown error' }
  }
  if (typeof error === 'string') {
    return { message: extractSafeMessage(error) || error.slice(0, 500) }
  }
  const rawMessage =
    typeof error.message === 'string' ? error.message : typeof error === 'object' ? String(error) : 'unknown error'
  const out = {
    name: typeof error.name === 'string' ? error.name : undefined,
    message: extractSafeMessage(rawMessage) || rawMessage.slice(0, 500),
    code: error.code || error.errno || undefined,
    status: error.response?.status || error.statusCode || error.status || undefined,
  }
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) {
      delete out[key]
    }
  }
  return out
}

// 提取上游 error.code / error.type（仅安全字符，供客户端识别）
export const extractUpstreamErrorCode = (upstreamBody) => {
  if (!upstreamBody || typeof upstreamBody !== 'object') {
    return ''
  }
  const err = upstreamBody.error
  const raw = (err && typeof err === 'object' && (err.code || err.type)) || upstreamBody.code || upstreamBody.type || ''
  if (typeof raw !== 'string') {
    return ''
  }
  const cleaned = raw.trim().slice(0, 120)
  // 只放行标识符形态，避免把任意文案塞进 code
  if (!/^[A-Za-z0-9._:-]+$/.test(cleaned)) {
    return ''
  }
  return cleaned
}

// Anthropic 官方 error.type 白名单；未知归 api_error，避免自定义/账户侧 type 泄漏
// DEC_20260905_155232 Claude 出站错误恢复 type:error 信封并保留可识别 type
export const ANTHROPIC_ERROR_TYPES = new Set([
  'api_error',
  'authentication_error',
  'billing_error',
  'invalid_request_error',
  'not_found_error',
  'overloaded_error',
  'permission_error',
  'rate_limit_error',
  'timeout_error',
])

const pickAnthropicErrorTypeCandidate = (upstreamBody) => {
  if (!upstreamBody || typeof upstreamBody !== 'object') {
    return ''
  }
  const err = upstreamBody.error
  if (err && typeof err === 'object' && typeof err.type === 'string') {
    return err.type.trim()
  }
  if (typeof upstreamBody.type === 'string' && upstreamBody.type !== 'error') {
    return upstreamBody.type.trim()
  }
  return ''
}

// 解析 Anthropic error.type：白名单优先，否则按状态码兜底
export const resolveAnthropicErrorType = (statusCode, upstreamBody = null) => {
  const candidate = pickAnthropicErrorTypeCandidate(upstreamBody).toLowerCase()
  if (candidate && ANTHROPIC_ERROR_TYPES.has(candidate)) {
    return candidate
  }
  // code 偶发承载 type（如 rate_limit_error）
  const code = extractUpstreamErrorCode(upstreamBody).toLowerCase()
  if (code && ANTHROPIC_ERROR_TYPES.has(code)) {
    return code
  }
  if (statusCode === 429) {
    return 'rate_limit_error'
  }
  if (statusCode === 529) {
    return 'overloaded_error'
  }
  if (statusCode === 401) {
    return 'authentication_error'
  }
  if (statusCode === 403) {
    return 'permission_error'
  }
  if (statusCode === 404) {
    return 'not_found_error'
  }
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
    return 'invalid_request_error'
  }
  return 'api_error'
}

// Claude 原生协议出站错误体：{ type:"error", error:{ type, message } }
// HTTP 状态由调用方决定（Claude 路径保留上游码；调度层自建错误自带码）
export const buildAnthropicClientErrorBody = ({ statusCode, upstreamBody = null, fallbackMessage = '' } = {}) => {
  const type = resolveAnthropicErrorType(statusCode, upstreamBody)
  const safeMessage =
    extractSafeMessage(upstreamBody) ||
    (typeof fallbackMessage === 'string' && fallbackMessage.trim()) ||
    describeError(normalizeStatusCode(statusCode)).message
  return {
    type: 'error',
    error: {
      type,
      message: safeMessage,
    },
  }
}

// 客户端可自愈/会话策略类：必须把具体原因给用户，且不应被当临时上游故障重试
// 判定靠 code/type + 文案特征；默认 401/403 仍按账户鉴权隐藏
const CLIENT_ACTIONABLE_CODES = new Set([
  'session_blocked_by_cyber_policy',
  'session_blocked',
  'conversation_blocked',
  'content_policy_violation',
  'content_filter',
  'content_policy',
  'invalid_prompt',
  'policy_violation',
])

const CLIENT_ACTIONABLE_MESSAGE_RE =
  /session is blocked|start a new session|blocked by cyber|cyber-security policy|网络安全策略|开启新会话|该会话已被|content\s*policy|usage\s*policy|content\s*filter|被屏蔽/i

export const isClientActionableUpstreamError = (statusCode, upstreamBody) => {
  // 仅 4xx；5xx 仍属上游故障。429 有独立限流语义，不走本分支
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode >= 500 || statusCode === 429) {
    return false
  }
  // 纯 401 无策略文案时仍视为账户鉴权问题，继续隐藏
  const code = extractUpstreamErrorCode(upstreamBody).toLowerCase()
  if (code && CLIENT_ACTIONABLE_CODES.has(code)) {
    return true
  }
  if (code && /session_blocked|content_policy|content_filter|policy_violation/.test(code)) {
    return true
  }
  const message = extractSafeMessage(upstreamBody)
  if (message && CLIENT_ACTIONABLE_MESSAGE_RE.test(message)) {
    return true
  }
  return false
}

// 客户端状态码 → 默认通用文案（脱敏，不带上游原文）
export const describeError = (clientStatus) => {
  if (clientStatus === 429) {
    return { type: 'rate_limit_error', message: 'Upstream rate limited, please retry later' }
  }
  if (clientStatus === 503) {
    return {
      type: 'overloaded_error',
      message: 'Upstream temporarily overloaded, please retry later',
    }
  }
  if (clientStatus === 502) {
    return { type: 'upstream_error', message: 'Upstream service temporarily unavailable' }
  }
  if (clientStatus >= 400 && clientStatus < 500) {
    return { type: 'invalid_request_error', message: 'Invalid request' }
  }
  return { type: 'upstream_error', message: 'Upstream request failed' }
}

// 按客户端协议构造 error body
const buildErrorBody = (protocol, clientStatus, type, message, retryAfterSeconds, code = null) => {
  const errorCode = code || type
  if (protocol === 'anthropic') {
    return { type: 'error', error: { type, message } }
  }
  if (protocol === 'gemini') {
    return { error: { code: clientStatus, message, status: type } }
  }
  // openai（默认）
  const body = { error: { message, type, code: errorCode, param: null } }
  if (retryAfterSeconds) {
    body.error.resets_in_seconds = retryAfterSeconds
  }
  return body
}

// 主入口：上游错误 → { statusCode, body }
export const buildClientError = ({
  statusCode,
  protocol = 'openai',
  upstreamBody = null,
  retryAfterSeconds = null,
}) => {
  // 客户端可自愈类：保留 4xx 语义 + 透传脱敏原文，避免 502 误导重试
  if (isClientActionableUpstreamError(statusCode, upstreamBody)) {
    const clientStatus = statusCode >= 400 && statusCode < 500 ? statusCode : 403
    const safeMessage = extractSafeMessage(upstreamBody) || 'Request rejected by upstream policy'
    const upstreamCode = extractUpstreamErrorCode(upstreamBody)
    const type =
      clientStatus === 403 || /permission|policy|blocked/i.test(upstreamCode)
        ? 'permission_error'
        : 'invalid_request_error'
    return {
      statusCode: clientStatus,
      body: buildErrorBody(protocol, clientStatus, type, safeMessage, null, upstreamCode || type),
    }
  }

  const clientStatus = normalizeStatusCode(statusCode)
  const desc = describeError(clientStatus)
  let { message } = desc
  if (shouldExposeUpstreamMessage(clientStatus)) {
    const safe = extractSafeMessage(upstreamBody)
    if (safe) {
      message = safe
    }
  }
  return {
    statusCode: clientStatus,
    body: buildErrorBody(protocol, clientStatus, desc.type, message, retryAfterSeconds),
  }
}
