import { redis } from '../../infra/redis.js'
import { logger } from '../../common/logger.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { RedisLua } from '../../infra/redis_lua.js'
import crypto from 'node:crypto'

/**
 * Token 刷新锁服务
 * 提供分布式锁机制，避免并发刷新问题
 */
class TokenRefreshService {
  constructor() {
    this.lockTTL = 60 // 锁的TTL: 60秒（token刷新通常在30秒内完成）
    this.lockValue = new Map() // 存储每个锁的唯一值
  }

  /**
   * 获取分布式锁
   * 使用唯一标识符作为值，避免误释放其他进程的锁
   */
  async acquireLock(lockKey) {
    try {
      const client = redis.getClientSafe()
      const lockId = crypto.randomUUID()
      const result = await client.set(lockKey, lockId, 'NX', 'EX', this.lockTTL)

      if (result === 'OK') {
        this.lockValue.set(lockKey, lockId)
        logger.debug(`Acquired lock ${lockKey} with ID ${lockId}, TTL: ${this.lockTTL}s`)
        return true
      }
      return false
    } catch (error) {
      logger.error(`Failed to acquire lock ${lockKey}:`, error)
      return false
    }
  }

  /**
   * 释放分布式锁
   * 使用 Lua 脚本确保只释放自己持有的锁
   */
  async releaseLock(lockKey) {
    try {
      const client = redis.getClientSafe()
      const lockId = this.lockValue.get(lockKey)

      if (!lockId) {
        logger.warn(`No lock ID found for ${lockKey}, skipping release`)
        return
      }

      const result = await client.eval(RedisLua.lock.compareAndDel, 1, lockKey, lockId)

      if (result === 1) {
        this.lockValue.delete(lockKey)
        logger.debug(`Released lock ${lockKey} with ID ${lockId}`)
      } else {
        logger.warn(`Lock ${lockKey} was not released - value mismatch or already expired`)
      }
    } catch (error) {
      logger.error(`Failed to release lock ${lockKey}:`, error)
    }
  }

  /**
   * 获取刷新锁
   * @param {string} accountId - 账户ID
   * @param {string} platform - 平台类型 (claude/gemini)
   * @returns {Promise<boolean>} 是否成功获取锁
   */
  async acquireRefreshLock(accountId, platform = 'claude') {
    const lockKey = RedisKeys.lock.tokenRefresh(platform, accountId)
    return await this.acquireLock(lockKey)
  }

  /**
   * 释放刷新锁
   * @param {string} accountId - 账户ID
   * @param {string} platform - 平台类型 (claude/gemini)
   */
  async releaseRefreshLock(accountId, platform = 'claude') {
    const lockKey = RedisKeys.lock.tokenRefresh(platform, accountId)
    await this.releaseLock(lockKey)
  }

  /**
   * 检查刷新锁状态
   * @param {string} accountId - 账户ID
   * @param {string} platform - 平台类型 (claude/gemini)
   * @returns {Promise<boolean>} 锁是否存在
   */
  async isRefreshLocked(accountId, platform = 'claude') {
    const lockKey = RedisKeys.lock.tokenRefresh(platform, accountId)
    try {
      const client = redis.getClientSafe()
      const exists = await client.exists(lockKey)
      return exists === 1
    } catch (error) {
      logger.error(`Failed to check lock status ${lockKey}:`, error)
      return false
    }
  }

  /**
   * 获取锁的剩余TTL
   * @param {string} accountId - 账户ID
   * @param {string} platform - 平台类型 (claude/gemini)
   * @returns {Promise<number>} 剩余秒数，-1表示锁不存在
   */
  async getLockTTL(accountId, platform = 'claude') {
    const lockKey = RedisKeys.lock.tokenRefresh(platform, accountId)
    try {
      const client = redis.getClientSafe()
      const ttl = await client.ttl(lockKey)
      return ttl
    } catch (error) {
      logger.error(`Failed to get lock TTL ${lockKey}:`, error)
      return -1
    }
  }

  /**
   * 清理本地锁记录
   * 在进程退出时调用，避免内存泄漏
   */
  cleanup() {
    this.lockValue.clear()
    logger.info('Cleaned up local lock records')
  }
}

// 创建单例实例
export const tokenRefreshService = new TokenRefreshService()
