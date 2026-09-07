import { redis } from '../../infra/redis.js'
import { RedisLua } from '../../infra/redis_lua.js'

export const applyClearedRateLimitFields = function applyClearedRateLimitFields(accountData) {
  accountData.rateLimitedAt = ''
  accountData.rateLimitStatus = ''
  accountData.rateLimitResetAt = ''
  accountData.status = 'active'
  accountData.schedulable = 'true'
  accountData.errorMessage = ''
}

export const copyRateLimitFields = function copyRateLimitFields(target, source) {
  target.rateLimitStatus = source.rateLimitStatus
  target.rateLimitedAt = source.rateLimitedAt
  target.rateLimitResetAt = source.rateLimitResetAt
  target.status = source.status
  target.schedulable = source.schedulable
  target.errorMessage = source.errorMessage
}

export const clearExpiredRateLimitHash = async function clearExpiredRateLimitHash(accountKey) {
  const client = redis.getClientSafe()
  const now = new Date()
  const result = await client.eval(
    RedisLua.account.clearExpiredRateLimit,
    1,
    accountKey,
    now.toISOString(),
    String(now.getTime()),
  )
  return Number(result) === 1
}
