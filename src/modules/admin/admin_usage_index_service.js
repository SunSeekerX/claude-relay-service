import { redis } from '../../infra/redis.js'
import { RedisKeys, TTL } from '../../infra/redis_key.js'

const pendingReads = new Map()
const pendingScans = new Map()

const sharePending = (pending, key, run) => {
  if (pending.has(key)) {
    return pending.get(key)
  }
  const promise = Promise.resolve()
    .then(run)
    .finally(() => pending.delete(key))
  pending.set(key, promise)
  return promise
}

const scanUsageKeys = async (pattern) => {
  const prefix = `${pattern.split(':')[0]}:*`
  const keys = await sharePending(pendingScans, prefix, () => redis.scanKeys(prefix))
  const expression = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  )
  return keys.filter((key) => expression.test(key))
}

export const getUsageDataByIndex = (indexKey, keyPattern, scanPattern) =>
  sharePending(pendingReads, indexKey, async () => {
    const client = redis.getClientSafe()
    const members = await client.smembers(indexKey)
    let keys
    if (members.length > 0) {
      keys = members.map((id) => {
        if (keyPattern.includes('{model}')) {
          const [owner, ...model] = id.split(':')
          return keyPattern
            .replace('{keyId}', owner)
            .replace('{accountId}', owner)
            .replace('{model}', model.join(':'))
        }
        return keyPattern.replace('{id}', id)
      })
    } else {
      if ((await client.get(RedisKeys.emptyMarker(indexKey))) === '1') {
        return []
      }
      keys = await scanUsageKeys(scanPattern)
      if (keys.length === 0) {
        await client.setex(RedisKeys.emptyMarker(indexKey), TTL.emptyMarker, '1')
        return []
      }
      const expression = new RegExp(
        `^${keyPattern
          .split(/(\{(?:id|keyId|accountId|model)\})/)
          .map((part) =>
            part === '{model}' || part === '{id}'
              ? '(.+)'
              : /^\{/.test(part)
                ? '([^:]+)'
                : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          )
          .join('')}$`
      )
      const ids = keys.map((key) => expression.exec(key)?.slice(1).join(':')).filter(Boolean)
      if (ids.length > 0) {
        const ttl = indexKey.includes(':hourly:')
          ? TTL.usageHourly
          : indexKey.includes(':monthly:')
            ? TTL.usageMonthly
            : TTL.usageDaily
        await client
          .multi()
          .sadd(indexKey, ...ids)
          .expire(indexKey, ttl)
          .exec()
      }
    }
    const values = await redis.batchHgetallChunked(keys)
    return keys.flatMap((key, index) =>
      values[index] && Object.keys(values[index]).length ? [{ key, data: values[index] }] : []
    )
  })
