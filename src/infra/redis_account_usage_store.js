import crypto from 'node:crypto'
import { RedisKeys, TTL, LIMITS } from './redis_key.js'
import { RedisLua } from './redis_lua.js'
import { getDateStringInTimezone, getHourInTimezone } from '../common/timezone.js'

const count = (value) => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}
const usageFromHash = (data = {}) => ({
  requests: count(data.requests ?? data.totalRequests),
  tokens:
    count(data.allTokens ?? data.totalAllTokens) ||
    count(data.inputTokens ?? data.totalInputTokens) +
      count(data.outputTokens ?? data.totalOutputTokens) +
      count(data.cacheCreateTokens ?? data.totalCacheCreateTokens) +
      count(data.cacheReadTokens ?? data.totalCacheReadTokens),
  inputTokens: count(data.inputTokens ?? data.totalInputTokens),
  outputTokens: count(data.outputTokens ?? data.totalOutputTokens),
  cacheCreateTokens: count(data.cacheCreateTokens ?? data.totalCacheCreateTokens),
  cacheReadTokens: count(data.cacheReadTokens ?? data.totalCacheReadTokens),
  cost: 0,
})

const formatUsage = (usage) => ({
  ...usage,
  cost: Math.round(usage.cost * 1e6) / 1e6,
  formattedCost: `$${usage.cost.toFixed(6)}`,
})

const sumUsage = (rows) => {
  const result = usageFromHash()
  for (const row of rows) {
    for (const field of Object.keys(result)) {
      result[field] += row[field]
    }
  }
  return formatUsage(result)
}

export const attach = (redisClient) => {
  redisClient.batchGetAccountRollingUsage = async function (
    accountIds,
    { now = new Date(), fallbackModel = 'unknown', includeDaily = false } = {},
  ) {
    const ids = [...new Set(accountIds)]
    const result = new Map()
    if (!ids.length) {
      return result
    }
    const dates = Array.from({ length: 30 }, (_, index) =>
      getDateStringInTimezone(new Date(now.getTime() - index * 86400000)),
    )
    const hours = Array.from({ length: 24 }, (_, index) => {
      const date = new Date(now.getTime() - index * 3600000)
      return `${getDateStringInTimezone(date)}:${String(getHourInTimezone(date)).padStart(2, '0')}`
    })
    const selectedIds = new Set(ids)
    const dailyModels = new Map(dates.map((date) => [date, new Map()]))
    const client = this.getClientSafe()
    // 分批扫描日期索引，只保留本次账户；不为每个账户重复读取整份索引。
    for (const date of dates) {
      let cursor = '0'
      do {
        const page = await client.sscan(
          RedisKeys.accountUsage.modelDailyIndex(date),
          cursor,
          'COUNT',
          LIMITS.systemStatsScanBatch,
        )
        cursor = page[0]
        for (const entry of page[1]) {
          const split = entry.indexOf(':')
          const accountId = entry.slice(0, split)
          if (!selectedIds.has(accountId)) {
            continue
          }
          const models = dailyModels.get(date).get(accountId) ?? new Set()
          models.add(entry.slice(split + 1))
          dailyModels.get(date).set(accountId, models)
        }
      } while (cursor !== '0')
    }
    for (let offset = 0; offset < ids.length; offset += LIMITS.accountRollingBatch) {
      const batch = ids.slice(offset, offset + LIMITS.accountRollingBatch)
      const slots = batch.flatMap((accountId) => [
        ...hours.map((slot) => ({ accountId, kind: 'hourly', slot })),
        ...dates.map((slot) => ({ accountId, kind: 'daily', slot })),
      ])
      const hashes = await this.batchHgetallChunked(
        slots.map(({ accountId, kind, slot }) => RedisKeys.accountUsage[kind](accountId, slot)),
      )
      const buckets = new Map()
      const modelQueries = []
      slots.forEach((meta, index) => {
        const hash = hashes[index]
        if (hash === null) {
          throw new Error('Failed to read account usage bucket')
        }
        const data = hash ?? {}
        const key = `${meta.accountId}:${meta.kind}:${meta.slot}`
        const usage = usageFromHash(data)
        buckets.set(key, usage)
        const models =
          meta.kind === 'daily'
            ? [...(dailyModels.get(meta.slot).get(meta.accountId) ?? [])]
            : Object.keys(data)
                .filter((field) => field.startsWith('model:') && field.endsWith(':requests'))
                .map((field) => field.slice(6, -9))
        if (!models.length) {
          usage.cost = this._resolveAccountModelCost(data, fallbackModel)
        }
        for (const model of models) {
          modelQueries.push({ ...meta, model, key })
        }
      })
      const modelHashes = await this.batchHgetallChunked(
        modelQueries.map(({ accountId, kind, model, slot }) =>
          kind === 'daily'
            ? RedisKeys.accountUsage.modelDaily(accountId, model, slot)
            : RedisKeys.accountUsage.modelHourly(accountId, model, slot),
        ),
      )
      modelQueries.forEach(({ key, model }, index) => {
        if (modelHashes[index] === null) {
          throw new Error('Failed to read account model usage bucket')
        }
        buckets.get(key).cost += this._resolveAccountModelCost(modelHashes[index] ?? {}, model)
      })
      for (const accountId of batch) {
        const hourly = hours.map((slot) => buckets.get(`${accountId}:hourly:${slot}`))
        const daily = dates.map((slot) => buckets.get(`${accountId}:daily:${slot}`))
        result.set(accountId, {
          fiveHour: sumUsage(hourly.slice(0, 5)),
          oneDay: sumUsage(hourly),
          sevenDay: sumUsage(daily.slice(0, 7)),
          thirtyDay: sumUsage(daily),
          ...(includeDaily
            ? { dailyHistory: Object.fromEntries(dates.map((date, index) => [date, formatUsage(daily[index])])) }
            : {}),
        })
      }
    }
    return result
  }

  redisClient.getAccountRollingUsage = async function (accountId, options) {
    return (await this.batchGetAccountRollingUsage([accountId], options)).get(accountId)
  }

  redisClient.recordOpenaiResponsesAccountUsage = async function (accountId, tokens) {
    return this.getClientSafe().eval(
      RedisLua.openaiResponsesAccount.recordUsage,
      2,
      RedisKeys.accounts.openaiResponses(accountId),
      RedisKeys.accountUsage.operationDedup(crypto.randomUUID()),
      new Date().toISOString(),
      String(tokens),
      String(TTL.accountUsageDedup),
    )
  }

  redisClient.recordOpenaiResponsesAccountQuota = async function (accountId, amount) {
    const now = new Date()
    return this.getClientSafe().eval(
      RedisLua.openaiResponsesAccount.recordQuota,
      2,
      RedisKeys.accounts.openaiResponses(accountId),
      RedisKeys.accountUsage.operationDedup(crypto.randomUUID()),
      this.getDateStringInTimezone(now),
      String(amount),
      now.toISOString(),
      String(TTL.accountUsageDedup),
    )
  }
}
