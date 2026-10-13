import { redis } from '../../infra/redis.js'
import { logger } from '../../common/logger.js'
import { RedisKeys, LIMITS } from '../../infra/redis_key.js'
import { env } from '../../../config/env.js'
import crypto from 'node:crypto'

export const buildBillingEvent = (eventData) => ({
  eventId: crypto.randomUUID(),
  eventType: 'usage.recorded',
  timestamp: new Date().toISOString(),
  version: '1.0',
  apiKey: {
    id: eventData.keyId,
    name: eventData.keyName ?? null,
    userId: eventData.userId ?? null
  },
  usage: {
    model: eventData.model,
    inputTokens: eventData.inputTokens ?? 0,
    outputTokens: eventData.outputTokens ?? 0,
    cacheCreateTokens: eventData.cacheCreateTokens ?? 0,
    cacheReadTokens: eventData.cacheReadTokens ?? 0,
    ephemeral5mTokens: eventData.ephemeral5mTokens ?? 0,
    ephemeral1hTokens: eventData.ephemeral1hTokens ?? 0,
    totalTokens: eventData.totalTokens ?? 0,
    toolUsage: eventData.toolUsage ?? null
  },
  cost: {
    total: eventData.realCost ?? eventData.cost ?? 0,
    currency: 'USD',
    base: eventData.baseCost ?? eventData.realCost ?? eventData.cost ?? 0,
    rated: eventData.ratedCost ?? eventData.cost ?? 0,
    real: eventData.realCost ?? eventData.cost ?? 0,
    upstreamTicks: eventData.upstreamCostTicks ?? null,
    realCostSource: eventData.realCostSource ?? 'price_table',
    tools: eventData.toolCost ?? 0,
    breakdown: eventData.costBreakdown ?? null,
    baseBreakdown: eventData.baseCostBreakdown ?? eventData.costBreakdown ?? null
  },
  account: { id: eventData.accountId ?? null, type: eventData.accountType ?? null },
  context: {
    requestId: eventData.requestId ?? null,
    endpoint: eventData.endpoint ?? null,
    statusCode: eventData.statusCode ?? null,
    serviceTier: eventData.serviceTier ?? null,
    isLongContext: eventData.isLongContext === true,
    requestTimestamp: eventData.requestTimestamp ?? new Date().toISOString()
  }
})

/**
 * 计费事件发布器 - 使用 Redis Stream 解耦计费系统
 *
 * 设计原则:
 * 1. 异步非阻塞: 发布失败不影响主流程
 * 2. 结构化数据: 使用标准化的事件格式
 * 3. 可追溯性: 每个事件包含完整上下文
 */
class BillingEventPublisher {
  constructor() {
    this.streamKey = RedisKeys.billingEvents
    this.maxLength = LIMITS.billingEventsStream // 保留最近 10 万条事件
    this.enabled = env.BILLING_EVENTS_ENABLED !== 'false' // 默认开启
  }

  /**
   * 发布计费事件
   * @param {Object} eventData - 事件数据
   * @returns {Promise<string|null>} - 事件ID 或 null
   */
  async publishBillingEvent(eventData) {
    if (!this.enabled) {
      logger.debug('Billing events disabled, skipping publish')
      return null
    }

    try {
      const client = redis.getClientSafe()

      const event = buildBillingEvent(eventData)

      // 使用 XADD 发布事件到 Stream
      // MAXLEN ~ 10000: 近似截断，保持性能
      const messageId = await client.xadd(
        this.streamKey,
        'MAXLEN',
        '~',
        this.maxLength,
        '*', // 自动生成消息ID
        'data',
        JSON.stringify(event),
      )

      logger.debug(
        `Published billing event: ${messageId} | Key: ${eventData.keyId} | Cost: $${event.cost.total.toFixed(6)}`,
      )

      return messageId
    } catch (error) {
      // 发布失败不影响主流程，只记录错误
      logger.error('Failed to publish billing event:', error)
      return null
    }
  }

  /**
   * 批量发布计费事件（优化性能）
   * @param {Array<Object>} events - 事件数组
   * @returns {Promise<number>} - 成功发布的事件数
   */
  async publishBatchBillingEvents(events) {
    if (!this.enabled || !events || events.length === 0) {
      return 0
    }

    try {
      const client = redis.getClientSafe()
      const pipeline = client.pipeline()

      events.forEach((eventData) => {
        const event = buildBillingEvent(eventData)

        pipeline.xadd(this.streamKey, 'MAXLEN', '~', this.maxLength, '*', 'data', JSON.stringify(event))
      })

      const results = await pipeline.exec()
      const successCount = results.filter((r) => r[0] === null).length

      logger.info(`Batch published ${successCount}/${events.length} billing events`)
      return successCount
    } catch (error) {
      logger.error('Failed to batch publish billing events:', error)
      return 0
    }
  }

  /**
   * 获取 Stream 信息（用于监控）
   * @returns {Promise<Object>}
   */
  async getStreamInfo() {
    try {
      const client = redis.getClientSafe()
      const info = await client.xinfo('STREAM', this.streamKey)

      // 解析 Redis XINFO 返回的数组格式
      const result = {}
      for (let i = 0; i < info.length; i += 2) {
        result[info[i]] = info[i + 1]
      }

      return {
        length: result.length || 0,
        firstEntry: result['first-entry'] || null,
        lastEntry: result['last-entry'] || null,
        groups: result.groups || 0,
      }
    } catch (error) {
      if (error.message.includes('no such key')) {
        return { length: 0, groups: 0 }
      }
      logger.error('Failed to get stream info:', error)
      return null
    }
  }

  /**
   * 创建消费者组（供外部计费系统使用）
   * @param {string} groupName - 消费者组名称
   * @returns {Promise<boolean>}
   */
  async createConsumerGroup(groupName = 'billing-system') {
    try {
      const client = redis.getClientSafe()

      // MKSTREAM: 如果 stream 不存在则创建
      await client.xgroup('CREATE', this.streamKey, groupName, '0', 'MKSTREAM')

      logger.success(`Created consumer group: ${groupName}`)
      return true
    } catch (error) {
      if (error.message.includes('BUSYGROUP')) {
        logger.debug(`Consumer group ${groupName} already exists`)
        return true
      }
      logger.error(`Failed to create consumer group ${groupName}:`, error)
      return false
    }
  }
}

export const billingEventPublisher = new BillingEventPublisher()
