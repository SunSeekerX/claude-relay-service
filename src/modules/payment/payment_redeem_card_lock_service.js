// 兑换码防爆破失败锁：按 IP 计数 + 管理端列表/解锁
// DEC_20260905_100000 索引改 ZSET(score=expiryMs)，成员随过期自然失效；SCAN 不截断
import { redis } from '../../infra/redis.js'
import { RedisKeys, TTL } from '../../infra/redis_key.js'
import { logger } from '../../common/logger.js'

export const REDEEM_CARD_FAIL_LOCK_THRESHOLD = 5

const FAIL_PREFIX = 'redeem_card:fail:'

const normalizeIp = (ip) => {
  if (typeof ip !== 'string') {
    return ''
  }
  const trimmed = ip.trim()
  return trimmed || ''
}

const failKeyOf = (ip) => RedisKeys.redeemCard.fail(ip)

const nowMs = () => Date.now()

const pruneExpiredIndex = async (client) => {
  // 删掉 score < now 的成员（已过期）
  await client.zremrangebyscore(RedisKeys.redeemCard.failIndex, '-inf', nowMs()).catch((e) => console.error(e))
}

export const getRedeemCardFailCount = async (ip) => {
  const clientIp = normalizeIp(ip)
  if (!clientIp) {
    return 0
  }
  const raw = await redis.client.get(failKeyOf(clientIp))
  const count = parseInt(raw || '0', 10)
  return Number.isFinite(count) ? count : 0
}

export const isRedeemCardFailLocked = async (ip) => {
  const count = await getRedeemCardFailCount(ip)
  return count >= REDEEM_CARD_FAIL_LOCK_THRESHOLD
}

// 失败一次：INCR + TTL；索引用 ZSET score=过期时间戳，避免永久膨胀
export const recordRedeemCardFail = async (ip) => {
  const clientIp = normalizeIp(ip)
  if (!clientIp) {
    return 0
  }
  const key = failKeyOf(clientIp)
  const count = await redis.client.incr(key)
  await redis.client.expire(key, TTL.redeemCardWindow)
  const expiryMs = nowMs() + TTL.redeemCardWindow * 1000
  await redis.client.zadd(RedisKeys.redeemCard.failIndex, expiryMs, clientIp)
  // 顺手修剪已过期成员（O(logN+M)，M 为过期数）
  await pruneExpiredIndex(redis.client)
  return count
}

export const clearRedeemCardFail = async (ip) => {
  const clientIp = normalizeIp(ip)
  if (!clientIp) {
    return
  }
  await redis.client.del(failKeyOf(clientIp))
  await redis.client.zrem(RedisKeys.redeemCard.failIndex, clientIp)
}

export const unlockRedeemCardFail = async (ip) => {
  const clientIp = normalizeIp(ip)
  if (!clientIp) {
    return { unlocked: false, reason: 'invalid_ip' }
  }
  const hour = new Date().toISOString().slice(0, 13)
  const pipeline = redis.client.pipeline()
  pipeline.del(failKeyOf(clientIp))
  pipeline.del(RedisKeys.redeemCard.ip(clientIp, hour))
  pipeline.zrem(RedisKeys.redeemCard.failIndex, clientIp)
  await pipeline.exec()
  logger.security(`Redeem card fail lock unlocked for IP: ${clientIp}`)
  return { unlocked: true, ip: clientIp }
}

const collectIpsFromIndex = async () => {
  try {
    await pruneExpiredIndex(redis.client)
    // 只取尚未过期的成员
    const members = await redis.client.zrangebyscore(RedisKeys.redeemCard.failIndex, nowMs(), '+inf')
    return Array.isArray(members) ? members.filter(Boolean) : []
  } catch (error) {
    console.error(error)
    // 兼容旧 Set 索引：若 ZSET 命令失败，尝试 SMEMBERS 一次
    try {
      const members = await redis.client.smembers(RedisKeys.redeemCard.failIndex)
      return Array.isArray(members) ? members.filter(Boolean) : []
    } catch (e2) {
      console.error(e2)
      return []
    }
  }
}

// 全量 SCAN fail key，无截断（管理操作低频）
const collectIpsFromScan = async () => {
  const ips = []
  let cursor = '0'
  const { client } = redis
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', RedisKeys.redeemCard.failPattern, 'COUNT', 200)
    cursor = String(next)
    for (const key of batch || []) {
      if (typeof key !== 'string' || !key.startsWith(FAIL_PREFIX)) {
        continue
      }
      const ip = key.slice(FAIL_PREFIX.length)
      if (ip) {
        ips.push(ip)
      }
    }
  } while (cursor !== '0')
  return ips
}

export const listRedeemCardFailLocks = async () => {
  const fromIndex = await collectIpsFromIndex()
  const fromScan = await collectIpsFromScan()
  const ipSet = new Set([...fromIndex, ...fromScan])
  const locks = []

  for (const ip of ipSet) {
    const key = failKeyOf(ip)
    const [raw, ttl] = await Promise.all([redis.client.get(key), redis.client.ttl(key)])
    if (raw === null || raw === undefined) {
      await redis.client.zrem(RedisKeys.redeemCard.failIndex, ip).catch((e) => console.error(e))
      await redis.client.srem(RedisKeys.redeemCard.failIndex, ip).catch(() => {})
      continue
    }
    const failCount = parseInt(raw || '0', 10) || 0
    locks.push({
      ip,
      failCount,
      ttlSeconds: typeof ttl === 'number' && ttl > 0 ? ttl : 0,
      locked: failCount >= REDEEM_CARD_FAIL_LOCK_THRESHOLD,
      threshold: REDEEM_CARD_FAIL_LOCK_THRESHOLD,
    })
  }

  locks.sort((a, b) => {
    if (a.locked !== b.locked) {
      return a.locked ? -1 : 1
    }
    return b.failCount - a.failCount
  })

  return {
    locks,
    threshold: REDEEM_CARD_FAIL_LOCK_THRESHOLD,
    windowSeconds: TTL.redeemCardWindow,
  }
}

export const clearAllRedeemCardFailLocks = async () => {
  const fromIndex = await collectIpsFromIndex()
  const fromScan = await collectIpsFromScan()
  const ipSet = new Set([...fromIndex, ...fromScan])
  let unlocked = 0
  for (const ip of ipSet) {
    const result = await unlockRedeemCardFail(ip)
    if (result.unlocked) {
      unlocked += 1
    }
  }
  await redis.client.del(RedisKeys.redeemCard.failIndex).catch((e) => console.error(e))
  logger.security(`Redeem card fail locks cleared all count=${unlocked}`)
  return { unlocked, total: ipSet.size }
}
