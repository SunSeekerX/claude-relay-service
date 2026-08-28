#!/usr/bin/env node
import { redis } from '../src/infra/redis.js'
import { apiKeyService } from '../src/modules/apikey/apikey_service.js'
import { logger } from '../src/common/logger.js'
import readline from 'node:readline'

/**
 * 数据迁移脚本：为现有 API Key 设置默认有效期
 *
 * 使用方法：
 * node scripts/migrate-apikey-expiry.js [--days=30] [--dry-run]
 *
 * 参数：
 * --days: 设置默认有效期天数（默认30天）
 * --dry-run: 仅模拟运行，不实际修改数据
 */

// 解析命令行参数
const args = process.argv.slice(2)
const params = {}
args.forEach((arg) => {
  const [key, value] = arg.split('=')
  params[key.replace('--', '')] = value || true
})

const DEFAULT_DAYS = params.days ? parseInt(params.days) : 30
const DRY_RUN = params['dry-run'] === true

// 创建 readline 接口用于用户确认
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

async function askConfirmation(question) {
  return new Promise((resolve) => {
    rl.question(`${question} (yes/no): `, (answer) => {
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y')
    })
  })
}

async function migrateApiKeys() {
  try {
    logger.info('Starting API Key expiry migration...')
    logger.info(`Default expiry period: ${DEFAULT_DAYS} days`)
    logger.info(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE RUN'}`)

    // 连接 Redis
    await redis.connect()
    logger.success('Connected to Redis')

    // 获取所有 API Keys
    const apiKeys = await apiKeyService.getAllApiKeysFast()
    logger.info(`Found ${apiKeys.length} API Keys in total`)

    // 统计信息
    const stats = {
      total: apiKeys.length,
      needsMigration: 0,
      alreadyHasExpiry: 0,
      migrated: 0,
      errors: 0,
    }

    // 需要迁移的 Keys
    const keysToMigrate = []

    // 分析每个 API Key
    for (const key of apiKeys) {
      if (!key.expiresAt || key.expiresAt === 'null' || key.expiresAt === '') {
        keysToMigrate.push(key)
        stats.needsMigration++
        logger.info(`API Key "${key.name}" (${key.id}) needs migration`)
      } else {
        stats.alreadyHasExpiry++
        const expiryDate = new Date(key.expiresAt)
        logger.info(`API Key "${key.name}" (${key.id}) already has expiry: ${expiryDate.toLocaleString()}`)
      }
    }

    if (keysToMigrate.length === 0) {
      logger.success('No API Keys need migration!')
      return
    }

    // 显示迁移摘要
    console.log(`\n${'='.repeat(60)}`)
    console.log('Migration Summary:')
    console.log('='.repeat(60))
    console.log(`Total API Keys: ${stats.total}`)
    console.log(`Already have expiry: ${stats.alreadyHasExpiry}`)
    console.log(`Need migration: ${stats.needsMigration}`)
    console.log(`Default expiry: ${DEFAULT_DAYS} days from now`)
    console.log(`${'='.repeat(60)}\n`)

    // 如果不是 dry run，请求确认
    if (!DRY_RUN) {
      const confirmed = await askConfirmation(
        `This will set expiry dates for ${keysToMigrate.length} API Keys. Continue?`,
      )

      if (!confirmed) {
        logger.warn('Migration cancelled by user')
        return
      }
    }

    // 计算新的过期时间
    const newExpiryDate = new Date()
    newExpiryDate.setDate(newExpiryDate.getDate() + DEFAULT_DAYS)
    const newExpiryISO = newExpiryDate.toISOString()

    logger.info(`\nStarting migration... New expiry date: ${newExpiryDate.toLocaleString()}`)

    // 执行迁移
    for (const key of keysToMigrate) {
      try {
        if (!DRY_RUN) {
          // 直接更新 Redis 中的数据
          // 使用 hset 更新单个字段
          await redis.client.hset(`apikey:${key.id}`, 'expiresAt', newExpiryISO)
          logger.success(`Migrated: "${key.name}" (${key.id})`)
        } else {
          logger.info(`[DRY RUN] Would migrate: "${key.name}" (${key.id})`)
        }
        stats.migrated++
      } catch (error) {
        logger.error(`Error migrating "${key.name}" (${key.id}):`, error.message)
        stats.errors++
      }
    }

    // 显示最终结果
    console.log(`\n${'='.repeat(60)}`)
    console.log('Migration Complete!')
    console.log('='.repeat(60))
    console.log(`Successfully migrated: ${stats.migrated}`)
    console.log(`Errors: ${stats.errors}`)
    console.log(`New expiry date: ${newExpiryDate.toLocaleString()}`)
    console.log(`${'='.repeat(60)}\n`)

    if (DRY_RUN) {
      logger.warn('This was a DRY RUN. No actual changes were made.')
      logger.info('Run without --dry-run flag to apply changes.')
    }
  } catch (error) {
    logger.error('Migration failed:', error)
    process.exit(1)
  } finally {
    // 清理
    rl.close()
    await redis.disconnect()
    logger.info('Disconnected from Redis')
  }
}

// 显示帮助信息
if (params.help) {
  console.log(`
API Key Expiry Migration Script

This script adds expiry dates to existing API Keys that don't have one.

Usage:
  node scripts/migrate-apikey-expiry.js [options]

Options:
  --days=NUMBER    Set default expiry days (default: 30)
  --dry-run        Simulate the migration without making changes
  --help           Show this help message

Examples:
  # Set 30-day expiry for all API Keys without expiry
  node scripts/migrate-apikey-expiry.js

  # Set 90-day expiry
  node scripts/migrate-apikey-expiry.js --days=90

  # Test run without making changes
  node scripts/migrate-apikey-expiry.js --dry-run
`)
  process.exit(0)
}

// 运行迁移
migrateApiKeys().catch((error) => {
  logger.error('Unexpected error:', error)
  process.exit(1)
})
