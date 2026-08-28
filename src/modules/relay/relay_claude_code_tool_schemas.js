// Claude Code 官方工具 input_schema（对照 claude.exe 2.1.219 拆包 TOOLS_OFFICIAL.md）
// 用途：
// 1) 入站 tools 定义校验/补全
// 2) tool_use.input 字段归一（Cursor/其它客户端 → Claude Code 官方字段）
// 3) timeout 单位钳制（ms）

// 运行时 timeout 上限（ms）：与官方 max 包装同量级，防 Invalid tool parameters
export const CLAUDE_CODE_TOOL_TIMEOUT_MAX_MS = 600000
export const CLAUDE_CODE_TOOL_TIMEOUT_MIN_MS = 1000

// 官方工具名（常见子集；未知工具原样放行）
export const CLAUDE_CODE_TOOL_NAMES = new Set([
  'Bash',
  'PowerShell',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebSearch',
  'WebFetch',
  'Agent',
  'Skill',
  'TodoWrite',
  'TaskOutput',
  'TaskStop',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
])

// 字段别名：其它客户端 → Claude Code
const FIELD_ALIASES = {
  Read: {
    path: 'file_path',
    filePath: 'file_path',
    filepath: 'file_path',
  },
  Write: {
    path: 'file_path',
    filePath: 'file_path',
    filepath: 'file_path',
    text: 'content',
    body: 'content',
  },
  Edit: {
    path: 'file_path',
    filePath: 'file_path',
    oldString: 'old_string',
    newString: 'new_string',
    replaceAll: 'replace_all',
  },
  Glob: {
    glob_pattern: 'pattern',
    globPattern: 'pattern',
    target_directory: 'path',
    targetDirectory: 'path',
    directory: 'path',
  },
  Grep: {
    search_path: 'path',
    file_pattern: 'glob',
  },
  WebSearch: {
    search_term: 'query',
    q: 'query',
  },
  WebFetch: {
    // prompt 官方必填，缺省在 normalize 里补
  },
  Bash: {
    cmd: 'command',
    working_directory: '_working_directory_note',
  },
  PowerShell: {
    cmd: 'command',
  },
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const clampTimeoutMs = (value) => {
  if (value === null || value === undefined || value === '') {
    return undefined
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    return undefined
  }
  // 官方单位是毫秒：1000 = 1 秒。禁止把 <=3600 当秒再 *1000
  let ms = Math.floor(number)
  if (ms < CLAUDE_CODE_TOOL_TIMEOUT_MIN_MS) {
    ms = CLAUDE_CODE_TOOL_TIMEOUT_MIN_MS
  }
  if (ms > CLAUDE_CODE_TOOL_TIMEOUT_MAX_MS) {
    ms = CLAUDE_CODE_TOOL_TIMEOUT_MAX_MS
  }
  return ms
}

// 归一单个 tool_use.input
export const normalizeClaudeCodeToolInput = (toolName, input) => {
  if (!toolName || !isPlainObject(input)) {
    return input
  }
  const name = String(toolName)
  const aliases = FIELD_ALIASES[name] || {}
  const next = { ...input }

  for (const [from, to] of Object.entries(aliases)) {
    if (next[from] !== undefined && next[to] === undefined) {
      next[to] = next[from]
      delete next[from]
    }
  }

  // working_directory 无官方字段：塞进 description 备注，避免 Invalid
  if (next._working_directory_note !== undefined) {
    const note = `cwd=${next._working_directory_note}`
    next.description = next.description ? `${next.description}; ${note}` : note
    delete next._working_directory_note
  }
  if (next.working_directory !== undefined && name === 'Bash') {
    const note = `cwd=${next.working_directory}`
    next.description = next.description ? `${next.description}; ${note}` : note
    delete next.working_directory
  }

  if (name === 'Bash' || name === 'PowerShell') {
    if (next.timeout !== undefined) {
      const clamped = clampTimeoutMs(next.timeout)
      if (clamped === undefined) {
        delete next.timeout
      } else {
        next.timeout = clamped
      }
    }
  }

  if (name === 'WebFetch') {
    if (!next.prompt || typeof next.prompt !== 'string' || !next.prompt.trim()) {
      next.prompt = 'Summarize the main content of this page for coding context.'
    }
  }

  if (name === 'WebSearch') {
    if (typeof next.query === 'string' && next.query.trim().length < 2) {
      next.query = `${next.query.trim()} ` // 避免 min 2 直接炸；仍可能被上游拒
    }
  }

  if (name === 'Read') {
    if (next.offset !== undefined) {
      const offset = Number(next.offset)
      next.offset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0
    }
    if (next.limit !== undefined) {
      const limit = Number(next.limit)
      if (!Number.isFinite(limit) || limit <= 0) {
        delete next.limit
      } else {
        next.limit = Math.floor(limit)
      }
    }
  }

  if (name === 'Edit' && next.replace_all !== undefined) {
    next.replace_all = Boolean(next.replace_all)
  }

  return next
}

// 归一 messages 里所有 tool_use.input
export const normalizeClaudeCodeToolUsesInMessages = (messages) => {
  if (!Array.isArray(messages)) {
    return messages
  }
  return messages.map((message) => {
    if (!message || !Array.isArray(message.content)) {
      return message
    }
    const content = message.content.map((block) => {
      if (!block || block.type !== 'tool_use') {
        return block
      }
      return {
        ...block,
        input: normalizeClaudeCodeToolInput(block.name, block.input || {}),
      }
    })
    return { ...message, content }
  })
}

// tools 定义：补 input_schema 骨架，避免空 schema
export const normalizeClaudeCodeToolsDefinition = (tools) => {
  if (!Array.isArray(tools)) {
    return tools
  }
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') {
      return tool
    }
    const { name } = tool
    const next = { ...tool }
    if (!next.input_schema || typeof next.input_schema !== 'object') {
      next.input_schema = { type: 'object', properties: {} }
    }
    // 官方必填字段提示（不强制改 description）
    if (name === 'WebFetch') {
      const props = next.input_schema.properties || (next.input_schema.properties = {})
      if (!props.prompt) {
        props.prompt = { type: 'string', description: 'What to extract from the page' }
      }
      if (!props.url) {
        props.url = { type: 'string', description: 'URL to fetch' }
      }
      if (!Array.isArray(next.input_schema.required)) {
        next.input_schema.required = ['url', 'prompt']
      }
    }
    if (name === 'Bash' || name === 'PowerShell') {
      const props = next.input_schema.properties || (next.input_schema.properties = {})
      if (props.timeout) {
        // 文档化单位
        props.timeout = {
          ...props.timeout,
          description: `${props.timeout.description || 'timeout'} (milliseconds, max ${CLAUDE_CODE_TOOL_TIMEOUT_MAX_MS})`,
        }
      }
    }
    return next
  })
}

// 请求体级归一（messages + tools）
export const normalizeClaudeCodeToolsInRequest = (body) => {
  if (!body || typeof body !== 'object') {
    return body
  }
  const next = { ...body }
  if (Array.isArray(next.messages)) {
    next.messages = normalizeClaudeCodeToolUsesInMessages(next.messages)
  }
  if (Array.isArray(next.tools)) {
    next.tools = normalizeClaudeCodeToolsDefinition(next.tools)
  }
  return next
}
