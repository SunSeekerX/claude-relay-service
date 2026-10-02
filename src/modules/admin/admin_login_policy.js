import crypto from 'node:crypto'
import { redis } from '../../infra/redis.js'
import { RedisKeys, TTL, LIMITS } from '../../infra/redis_key.js'
import { RedisLua } from '../../infra/redis_lua.js'
import { tooManyRequests } from '../../common/http_result.js'

// 在密码哈希校验之前限速，Redis 异常时由管理 API 返回 5xx
export const assertAdminLoginAllowed = async (req) => {
  const peer = req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? 'unknown'
  const client = req.ip ?? peer
  const identities = new Map([
    [peer, LIMITS.adminLoginPeerAttempts],
    [client, LIMITS.adminLoginAttempts],
  ])
  const waits = await Promise.all(
    [...identities].map(([identity, limit]) => {
      const hash = crypto.createHash('sha256').update(identity).digest('hex')
      return redis
        .getClientSafe()
        .eval(RedisLua.adminLogin.consumeAttempt, 1, RedisKeys.adminLogin.attempts(hash), limit, TTL.adminLoginWindow)
    }),
  )
  await redis.getClientSafe().lpush(
    RedisKeys.adminLogin.events,
    JSON.stringify({
      ip: client,
      peer,
      at: new Date().toISOString(),
      blocked: waits.some((value) => Number(value) > 0),
    }),
  )
  await redis.getClientSafe().ltrim(RedisKeys.adminLogin.events, 0, 199)
  const retryAfter = Math.max(...waits.map(Number))
  if (retryAfter > 0) {
    throw tooManyRequests('登录尝试过于频繁，请稍后再试', {
      reason: 'admin_login_rate_limited',
      headers: { 'Retry-After': retryAfter },
    })
  }
}

export const clearAdminLoginAttempts = async (req) => {
  const peer = req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? 'unknown'
  const client = req.ip ?? peer
  const identities = [...new Set([peer, client])]
  const keys = identities.map((identity) => {
    const hash = crypto.createHash('sha256').update(identity).digest('hex')
    return RedisKeys.adminLogin.attempts(hash)
  })
  await redis.getClientSafe().del(...keys)
}
