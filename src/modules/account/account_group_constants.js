// 账户分组平台与字段约定（对齐 sub2api 核心能力，不含图片/视频/国内模型）
// 分组 platform 是调度池维度；账户具体子类型经 mapAccountPlatformToGroupPlatform 归一

export const GROUP_PLATFORMS = ['claude', 'openai', 'gemini', 'antigravity', 'droid', 'grok']

export const GROUP_PLATFORM_META = {
  claude: { label: 'Claude', color: 'purple' },
  openai: { label: 'OpenAI', color: 'emerald' },
  gemini: { label: 'Gemini', color: 'blue' },
  antigravity: { label: 'Antigravity', color: 'indigo' },
  droid: { label: 'Droid', color: 'cyan' },
  grok: { label: 'Grok', color: 'violet' },
}

// 账户子类型 → 分组 platform
export const mapAccountPlatformToGroupPlatform = (accountPlatform) => {
  if (!accountPlatform) {
    return ''
  }
  const value = String(accountPlatform).toLowerCase()
  if (value === 'claude' || value === 'claude-console' || value === 'bedrock' || value === 'ccr') {
    return 'claude'
  }
  if (value === 'openai' || value === 'openai-responses' || value === 'azure_openai') {
    return 'openai'
  }
  if (value === 'gemini' || value === 'gemini-api') {
    return 'gemini'
  }
  if (value === 'gemini-antigravity' || value === 'antigravity') {
    return 'antigravity'
  }
  if (value === 'droid') {
    return 'droid'
  }
  if (value === 'grok') {
    return 'grok'
  }
  return value
}

export const isValidGroupPlatform = (platform) => GROUP_PLATFORMS.includes(platform)

// 解析非负数字；空/非法 → fallback
export const parseNonNegativeNumber = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') {
    return fallback
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) {
    return fallback
  }
  return number
}

// 倍率：默认 1，允许 0（不计费）
export const parseRateMultiplier = (value) => {
  if (value === null || value === undefined || value === '') {
    return 1
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) {
    return 1
  }
  return number
}

export const parseBooleanFlag = (value, fallback = false) => {
  if (value === null || value === undefined || value === '') {
    return fallback
  }
  if (typeof value === 'boolean') {
    return value
  }
  if (value === true || value === 'true' || value === '1' || value === 1) {
    return true
  }
  if (value === false || value === 'false' || value === '0' || value === 0) {
    return false
  }
  return fallback
}

// modelWhitelist：数组或 JSON 字符串 → 去空白小写 model id 列表；空 = 不限制
export const parseModelWhitelist = (value) => {
  if (value === null || value === undefined || value === '') {
    return []
  }
  let list = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return []
    }
    try {
      list = JSON.parse(trimmed)
    } catch {
      list = trimmed
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    }
  }
  if (!Array.isArray(list)) {
    return []
  }
  return [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))]
}

export const serializeModelWhitelist = (value) => JSON.stringify(parseModelWhitelist(value))

// 从 create/update body 抽出可写分组字段（platform 创建时单独处理）
export const normalizeGroupWritableFields = (input = {}) => {
  const fields = {}
  if (Object.prototype.hasOwnProperty.call(input, 'name')) {
    fields.name = String(input.name || '').trim()
  }
  if (Object.prototype.hasOwnProperty.call(input, 'description')) {
    fields.description = String(input.description || '')
  }
  if (Object.prototype.hasOwnProperty.call(input, 'rateMultiplier')) {
    fields.rateMultiplier = String(parseRateMultiplier(input.rateMultiplier))
  }
  if (Object.prototype.hasOwnProperty.call(input, 'isExclusive')) {
    fields.isExclusive = parseBooleanFlag(input.isExclusive) ? 'true' : 'false'
  }
  if (Object.prototype.hasOwnProperty.call(input, 'claudeCodeOnly')) {
    fields.claudeCodeOnly = parseBooleanFlag(input.claudeCodeOnly) ? 'true' : 'false'
  }
  if (Object.prototype.hasOwnProperty.call(input, 'rpmLimit')) {
    fields.rpmLimit = String(Math.floor(parseNonNegativeNumber(input.rpmLimit, 0)))
  }
  if (Object.prototype.hasOwnProperty.call(input, 'dailyLimitUsd')) {
    const amount = parseNonNegativeNumber(input.dailyLimitUsd, 0)
    fields.dailyLimitUsd = amount > 0 ? String(amount) : ''
  }
  if (Object.prototype.hasOwnProperty.call(input, 'weeklyLimitUsd')) {
    const amount = parseNonNegativeNumber(input.weeklyLimitUsd, 0)
    fields.weeklyLimitUsd = amount > 0 ? String(amount) : ''
  }
  if (Object.prototype.hasOwnProperty.call(input, 'monthlyLimitUsd')) {
    const amount = parseNonNegativeNumber(input.monthlyLimitUsd, 0)
    fields.monthlyLimitUsd = amount > 0 ? String(amount) : ''
  }
  if (Object.prototype.hasOwnProperty.call(input, 'modelWhitelist')) {
    fields.modelWhitelist = serializeModelWhitelist(input.modelWhitelist)
  }
  return fields
}

// Redis hash → API 对外对象
export const presentGroup = (raw = {}, extras = {}) => {
  const platform = raw.platform || ''
  return {
    id: raw.id,
    name: raw.name || '',
    platform,
    platformLabel: GROUP_PLATFORM_META[platform]?.label || platform,
    description: raw.description || '',
    rateMultiplier: parseRateMultiplier(raw.rateMultiplier),
    isExclusive: parseBooleanFlag(raw.isExclusive, false),
    claudeCodeOnly: parseBooleanFlag(raw.claudeCodeOnly, false),
    rpmLimit: Math.floor(parseNonNegativeNumber(raw.rpmLimit, 0)),
    dailyLimitUsd: parseNonNegativeNumber(raw.dailyLimitUsd, 0) || null,
    weeklyLimitUsd: parseNonNegativeNumber(raw.weeklyLimitUsd, 0) || null,
    monthlyLimitUsd: parseNonNegativeNumber(raw.monthlyLimitUsd, 0) || null,
    modelWhitelist: parseModelWhitelist(raw.modelWhitelist),
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    ...extras,
  }
}

// 模型是否被分组白名单放行（空名单 = 全放行）
// 匹配规则（禁止双向子串，避免 gpt-4o 与 gpt-4o-mini 互相误放行）：
// - 精确匹配（大小写不敏感）
// - 仅当规则以 * 结尾时做前缀匹配（如 gpt-4o-*）
export const isModelAllowedByGroup = (group, requestedModel) => {
  const whitelist = parseModelWhitelist(group?.modelWhitelist)
  if (whitelist.length === 0) {
    return true
  }
  if (!requestedModel) {
    return false
  }
  const model = String(requestedModel).toLowerCase().trim()
  if (!model) {
    return false
  }
  return whitelist.some((item) => {
    const rule = String(item || '')
      .toLowerCase()
      .trim()
    if (!rule) {
      return false
    }
    if (rule.endsWith('*')) {
      const prefix = rule.slice(0, -1)
      // 光一个 * = 全放行；空前缀不另开双向子串口子
      return prefix.length === 0 ? true : model.startsWith(prefix)
    }
    return model === rule
  })
}
