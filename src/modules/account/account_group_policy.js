// 分组调度硬门：模型白名单 / Claude Code Only / RPM / 日周月 USD 额度
//
// 日/周/月 USD 硬限（预扣 remaining + 单在途）：
// - acquire（单 Lua 原子）：
// · 若 cost_hold 存在 → 拒（同组已有在途）
// · 若 used >= limit → 拒
// · 否则 reserved = limit - used，INCRBYFLOAT cost += reserved（预扣占满剩余），
// SET cost_hold = payload(reserved + day/week/month)，TTL 2h
// - settle/record（GETDEL hold 后调账）：
// · cost += (actual - reserved)；hold 已原子摘掉，并发方看不到「无 hold 且旧 used」窗口
// · 无 hold（已释放/无额度轴）时直接 cost += actual
// - release 失败路径（GETDEL hold 后）：cost += (-reserved) 退回预扣
// - hold key 周期无关；payload 固定 acquire 时业务日/周/月，跨零点释放不丢旧窗
// - 单笔 actual > reserved 仍可能让 used 略超 limit（token 费用事前不可知），但：
// · 并发堆叠被 hold + 预扣双重挡住
// · 超限后 used >= limit，后续请求拒绝
// 采用「预扣剩余 + 单在途 + 结算调账」；非按请求估 token

import { redis } from '../../infra/redis.js'
import { RedisKeys, TTL } from '../../infra/redis_key.js'
import { RedisLua } from '../../infra/redis_lua.js'
import { logger } from '../../common/logger.js'
import * as timezone from '../../common/timezone.js'
import { config } from '../../../config/config.js'
import { isModelAllowedByGroup, parseBooleanFlag, parseNonNegativeNumber } from './account_group_constants.js'

const COST_EPSILON = 1e-6
const HOLD_TTL_SECONDS = 2 * 3600
const COST_WEEKLY_TTL_SECONDS = 40 * 24 * 3600
const COST_MONTHLY_TTL_SECONDS = 70 * 24 * 3600

const getBusinessParts = (date = new Date()) => {
  const offset = config.system.timezoneOffset
  const day = timezone.getDateStringInTimezone(date, offset)
  const week = timezone.getWeekStringInTimezone(date, offset)
  const tzDate = timezone.getDateInTimezone(date, offset)
  const hour = String(tzDate.getUTCHours()).padStart(2, '0')
  const minute = String(tzDate.getUTCMinutes()).padStart(2, '0')
  return {
    day,
    month: day.slice(0, 7),
    week,
    minuteKey: `${day.replace(/-/g, '')}${hour}${minute}`,
  }
}

const createPolicyError = (statusCode, message) => {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

const costTtlSeconds = () => ({
  daily: TTL.costDaily || 33 * 24 * 3600,
  weekly: COST_WEEKLY_TTL_SECONDS,
  monthly: COST_MONTHLY_TTL_SECONDS,
})

const axisCostKeys = (groupId, parts) => ({
  daily: RedisKeys.accountGroup.costDaily(groupId, parts.day),
  weekly: RedisKeys.accountGroup.costWeekly(groupId, parts.week),
  monthly: RedisKeys.accountGroup.costMonthly(groupId, parts.month),
})

// hold payload: d|w|m|day|week|month （预扣额 + 业务周期，跨日释放仍对准旧窗）
const parseHoldPayload = (raw) => {
  if (!raw || typeof raw !== 'string') {
    return null
  }
  const parts = raw.split('|')
  if (parts.length < 6) {
    return null
  }
  return {
    dailyReserved: Number(parts[0]) || 0,
    weeklyReserved: Number(parts[1]) || 0,
    monthlyReserved: Number(parts[2]) || 0,
    day: parts[3],
    week: parts[4],
    month: parts[5],
  }
}

const clearHoldTarget = (holdTarget, groupId) => {
  if (!holdTarget || typeof holdTarget !== 'object') {
    return
  }
  if (holdTarget.groupCostHoldGroupId === groupId) {
    holdTarget.groupCostHoldGroupId = null
  }
  if (holdTarget.groupCostHoldMeta && holdTarget.groupCostHoldMeta.groupId === groupId) {
    holdTarget.groupCostHoldMeta = null
  }
}

export const assertGroupRequestAllowed = async (group, context = {}) => {
  if (!group || !group.id) {
    return
  }

  const { requestedModel } = context
  if (!isModelAllowedByGroup(group, requestedModel)) {
    throw createPolicyError(400, `Model ${requestedModel || '(empty)'} is not allowed in group ${group.name}`)
  }

  if (group.platform === 'claude' && parseBooleanFlag(group.claudeCodeOnly, false)) {
    if (context.isClaudeCode !== true) {
      throw createPolicyError(403, `Group ${group.name} only allows Claude Code clients`)
    }
  }

  const client = redis.getClientSafe()
  const parts = getBusinessParts()
  const dailyLimit = parseNonNegativeNumber(group.dailyLimitUsd, 0)
  const weeklyLimit = parseNonNegativeNumber(group.weeklyLimitUsd, 0)
  const monthlyLimit = parseNonNegativeNumber(group.monthlyLimitUsd, 0)
  const ttl = costTtlSeconds()

  const keys = axisCostKeys(group.id, parts)
  const holdKey = RedisKeys.accountGroup.costHold(group.id)

  if (dailyLimit > 0 || weeklyLimit > 0 || monthlyLimit > 0) {
    const result = await client.eval(
      RedisLua.groupPolicy.acquire,
      4,
      holdKey,
      keys.daily,
      keys.weekly,
      keys.monthly,
      String(dailyLimit),
      String(weeklyLimit),
      String(monthlyLimit),
      String(COST_EPSILON),
      String(HOLD_TTL_SECONDS),
      parts.day,
      parts.week,
      parts.month,
      String(ttl.daily),
      String(ttl.weekly),
      String(ttl.monthly),
    )
    const status = Number(Array.isArray(result) ? result[0] : result)
    const detail = Array.isArray(result) ? result[1] : ''
    if (status !== 1) {
      const reason = String(detail || 'busy')
      if (reason === 'busy') {
        throw createPolicyError(402, `Group ${group.name} USD limit busy (in-flight request)`)
      }
      throw createPolicyError(402, `Group ${group.name} ${reason} USD limit exceeded`)
    }

    const payload = detail ? String(detail) : ''
    const holdMeta = payload ? parseHoldPayload(payload) : null
    if (holdMeta) {
      holdMeta.groupId = group.id
    }

    if (context && typeof context === 'object') {
      const holdGroupId = holdMeta ? group.id : null
      context.groupCostHoldGroupId = holdGroupId
      context.groupCostHoldMeta = holdMeta
      if (context.holdTarget && typeof context.holdTarget === 'object') {
        context.holdTarget.groupCostHoldGroupId = holdGroupId
        context.holdTarget.groupCostHoldMeta = holdMeta
      }
    }
  } else if (context && typeof context === 'object') {
    context.groupCostHoldGroupId = null
    context.groupCostHoldMeta = null
  }

  const rpmLimit = Math.floor(parseNonNegativeNumber(group.rpmLimit, 0))
  if (rpmLimit > 0) {
    const rpmKey = RedisKeys.accountGroup.rpm(group.id, parts.minuteKey)
    const count = await client.incr(rpmKey)
    if (count === 1) {
      await client.expire(rpmKey, 120)
    }
    if (count > rpmLimit) {
      // RPM 超限：若刚占了 USD hold 必须退回
      await releaseGroupCostHolds(group.id)
      if (context?.holdTarget) {
        clearHoldTarget(context.holdTarget, group.id)
      }
      if (context) {
        context.groupCostHoldGroupId = null
        context.groupCostHoldMeta = null
      }
      throw createPolicyError(429, `Group ${group.name} RPM limit exceeded (${rpmLimit}/min)`)
    }
  }
}

// 失败/结束兜底：原子 GETDEL hold + 按 payload 周期退回预扣
export const releaseGroupCostHolds = async (groupId) => {
  if (!groupId) {
    return
  }
  try {
    const client = redis.getClientSafe()
    const ttl = costTtlSeconds()
    await client.eval(
      RedisLua.groupPolicy.release,
      1,
      RedisKeys.accountGroup.costHold(groupId),
      String(groupId),
      String(COST_EPSILON),
      String(ttl.daily),
      String(ttl.weekly),
      String(ttl.monthly),
      RedisKeys.accountGroup.costPrefix,
    )
  } catch (error) {
    console.error(error)
    logger.warn(`[group-policy] releaseGroupCostHolds failed groupId=${groupId}: ${error.message}`)
  }
}

// 计费结算：原子 GETDEL hold + cost += (actual - reserved)；无 hold 则 +actual
export const recordGroupUsageCost = async (groupId, ratedCostUsd) => {
  if (!groupId) {
    return
  }
  const amount = Number(ratedCostUsd)
  const actual = Number.isFinite(amount) ? amount : 0
  try {
    const client = redis.getClientSafe()
    const ttl = costTtlSeconds()
    const parts = getBusinessParts()
    await client.eval(
      RedisLua.groupPolicy.settle,
      1,
      RedisKeys.accountGroup.costHold(groupId),
      String(groupId),
      String(actual),
      String(COST_EPSILON),
      String(ttl.daily),
      String(ttl.weekly),
      String(ttl.monthly),
      parts.day,
      parts.week,
      parts.month,
      RedisKeys.accountGroup.costPrefix,
    )
  } catch (error) {
    logger.error(`[group-policy] record cost failed groupId=${groupId}:`, error)
    console.error(error)
  }
}

const GROUP_BINDING_FIELDS = [
  'claudeAccountId',
  'claudeConsoleAccountId',
  'geminiAccountId',
  'openaiAccountId',
  'bedrockAccountId',
  'azureOpenaiAccountId',
  'droidAccountId',
  'grokAccountId',
]

const ACCOUNT_TYPE_GROUP_FIELDS = {
  'claude-official': ['claudeAccountId'],
  'claude-console': ['claudeConsoleAccountId', 'claudeAccountId'],
  ccr: ['claudeAccountId'],
  bedrock: ['bedrockAccountId', 'claudeAccountId'],
  openai: ['openaiAccountId'],
  'openai-responses': ['openaiAccountId'],
  'azure-openai': ['azureOpenaiAccountId', 'openaiAccountId'],
  gemini: ['geminiAccountId'],
  'gemini-api': ['geminiAccountId'],
  antigravity: ['geminiAccountId'],
  droid: ['droidAccountId'],
  grok: ['grokAccountId'],
}

const SERVICE_GROUP_FIELDS = {
  claude: ['claudeAccountId', 'claudeConsoleAccountId'],
  codex: ['openaiAccountId'],
  openai: ['openaiAccountId'],
  gemini: ['geminiAccountId'],
  droid: ['droidAccountId'],
  grok: ['grokAccountId'],
  bedrock: ['bedrockAccountId'],
  azure: ['azureOpenaiAccountId', 'openaiAccountId'],
  ccr: ['claudeAccountId'],
}

const readGroupIdFromField = (apiKeyData, field) => {
  const value = apiKeyData?.[field]
  if (typeof value !== 'string' || !value.startsWith('group:')) {
    return null
  }
  const groupId = value.slice('group:'.length)
  return groupId || null
}

export const extractBoundGroupIds = (apiKeyData = {}) => {
  const ids = []
  const seen = new Set()
  for (const field of GROUP_BINDING_FIELDS) {
    const groupId = readGroupIdFromField(apiKeyData, field)
    if (!groupId || seen.has(groupId)) {
      continue
    }
    seen.add(groupId)
    ids.push(groupId)
  }
  return ids
}

export const extractBoundGroupIdForAccountType = (apiKeyData = {}, accountType = null) => {
  if (!accountType) {
    return null
  }
  const fields = ACCOUNT_TYPE_GROUP_FIELDS[accountType]
  if (!fields) {
    return null
  }
  for (const field of fields) {
    const groupId = readGroupIdFromField(apiKeyData, field)
    if (groupId) {
      return groupId
    }
  }
  return null
}

export const extractBoundGroupIdForService = (apiKeyData = {}, service = null) => {
  if (!service) {
    return null
  }
  const fields = SERVICE_GROUP_FIELDS[service] || SERVICE_GROUP_FIELDS[String(service).toLowerCase()]
  if (!fields) {
    return null
  }
  for (const field of fields) {
    const groupId = readGroupIdFromField(apiKeyData, field)
    if (groupId) {
      return groupId
    }
  }
  return null
}

export const extractBoundGroupId = (apiKeyData = {}) => {
  const ids = extractBoundGroupIds(apiKeyData)
  return ids.length > 0 ? ids[0] : null
}

let exclusiveMemberCache = { at: 0, byPlatform: new Map() }
const EXCLUSIVE_CACHE_TTL_MS = 5000

export const invalidateExclusiveMemberCache = () => {
  exclusiveMemberCache = { at: 0, byPlatform: new Map() }
}

export const collectExclusiveMemberIds = async (accountGroupService, platform = null) => {
  const ids = new Set()
  if (!accountGroupService?.getAllGroups) {
    return ids
  }
  try {
    const platforms = Array.isArray(platform) ? platform : platform ? [platform] : null
    const cacheKey = platforms ? platforms.slice().sort().join(',') : '*'
    const now = Date.now()
    if (now - exclusiveMemberCache.at < EXCLUSIVE_CACHE_TTL_MS) {
      const cached = exclusiveMemberCache.byPlatform.get(cacheKey)
      if (cached) {
        return new Set(cached)
      }
    }

    const groups = await accountGroupService.getAllGroups()
    const exclusive = (groups || []).filter((group) => {
      if (!group || !group.isExclusive) {
        return false
      }
      if (!platforms) {
        return true
      }
      return platforms.includes(group.platform)
    })
    for (const group of exclusive) {
      const members = await accountGroupService.getGroupMembers(group.id)
      for (const memberId of members || []) {
        ids.add(memberId)
      }
    }

    exclusiveMemberCache.byPlatform.set(cacheKey, [...ids])
    exclusiveMemberCache.at = now
  } catch (error) {
    logger.error('[group-policy] collectExclusiveMemberIds failed:', error)
    console.error(error)
  }
  return ids
}
