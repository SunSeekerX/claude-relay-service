#!/usr/bin/env node
import { redis } from '../src/infra/redis.js'
import { logger } from '../src/common/logger.js'
/**
 * Redis 键调试工具
 * 用于查看 Redis 中存储的所有键和数据结构
 */

async function debugRedisKeys() {
  try {
    logger.info('Connecting to Redis...')
    await redis.connect()
    logger.success('Connected to Redis')

    // 获取所有键
    const allKeys = await redis.client.keys('*')
    logger.info(`\nTotal keys in Redis: ${allKeys.length}\n`)

    // 按类型分组
    const keysByType = {
      apiKeys: [],
      claudeAccounts: [],
      geminiAccounts: [],
      admins: [],
      sessions: [],
      usage: [],
      other: [],
    }

    // 分类键
    for (const key of allKeys) {
      if (key.startsWith('apikey:')) {
        keysByType.apiKeys.push(key)
      } else if (key.startsWith('claude_account:')) {
        keysByType.claudeAccounts.push(key)
      } else if (key.startsWith('gemini_account:')) {
        keysByType.geminiAccounts.push(key)
      } else if (key.startsWith('admin:') || key.startsWith('admin_username:')) {
        keysByType.admins.push(key)
      } else if (key.startsWith('session:')) {
        keysByType.sessions.push(key)
      } else if (key.includes('usage') || key.includes('rate_limit') || key.includes('concurrency')) {
        keysByType.usage.push(key)
      } else {
        keysByType.other.push(key)
      }
    }

    // 显示分类结果
    console.log('='.repeat(60))
    console.log('Keys by Category:')
    console.log('='.repeat(60))
    console.log(`API Keys: ${keysByType.apiKeys.length}`)
    console.log(`Claude Accounts: ${keysByType.claudeAccounts.length}`)
    console.log(`Gemini Accounts: ${keysByType.geminiAccounts.length}`)
    console.log(`Admins: ${keysByType.admins.length}`)
    console.log(`Sessions: ${keysByType.sessions.length}`)
    console.log(`Usage/Rate Limit: ${keysByType.usage.length}`)
    console.log(`Other: ${keysByType.other.length}`)
    console.log('='.repeat(60))

    // 详细显示每个类别的键
    if (keysByType.apiKeys.length > 0) {
      console.log('\nAPI Keys:')
      for (const key of keysByType.apiKeys.slice(0, 5)) {
        console.log(`  - ${key}`)
      }
      if (keysByType.apiKeys.length > 5) {
        console.log(`  ... and ${keysByType.apiKeys.length - 5} more`)
      }
    }

    if (keysByType.claudeAccounts.length > 0) {
      console.log('\nClaude Accounts:')
      for (const key of keysByType.claudeAccounts) {
        console.log(`  - ${key}`)
      }
    }

    if (keysByType.geminiAccounts.length > 0) {
      console.log('\nGemini Accounts:')
      for (const key of keysByType.geminiAccounts) {
        console.log(`  - ${key}`)
      }
    }

    if (keysByType.other.length > 0) {
      console.log('\nOther Keys:')
      for (const key of keysByType.other.slice(0, 10)) {
        console.log(`  - ${key}`)
      }
      if (keysByType.other.length > 10) {
        console.log(`  ... and ${keysByType.other.length - 10} more`)
      }
    }

    // 检查数据类型
    console.log(`\n${'='.repeat(60)}`)
    console.log('Checking Data Types:')
    console.log('='.repeat(60))

    // 随机检查几个键的类型
    const sampleKeys = allKeys.slice(0, Math.min(10, allKeys.length))
    for (const key of sampleKeys) {
      const type = await redis.client.type(key)
      console.log(`${key} => ${type}`)
    }
  } catch (error) {
    logger.error('Debug failed:', error)
  } finally {
    await redis.disconnect()
    logger.info('Disconnected from Redis')
  }
}

// 运行调试
debugRedisKeys().catch((error) => {
  logger.error('Unexpected error:', error)
  process.exit(1)
})
