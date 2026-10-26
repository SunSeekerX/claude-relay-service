import crypto from 'node:crypto'
import { RedisKeys, TTL } from './redis_key.js'
import { RedisLua } from './redis_lua.js'

export const attach = (redis) => {
  redis.getGeminiInteraction = async (ownerId, id) => {
    const raw = await redis.getClientSafe().get(RedisKeys.geminiInteraction.record(ownerId, id))
    return raw ? JSON.parse(raw) : null
  }

  redis.createGeminiInteraction = async (record) => {
    const key = RedisKeys.geminiInteraction.record(record.ownerId, record.id)
    await redis.getClientSafe().set(key, JSON.stringify(record), 'EX', TTL.geminiInteraction, 'NX')
    return key
  }

  redis.saveGeminiInteraction = async (key, record) => {
    await redis.getClientSafe().set(key, JSON.stringify(record), 'KEEPTTL', 'XX')
  }

  redis.scheduleGeminiInteraction = async (key, pending) => {
    const client = redis.getClientSafe()
    if (pending) {
      await client.zadd(RedisKeys.geminiInteraction.pending, Date.now() + TTL.geminiInteractionPoll * 1000, key)
    } else {
      await client.zrem(RedisKeys.geminiInteraction.pending, key)
    }
  }

  redis.getPendingGeminiInteractions = async () =>
    redis.getClientSafe().zrangebyscore(RedisKeys.geminiInteraction.pending, '-inf', Date.now(), 'LIMIT', 0, 50)

  redis.lockGeminiInteraction = async (key) => {
    const owner = crypto.randomUUID()
    const acquired = await redis
      .getClientSafe()
      .set(RedisKeys.geminiInteraction.lock(key), owner, 'EX', TTL.geminiInteractionLease, 'NX')
    return acquired ? owner : null
  }

  redis.unlockGeminiInteraction = async (key, owner) =>
    redis.getClientSafe().eval(RedisLua.geminiInteraction.unlock, 1, RedisKeys.geminiInteraction.lock(key), owner)
}
