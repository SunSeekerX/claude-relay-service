import express from 'express'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { claudeRelayConfigService } from './relay_claude_relay_config_service.js'
import { requestDetailService } from './relay_request_detail_service.js'
import { logger } from '../../common/logger.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, badRequest } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'
/**
 * Claude 转发配置 API 路由
 * 管理全局 Claude Code 限制和会话绑定配置
 */

export const router = express.Router()

/**
 * GET /admin/claude-relay-config
 * 获取 Claude 转发配置
 */
router.get(
  '/claude-relay-config',
  authenticateAdmin,
  asyncRoute('Failed to get Claude relay config', async () => {
    const config = await claudeRelayConfigService.getConfig()
    return { config }
  }),
)

/**
 * PUT /admin/claude-relay-config
 * 更新 Claude 转发配置
 */
router.put(
  '/claude-relay-config',
  authenticateAdmin,
  asyncRoute('Failed to update Claude relay config', async (req) => {
    const {
      claudeCodeOnlyEnabled,
      globalSessionBindingEnabled,
      sessionBindingErrorMessage,
      sessionBindingTtlDays,
      userMessageQueueEnabled,
      userMessageQueueDelayMs,
      userMessageQueueTimeoutMs,
      concurrentRequestQueueEnabled,
      concurrentRequestQueueMaxSize,
      concurrentRequestQueueMaxSizeMultiplier,
      concurrentRequestQueueTimeoutMs,
      requestDetailCaptureEnabled,
      requestDetailRetentionHours,
      requestDetailBodyPreviewEnabled,
      purgeRequestDetailBodySnapshots,
      errorHistoryCollectionEnabled,
    } = parseObjectBody(req.body, 'Claude 转发配置')

    // 验证输入
    if (claudeCodeOnlyEnabled !== undefined && typeof claudeCodeOnlyEnabled !== 'boolean') {
      throw badRequest('claudeCodeOnlyEnabled must be a boolean')
    }

    if (globalSessionBindingEnabled !== undefined && typeof globalSessionBindingEnabled !== 'boolean') {
      throw badRequest('globalSessionBindingEnabled must be a boolean')
    }

    if (sessionBindingErrorMessage !== undefined) {
      if (typeof sessionBindingErrorMessage !== 'string') {
        throw badRequest('sessionBindingErrorMessage must be a string')
      }
      if (sessionBindingErrorMessage.length > 500) {
        throw badRequest('sessionBindingErrorMessage must be less than 500 characters')
      }
    }

    if (sessionBindingTtlDays !== undefined) {
      if (typeof sessionBindingTtlDays !== 'number' || sessionBindingTtlDays < 1 || sessionBindingTtlDays > 365) {
        throw badRequest('sessionBindingTtlDays must be a number between 1 and 365')
      }
    }

    // 验证用户消息队列配置
    if (userMessageQueueEnabled !== undefined && typeof userMessageQueueEnabled !== 'boolean') {
      throw badRequest('userMessageQueueEnabled must be a boolean')
    }

    if (userMessageQueueDelayMs !== undefined) {
      if (
        typeof userMessageQueueDelayMs !== 'number' ||
        userMessageQueueDelayMs < 0 ||
        userMessageQueueDelayMs > 10000
      ) {
        throw badRequest('userMessageQueueDelayMs must be a number between 0 and 10000')
      }
    }

    if (userMessageQueueTimeoutMs !== undefined) {
      if (
        typeof userMessageQueueTimeoutMs !== 'number' ||
        userMessageQueueTimeoutMs < 1000 ||
        userMessageQueueTimeoutMs > 300000
      ) {
        throw badRequest('userMessageQueueTimeoutMs must be a number between 1000 and 300000')
      }
    }

    // 验证并发请求排队配置
    if (concurrentRequestQueueEnabled !== undefined && typeof concurrentRequestQueueEnabled !== 'boolean') {
      throw badRequest('concurrentRequestQueueEnabled must be a boolean')
    }

    if (concurrentRequestQueueMaxSize !== undefined) {
      if (
        typeof concurrentRequestQueueMaxSize !== 'number' ||
        !Number.isInteger(concurrentRequestQueueMaxSize) ||
        concurrentRequestQueueMaxSize < 1 ||
        concurrentRequestQueueMaxSize > 100
      ) {
        throw badRequest('concurrentRequestQueueMaxSize must be an integer between 1 and 100')
      }
    }

    if (concurrentRequestQueueMaxSizeMultiplier !== undefined) {
      // 使用 Number.isFinite() 同时排除 NaN、Infinity、-Infinity 和非数字类型
      if (
        !Number.isFinite(concurrentRequestQueueMaxSizeMultiplier) ||
        concurrentRequestQueueMaxSizeMultiplier < 0 ||
        concurrentRequestQueueMaxSizeMultiplier > 10
      ) {
        throw badRequest('concurrentRequestQueueMaxSizeMultiplier must be a finite number between 0 and 10')
      }
    }

    if (concurrentRequestQueueTimeoutMs !== undefined) {
      if (
        typeof concurrentRequestQueueTimeoutMs !== 'number' ||
        !Number.isInteger(concurrentRequestQueueTimeoutMs) ||
        concurrentRequestQueueTimeoutMs < 5000 ||
        concurrentRequestQueueTimeoutMs > 300000
      ) {
        throw badRequest(
          'concurrentRequestQueueTimeoutMs must be an integer between 5000 and 300000 (5 seconds to 5 minutes)',
        )
      }
    }

    if (requestDetailCaptureEnabled !== undefined && typeof requestDetailCaptureEnabled !== 'boolean') {
      throw badRequest('requestDetailCaptureEnabled must be a boolean')
    }

    if (requestDetailRetentionHours !== undefined) {
      if (
        typeof requestDetailRetentionHours !== 'number' ||
        !Number.isInteger(requestDetailRetentionHours) ||
        requestDetailRetentionHours < 1 ||
        requestDetailRetentionHours > 720
      ) {
        throw badRequest('requestDetailRetentionHours must be an integer between 1 and 720')
      }
    }

    if (requestDetailBodyPreviewEnabled !== undefined && typeof requestDetailBodyPreviewEnabled !== 'boolean') {
      throw badRequest('requestDetailBodyPreviewEnabled must be a boolean')
    }

    if (purgeRequestDetailBodySnapshots !== undefined && typeof purgeRequestDetailBodySnapshots !== 'boolean') {
      throw badRequest('purgeRequestDetailBodySnapshots must be a boolean')
    }

    if (errorHistoryCollectionEnabled !== undefined && typeof errorHistoryCollectionEnabled !== 'boolean') {
      throw badRequest('errorHistoryCollectionEnabled must be a boolean')
    }

    const updateData = {}
    if (claudeCodeOnlyEnabled !== undefined) {
      updateData.claudeCodeOnlyEnabled = claudeCodeOnlyEnabled
    }
    if (globalSessionBindingEnabled !== undefined) {
      updateData.globalSessionBindingEnabled = globalSessionBindingEnabled
    }
    if (sessionBindingErrorMessage !== undefined) {
      updateData.sessionBindingErrorMessage = sessionBindingErrorMessage
    }
    if (sessionBindingTtlDays !== undefined) {
      updateData.sessionBindingTtlDays = sessionBindingTtlDays
    }
    if (userMessageQueueEnabled !== undefined) {
      updateData.userMessageQueueEnabled = userMessageQueueEnabled
    }
    if (userMessageQueueDelayMs !== undefined) {
      updateData.userMessageQueueDelayMs = userMessageQueueDelayMs
    }
    if (userMessageQueueTimeoutMs !== undefined) {
      updateData.userMessageQueueTimeoutMs = userMessageQueueTimeoutMs
    }
    if (concurrentRequestQueueEnabled !== undefined) {
      updateData.concurrentRequestQueueEnabled = concurrentRequestQueueEnabled
    }
    if (concurrentRequestQueueMaxSize !== undefined) {
      updateData.concurrentRequestQueueMaxSize = concurrentRequestQueueMaxSize
    }
    if (concurrentRequestQueueMaxSizeMultiplier !== undefined) {
      updateData.concurrentRequestQueueMaxSizeMultiplier = concurrentRequestQueueMaxSizeMultiplier
    }
    if (concurrentRequestQueueTimeoutMs !== undefined) {
      updateData.concurrentRequestQueueTimeoutMs = concurrentRequestQueueTimeoutMs
    }
    if (requestDetailCaptureEnabled !== undefined) {
      updateData.requestDetailCaptureEnabled = requestDetailCaptureEnabled
    }
    if (requestDetailRetentionHours !== undefined) {
      updateData.requestDetailRetentionHours = requestDetailRetentionHours
    }
    if (requestDetailBodyPreviewEnabled !== undefined) {
      updateData.requestDetailBodyPreviewEnabled = requestDetailBodyPreviewEnabled
    }
    if (errorHistoryCollectionEnabled !== undefined) {
      updateData.errorHistoryCollectionEnabled = errorHistoryCollectionEnabled
    }

    const updatedConfig = await claudeRelayConfigService.updateConfig(updateData, req.admin?.username || 'unknown')

    let warning = null
    let requestDetailBodyPreviewPurge = null
    if (requestDetailBodyPreviewEnabled === false && purgeRequestDetailBodySnapshots === true) {
      try {
        requestDetailBodyPreviewPurge = await requestDetailService.purgeRequestBodySnapshots()
      } catch (purgeError) {
        logger.error('Failed to purge request body previews after config update:', purgeError)
        warning = `配置已保存，但历史请求体预览清理失败：${purgeError.message}`
      }
    }

    if (requestDetailBodyPreviewEnabled !== undefined || purgeRequestDetailBodySnapshots !== undefined) {
      logger.info('Request body preview config updated', {
        requestDetailBodyPreviewEnabled:
          requestDetailBodyPreviewEnabled !== undefined
            ? requestDetailBodyPreviewEnabled
            : updatedConfig.requestDetailBodyPreviewEnabled,
        purgeRequestDetailBodySnapshots: purgeRequestDetailBodySnapshots === true,
        purgedSnapshots: requestDetailBodyPreviewPurge?.updatedRecords ?? requestDetailBodyPreviewPurge?.matchedRecords,
      })
    }

    return ok(
      {
        config: updatedConfig,
        warning,
        requestDetailBodyPreviewPurge,
      },
      'Configuration updated successfully',
    )
  }),
)

/**
 * GET /admin/claude-relay-config/session-bindings
 * 获取会话绑定统计
 */
router.get(
  '/claude-relay-config/session-bindings',
  authenticateAdmin,
  asyncRoute('Failed to get session binding stats', async () => claudeRelayConfigService.getSessionBindingStats()),
)
