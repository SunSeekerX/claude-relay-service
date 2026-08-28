import express from 'express'
import { redis } from '../../infra/redis.js'
import { logger } from '../../common/logger.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { calculateWaitTimeStats } from '../../common/stats_helper.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'
/**
 * 并发管理 API 路由
 * 提供并发状态查看和手动清理功能
 */

export const router = express.Router()

/**
 * GET /admin/concurrency
 * 获取所有并发状态
 */
router.get(
  '/concurrency',
  authenticateAdmin,
  asyncRoute('Failed to get concurrency status', async () => {
    const status = await redis.getAllConcurrencyStatus()

    // 为每个 API Key 获取排队计数
    const statusWithQueue = await Promise.all(
      status.map(async (s) => {
        const queueCount = await redis.getConcurrencyQueueCount(s.apiKeyId)
        return {
          ...s,
          queueCount,
        }
      }),
    )

    // 计算汇总统计
    const summary = {
      totalKeys: statusWithQueue.length,
      totalActiveRequests: statusWithQueue.reduce((sum, s) => sum + s.activeCount, 0),
      totalExpiredRequests: statusWithQueue.reduce((sum, s) => sum + s.expiredCount, 0),
      totalQueuedRequests: statusWithQueue.reduce((sum, s) => sum + s.queueCount, 0),
    }

    return {
      summary,
      concurrencyStatus: statusWithQueue,
    }
  }),
)

/**
 * GET /admin/concurrency-queue/stats
 * 获取排队统计信息
 */
router.get(
  '/concurrency-queue/stats',
  authenticateAdmin,
  asyncRoute('Failed to get queue stats', async () => {
    // 获取所有有统计数据的 API Key
    const statsKeys = await redis.scanConcurrencyQueueStatsKeys()
    const queueKeys = await redis.scanConcurrencyQueueKeys()

    // 合并所有相关的 API Key
    const allApiKeyIds = [...new Set([...statsKeys, ...queueKeys])]

    // 获取各 API Key 的详细统计
    const perKeyStats = await Promise.all(
      allApiKeyIds.map(async (apiKeyId) => {
        const [queueCount, stats, waitTimes] = await Promise.all([
          redis.getConcurrencyQueueCount(apiKeyId),
          redis.getConcurrencyQueueStats(apiKeyId),
          redis.getQueueWaitTimes(apiKeyId),
        ])

        return {
          apiKeyId,
          currentQueueCount: queueCount,
          stats,
          waitTimeStats: calculateWaitTimeStats(waitTimes),
        }
      }),
    )

    // 获取全局等待时间统计
    const globalWaitTimes = await redis.getGlobalQueueWaitTimes()
    const globalWaitTimeStats = calculateWaitTimeStats(globalWaitTimes)

    // 计算全局汇总
    const globalStats = {
      totalEntered: perKeyStats.reduce((sum, s) => sum + s.stats.entered, 0),
      totalSuccess: perKeyStats.reduce((sum, s) => sum + s.stats.success, 0),
      totalTimeout: perKeyStats.reduce((sum, s) => sum + s.stats.timeout, 0),
      totalCancelled: perKeyStats.reduce((sum, s) => sum + s.stats.cancelled, 0),
      totalSocketChanged: perKeyStats.reduce((sum, s) => sum + (s.stats.socket_changed || 0), 0),
      totalRejectedOverload: perKeyStats.reduce((sum, s) => sum + (s.stats.rejected_overload || 0), 0),
      currentTotalQueued: perKeyStats.reduce((sum, s) => sum + s.currentQueueCount, 0),
      // 队列资源利用率指标
      peakQueueSize: perKeyStats.length > 0 ? Math.max(...perKeyStats.map((s) => s.currentQueueCount)) : 0,
      avgQueueSize:
        perKeyStats.length > 0
          ? Math.round(perKeyStats.reduce((sum, s) => sum + s.currentQueueCount, 0) / perKeyStats.length)
          : 0,
      activeApiKeys: perKeyStats.filter((s) => s.currentQueueCount > 0).length,
    }

    // 计算成功率
    if (globalStats.totalEntered > 0) {
      globalStats.successRate = Math.round((globalStats.totalSuccess / globalStats.totalEntered) * 100)
      globalStats.timeoutRate = Math.round((globalStats.totalTimeout / globalStats.totalEntered) * 100)
      globalStats.cancelledRate = Math.round((globalStats.totalCancelled / globalStats.totalEntered) * 100)
    }

    // 从全局等待时间统计中提取关键指标
    if (globalWaitTimeStats) {
      globalStats.avgWaitTimeMs = globalWaitTimeStats.avg
      globalStats.p50WaitTimeMs = globalWaitTimeStats.p50
      globalStats.p90WaitTimeMs = globalWaitTimeStats.p90
      globalStats.p99WaitTimeMs = globalWaitTimeStats.p99
      // 多实例采样策略标记（详见 design.md Decision 9）
      // 全局 P90 仅用于可视化和监控，不用于系统决策
      // 健康检查使用 API Key 级别的 P90（每 Key 独立采样）
      globalWaitTimeStats.globalP90ForVisualizationOnly = true
    }

    return {
      globalStats,
      globalWaitTimeStats,
      perKeyStats,
    }
  }),
)

/**
 * DELETE /admin/concurrency-queue/:apiKeyId
 * 清理特定 API Key 的排队计数
 */
router.delete(
  '/concurrency-queue/:apiKeyId',
  authenticateAdmin,
  asyncRoute('Failed to clear queue', async (req) => {
    const { apiKeyId } = req.params
    await redis.clearConcurrencyQueue(apiKeyId)

    logger.warn(`Admin ${req.admin?.username || 'unknown'} cleared queue for key ${apiKeyId}`)

    return ok(undefined, `Successfully cleared queue for API key ${apiKeyId}`)
  }),
)

/**
 * DELETE /admin/concurrency-queue
 * 清理所有排队计数
 */
router.delete(
  '/concurrency-queue',
  authenticateAdmin,
  asyncRoute('Failed to clear all queues', async (req) => {
    const cleared = await redis.clearAllConcurrencyQueues()

    logger.warn(`Admin ${req.admin?.username || 'unknown'} cleared ALL queues`)

    return ok({ cleared }, 'Successfully cleared all queues')
  }),
)

/**
 * GET /admin/concurrency/:apiKeyId
 * 获取特定 API Key 的并发状态详情
 */
router.get(
  '/concurrency/:apiKeyId',
  authenticateAdmin,
  asyncRoute('Failed to get concurrency status', async (req) => {
    const { apiKeyId } = req.params
    const status = await redis.getConcurrencyStatus(apiKeyId)
    const queueCount = await redis.getConcurrencyQueueCount(apiKeyId)

    return {
      concurrencyStatus: {
        ...status,
        queueCount,
      },
    }
  }),
)

/**
 * DELETE /admin/concurrency/:apiKeyId
 * 强制清理特定 API Key 的并发计数
 */
router.delete(
  '/concurrency/:apiKeyId',
  authenticateAdmin,
  asyncRoute('Failed to clear concurrency', async (req) => {
    const { apiKeyId } = req.params
    const result = await redis.forceClearConcurrency(apiKeyId)

    logger.warn(`Admin ${req.admin?.username || 'unknown'} force cleared concurrency for key ${apiKeyId}`)

    return ok({ result }, `Successfully cleared concurrency for API key ${apiKeyId}`)
  }),
)

/**
 * DELETE /admin/concurrency
 * 强制清理所有并发计数
 */
router.delete(
  '/concurrency',
  authenticateAdmin,
  asyncRoute('Failed to clear all concurrency', async (req) => {
    const result = await redis.forceClearAllConcurrency()

    logger.warn(`Admin ${req.admin?.username || 'unknown'} force cleared ALL concurrency`)

    return ok({ result }, 'Successfully cleared all concurrency')
  }),
)

/**
 * POST /admin/concurrency/cleanup
 * 清理过期的并发条目（不影响活跃请求）
 */
router.post(
  '/concurrency/cleanup',
  authenticateAdmin,
  asyncRoute('Failed to cleanup expired concurrency', async (req) => {
    const { apiKeyId } = parseObjectBody(req.body, '并发清理')
    const result = await redis.cleanupExpiredConcurrency(apiKeyId || null)

    logger.info(`Admin ${req.admin?.username || 'unknown'} cleaned up expired concurrency`)

    return ok(
      { result },
      apiKeyId
        ? `Successfully cleaned up expired concurrency for API key ${apiKeyId}`
        : 'Successfully cleaned up all expired concurrency',
    )
  }),
)
