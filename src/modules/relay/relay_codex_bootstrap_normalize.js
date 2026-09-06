// Codex delegation / automation bootstrap 归一
// DEC_20260904_173000 对齐 sub2api：无 call_id 的启动 function_call_output → user message
// 仅极窄安全条件改写，避免误伤正常 tool 链路
//
// 场景：Codex App/TUI 委派开线程、自动化启动时，客户端把说明塞成 function_call_output
// 且无有效 call_id；上游 Responses 要求 call_id 对齐，直接转发会 400。

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const stringField = (item, key) => {
  const value = item?.[key]
  return typeof value === 'string' ? value : ''
}

const trimType = (value) => (typeof value === 'string' ? value.trim() : '')

export const isResponsesCallOutputType = (typ) => {
  const type = trimType(typ)
  return type.endsWith('_call_output') || type === 'tool_search_output'
}

export const isCodexDelegationTool = (namespace, name) => {
  const ns = trimType(namespace)
  const tool = trimType(name)
  return (ns === 'codex_app' || ns === 'codex_tui') && (tool === 'create_thread' || tool === 'send_message_to_thread')
}

// 严格 envelope：仅根 codex_delegation + 两个非空子节点 source_thread_id / input，无命名空间/属性/前后缀
export const validCodexDelegationEnvelope = (value) => {
  if (typeof value !== 'string') {
    return false
  }
  const text = value
  const open = '<codex_delegation>'
  const close = '</codex_delegation>'
  if (!text.startsWith(open) || !text.endsWith(close)) {
    return false
  }
  const inner = text.slice(open.length, text.length - close.length)
  if (!inner) {
    return false
  }

  let sourceSeen = false
  let inputSeen = false
  let rest = inner

  // 只允许两个子元素，顺序任意，中间可有空白
  while (rest.length > 0) {
    const leading = rest.match(/^\s*/)
    rest = rest.slice(leading?.[0].length || 0)
    if (!rest) {
      break
    }

    let tag
    if (rest.startsWith('<source_thread_id>')) {
      tag = 'source_thread_id'
    } else if (rest.startsWith('<input>')) {
      tag = 'input'
    } else {
      return false
    }

    const startTag = `<${tag}>`
    const endTag = `</${tag}>`
    if (!rest.startsWith(startTag)) {
      return false
    }
    const endIndex = rest.indexOf(endTag, startTag.length)
    if (endIndex < 0) {
      return false
    }
    const content = rest.slice(startTag.length, endIndex)
    // 禁止嵌套标签
    if (content.includes('<') || content.includes('>')) {
      return false
    }
    if (content.trim() === '') {
      return false
    }
    if (tag === 'source_thread_id') {
      if (sourceSeen) {
        return false
      }
      sourceSeen = true
    } else {
      if (inputSeen) {
        return false
      }
      inputSeen = true
    }
    rest = rest.slice(endIndex + endTag.length)
  }

  return sourceSeen && inputSeen
}

const codexAutomationHeaderValue = (line, prefix) => {
  if (typeof line !== 'string' || !line.startsWith(prefix)) {
    return { ok: false, value: '' }
  }
  const value = line.slice(prefix.length)
  if (!value || value.trim() !== value) {
    return { ok: false, value: '' }
  }
  return { ok: true, value }
}

export const validCodexAutomationId = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    return false
  }
  if (value === '.' || value === '..') {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const isAlpha = (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57)
    const isExtra = value[index] === '-' || value[index] === '_' || value[index] === '.'
    if (!isAlpha && !isExtra) {
      return false
    }
  }
  return true
}

export const validCodexAutomationLastRun = (value) => {
  if (value === 'never') {
    return true
  }
  if (typeof value !== 'string') {
    return false
  }
  const separator = value.lastIndexOf(' (')
  if (separator <= 0 || !value.endsWith(')')) {
    return false
  }
  const iso = value.slice(0, separator)
  const millisText = value.slice(separator + 2, -1)
  const runAt = Date.parse(iso)
  const epochMillis = Number(millisText)
  if (!Number.isFinite(runAt) || !Number.isFinite(epochMillis)) {
    return false
  }
  // 对齐 Go UnixMilli：允许 1ms 内误差（JS Date 精度）
  return Math.abs(runAt - epochMillis) <= 1
}

export const validCodexAutomationBootstrap = (value) => {
  if (typeof value !== 'string') {
    return false
  }
  if (value.includes('\r') && !value.includes('\r\n')) {
    return false
  }
  const normalized = value.replace(/\r\n/g, '\n')
  if (normalized.includes('\r')) {
    return false
  }
  const lines = normalized.split('\n')
  if (lines.length < 6) {
    return false
  }
  if (!codexAutomationHeaderValue(lines[0], 'Automation: ').ok) {
    return false
  }
  const automationId = codexAutomationHeaderValue(lines[1], 'Automation ID: ')
  if (!automationId.ok || !validCodexAutomationId(automationId.value)) {
    return false
  }
  const expectedMemory = `Automation memory: $CODEX_HOME/automations/${automationId.value}/memory.md`
  if (lines[2] !== expectedMemory) {
    return false
  }
  const lastRun = codexAutomationHeaderValue(lines[3], 'Last run: ')
  if (!lastRun.ok || !validCodexAutomationLastRun(lastRun.value) || lines[4] !== '') {
    return false
  }
  return lines.slice(5).join('\n').trim() !== ''
}

export const isCodexDelegationCandidate = (item) => {
  if (!isPlainObject(item)) {
    return false
  }
  if (trimType(item.type) !== 'function_call_output') {
    return false
  }
  if (!isCodexDelegationTool(stringField(item, 'namespace'), stringField(item, 'name'))) {
    return false
  }
  const { output } = item
  return typeof output === 'string' && validCodexDelegationEnvelope(output)
}

export const isCodexAutomationCandidate = (item) => {
  if (!isPlainObject(item)) {
    return false
  }
  if (trimType(item.type) !== 'function_call_output') {
    return false
  }
  if (trimType(item.namespace) !== 'codex_app' || trimType(item.name) !== 'automation_update') {
    return false
  }
  const { output } = item
  return typeof output === 'string' && validCodexAutomationBootstrap(output)
}

const hasEmptyOrMissingCallId = (item) => {
  if (!Object.prototype.hasOwnProperty.call(item, 'call_id')) {
    return true
  }
  const callId = item.call_id
  if (typeof callId !== 'string') {
    // 非字符串 call_id：不是「空 call 启动」，拒绝改写（与 sub2api exists && !string 一致：整包不改）
    return false
  }
  return callId.trim() === ''
}

const hasNonEmptyCallId = (item) => {
  if (!Object.prototype.hasOwnProperty.call(item, 'call_id')) {
    return false
  }
  const callId = item.call_id
  return typeof callId === 'string' && callId.trim() !== ''
}

// 安全门：有 previous_response_id / 其它 call 锚点 / 非候选 call_output → 不改
const canSafelyNormalizeBootstrap = (request, isCandidate) => {
  if (!isPlainObject(request)) {
    return false
  }
  if (Object.prototype.hasOwnProperty.call(request, 'previous_response_id')) {
    const previous = request.previous_response_id
    if (typeof previous !== 'string' || previous.trim() !== '') {
      return false
    }
  }
  const { input } = request
  if (!Array.isArray(input)) {
    return false
  }

  for (const raw of input) {
    if (!isPlainObject(raw)) {
      continue
    }
    const typ = trimType(raw.type)
    if (typ === 'item_reference' || typ.endsWith('_call')) {
      return false
    }
    if (isResponsesCallOutputType(typ)) {
      // 存在非空 call_id 的 call_output → 真 tool 链路，不碰
      if (hasNonEmptyCallId(raw)) {
        return false
      }
      // 空/缺 call_id 的 call_output 必须是候选，否则歧义
      if (Object.prototype.hasOwnProperty.call(raw, 'call_id') && typeof raw.call_id !== 'string') {
        return false
      }
      if (!hasEmptyOrMissingCallId(raw)) {
        return false
      }
      if (!isCandidate(raw)) {
        return false
      }
    }
  }
  return true
}

const rewriteCandidateToUserMessage = (item) => {
  const { output } = item
  return {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: output,
      },
    ],
  }
}

// 单类 bootstrap 归一（原地改 input 项；返回是否变更）
export const normalizeCodexCallOutputBootstrap = (body, isCandidate) => {
  if (!isPlainObject(body) || typeof isCandidate !== 'function') {
    return { body, changed: false }
  }
  if (!canSafelyNormalizeBootstrap(body, isCandidate)) {
    return { body, changed: false }
  }

  const { input } = body
  let changed = false
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]
    if (!isPlainObject(item) || !isCandidate(item)) {
      continue
    }
    if (typeof item.output !== 'string') {
      continue
    }
    input[index] = rewriteCandidateToUserMessage(item)
    changed = true
  }
  return { body, changed }
}

// 入口：automation 先、delegation 后（与 sub2api 顺序一致）；原地改 body
// DEC_20260904_173000 HTTP Responses + WS bridge 共用
export const normalizeCodexBootstrapBody = (body) => {
  if (!isPlainObject(body)) {
    return { body, changed: false, kinds: [] }
  }
  // 浅拷贝 input 数组，避免与调用方共享同一数组引用时难测；项内仍可能共享
  if (Array.isArray(body.input)) {
    body.input = body.input.slice()
  }

  const kinds = []
  const automation = normalizeCodexCallOutputBootstrap(body, isCodexAutomationCandidate)
  if (automation.changed) {
    kinds.push('automation')
  }
  const delegation = normalizeCodexCallOutputBootstrap(body, isCodexDelegationCandidate)
  if (delegation.changed) {
    kinds.push('delegation')
  }

  return {
    body,
    changed: kinds.length > 0,
    kinds,
  }
}
