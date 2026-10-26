import crypto from 'node:crypto'
import { RedisKeys, TTL } from './redis_key.js'
import { RedisLua } from './redis_lua.js'

export const attach = (redisClient) => {
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
