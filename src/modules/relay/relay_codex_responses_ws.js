// Codex Responses WebSocket（官方 wire_api=responses 的 WS 形态）
// 对照：codex-rs responses_websocket + CLIProxyAPI codex_websockets_*
// 第一阶段：客户端 WS → 上游 WSS 透传（与 Realtime 同隧道）

export const CODEX_RESPONSES_WS_BETA = 'responses_websockets=2026-02-06'

// 是否为 Responses WebSocket 路径（不含 realtime/live）
export const isResponsesWebSocketPath = (pathname) => {
  const path = String(pathname || '')
  if (!path) {
    return false
  }
  // 排除 realtime sideband
  if (path.includes('/realtime') || path.includes('/v1/live') || /\/live(\/|$)/.test(path)) {
    return false
  }
  // /v1/responses | /openai/v1/responses | /backend-api/codex/responses | /responses
  if (path === '/v1/responses' || path.endsWith('/v1/responses')) {
    return true
  }
  if (path === '/responses' || path.endsWith('/responses')) {
    // backend-api/codex/responses 或裸 /responses
    if (path.includes('/backend-api/codex') || path === '/responses' || path === '/openai/responses') {
      return true
    }
  }
  return false
}

export const isCodexWebSocketPath = (pathname) =>
  // realtime 由 codex_realtime 判定；此处仅 responses
  isResponsesWebSocketPath(pathname)

// 上游 WSS URL
export const resolveResponsesUpstreamWebSocketUrl = ({ pathname = '', search = '', isChatGptOAuth = true } = {}) => {
  const qs = search && search !== '?' ? search : ''
  if (isChatGptOAuth || String(pathname).includes('/backend-api/codex')) {
    return `wss://chatgpt.com/backend-api/codex/responses${qs}`
  }
  return `wss://api.openai.com/v1/responses${qs}`
}

// 合并 openai-beta：确保含 responses_websockets= 日期
export const mergeResponsesWebsocketBetaHeader = (existingBeta) => {
  const current = typeof existingBeta === 'string' ? existingBeta : ''
  if (current.includes('responses_websockets=')) {
    return current
  }
  return current ? `${current},${CODEX_RESPONSES_WS_BETA}` : CODEX_RESPONSES_WS_BETA
}

// 出站头：官方关键 + beta
export const buildResponsesWebsocketUpstreamHeaders = ({
  accessToken,
  account = {},
  accountId = '',
  clientHeaders = {},
} = {}) => {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    originator: clientHeaders.originator || 'codex_cli_rs',
    version: clientHeaders.version || undefined,
    'session-id': clientHeaders['session-id'] || clientHeaders['session_id'] || undefined,
    'thread-id': clientHeaders['thread-id'] || undefined,
    'x-client-request-id': clientHeaders['x-client-request-id'] || undefined,
    'x-openai-subagent': clientHeaders['x-openai-subagent'] || undefined,
    'user-agent': clientHeaders['user-agent'] || 'codex_cli_rs',
    'openai-beta': mergeResponsesWebsocketBetaHeader(clientHeaders['openai-beta']),
  }
  const chatgptAccountId =
    account.accountId || account.chatgptUserId || clientHeaders['chatgpt-account-id'] || accountId
  if (chatgptAccountId) {
    headers['chatgpt-account-id'] = chatgptAccountId
  }
  // 去掉 undefined
  for (const key of Object.keys(headers)) {
    if (headers[key] === undefined || headers[key] === null || headers[key] === '') {
      delete headers[key]
    }
  }
  return headers
}
