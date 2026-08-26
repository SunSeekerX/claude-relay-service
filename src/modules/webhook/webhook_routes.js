import express from 'express'
import { logger } from '../../common/logger.js'
import { webhookService } from './webhook_service.js'
import { webhookConfigService } from './webhook_config_service.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { getISOStringWithTimezone } from '../../common/date_helper.js'
export const router = express.Router()

// 获取webhook配置
router.get('/config', authenticateAdmin, async (req, res) => {
  try {
    const config = await webhookConfigService.getConfig()
    res.json({
      success: true,
      config,
    })
  } catch (error) {
    logger.error('获取webhook配置失败:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: '获取webhook配置失败',
    })
  }
})

// 保存webhook配置
router.post('/config', authenticateAdmin, async (req, res) => {
  try {
    const config = await webhookConfigService.saveConfig(req.body)
    res.json({
      success: true,
      message: 'Webhook配置已保存',
      config,
    })
  } catch (error) {
    logger.error('保存webhook配置失败:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || '保存webhook配置失败',
    })
  }
})

// 添加webhook平台
router.post('/platforms', authenticateAdmin, async (req, res) => {
  try {
    const platform = await webhookConfigService.addPlatform(req.body)
    res.json({
      success: true,
      message: 'Webhook平台已添加',
      platform,
    })
  } catch (error) {
    logger.error('添加webhook平台失败:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || '添加webhook平台失败',
    })
  }
})

// 更新webhook平台
router.put('/platforms/:id', authenticateAdmin, async (req, res) => {
  try {
    const platform = await webhookConfigService.updatePlatform(req.params.id, req.body)
    res.json({
      success: true,
      message: 'Webhook平台已更新',
      platform,
    })
  } catch (error) {
    logger.error('更新webhook平台失败:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || '更新webhook平台失败',
    })
  }
})

// 删除webhook平台
router.delete('/platforms/:id', authenticateAdmin, async (req, res) => {
  try {
    await webhookConfigService.deletePlatform(req.params.id)
    res.json({
      success: true,
      message: 'Webhook平台已删除',
    })
  } catch (error) {
    logger.error('删除webhook平台失败:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || '删除webhook平台失败',
    })
  }
})

// 切换webhook平台启用状态
router.post('/platforms/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    const platform = await webhookConfigService.togglePlatform(req.params.id)
    res.json({
      success: true,
      message: `Webhook平台已${platform.enabled ? '启用' : '禁用'}`,
      platform,
    })
  } catch (error) {
    logger.error('切换webhook平台状态失败:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || '切换webhook平台状态失败',
    })
  }
})

// 测试Webhook连通性
router.post('/test', authenticateAdmin, async (req, res) => {
  try {
    const {
      url,
      type = 'custom',
      secret,
      enableSign,
      deviceKey,
      serverUrl,
      level,
      sound,
      group,
      // SMTP 相关字段
      host,
      port,
      secure,
      user,
      pass,
      from,
      to,
      ignoreTLS,
      botToken,
      chatId,
      apiBaseUrl,
      proxyUrl,
    } = req.body

    // Bark平台特殊处理
    if (type === 'bark') {
      if (!deviceKey) {
        return res.status(400).json({
          error: 'Missing device key',
          message: '请提供Bark设备密钥',
        })
      }

      // 验证服务器URL（如果提供）
      if (serverUrl) {
        try {
          new URL(serverUrl)
        } catch (urlError) {
          return res.status(400).json({
            error: 'Invalid server URL format',
            message: '请提供有效的Bark服务器URL',
          })
        }
      }

      logger.info(`🧪 测试webhook: ${type} - Device Key: ${deviceKey.substring(0, 8)}...`)
    } else if (type === 'smtp') {
      // SMTP平台验证
      if (!host) {
        return res.status(400).json({
          error: 'Missing SMTP host',
          message: '请提供SMTP服务器地址',
        })
      }
      if (!user) {
        return res.status(400).json({
          error: 'Missing SMTP user',
          message: '请提供SMTP用户名',
        })
      }
      if (!pass) {
        return res.status(400).json({
          error: 'Missing SMTP password',
          message: '请提供SMTP密码',
        })
      }
      if (!to) {
        return res.status(400).json({
          error: 'Missing recipient email',
          message: '请提供收件人邮箱',
        })
      }

      logger.info(`🧪 测试webhook: ${type} - ${host}:${port || 587} -> ${to}`)
    } else if (type === 'telegram') {
      if (!botToken) {
        return res.status(400).json({
          error: 'Missing Telegram bot token',
          message: '请提供 Telegram 机器人 Token',
        })
      }
      if (!chatId) {
        return res.status(400).json({
          error: 'Missing Telegram chat id',
          message: '请提供 Telegram Chat ID',
        })
      }

      if (apiBaseUrl) {
        try {
          const parsed = new URL(apiBaseUrl)
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).json({
              error: 'Invalid Telegram API base url protocol',
              message: 'Telegram API 基础地址仅支持 http 或 https',
            })
          }
        } catch (urlError) {
          return res.status(400).json({
            error: 'Invalid Telegram API base url',
            message: '请提供有效的 Telegram API 基础地址',
          })
        }
      }

      if (proxyUrl) {
        try {
          const parsed = new URL(proxyUrl)
          const supportedProtocols = ['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:']
          if (!supportedProtocols.includes(parsed.protocol)) {
            return res.status(400).json({
              error: 'Unsupported proxy protocol',
              message: 'Telegram 代理仅支持 http/https/socks 协议',
            })
          }
        } catch (urlError) {
          return res.status(400).json({
            error: 'Invalid proxy url',
            message: '请提供有效的代理地址',
          })
        }
      }

      logger.info(`🧪 测试webhook: ${type} - Chat ID: ${chatId}`)
    } else {
      // 其他平台验证URL
      if (!url) {
        return res.status(400).json({
          error: 'Missing webhook URL',
          message: '请提供webhook URL',
        })
      }

      // 验证URL格式
      try {
        new URL(url)
      } catch (urlError) {
        return res.status(400).json({
          error: 'Invalid URL format',
          message: '请提供有效的webhook URL',
        })
      }

      logger.info(`🧪 测试webhook: ${type} - ${url}`)
    }

    // 创建临时平台配置
    const platform = {
      type,
      url,
      secret,
      enableSign,
      enabled: true,
      timeout: 10000,
    }

    // 添加Bark特有字段
    if (type === 'bark') {
      platform.deviceKey = deviceKey
      platform.serverUrl = serverUrl
      platform.level = level
      platform.sound = sound
      platform.group = group
    } else if (type === 'smtp') {
      // 添加SMTP特有字段
      platform.host = host
      platform.port = port || 587
      platform.secure = secure || false
      platform.user = user
      platform.pass = pass
      platform.from = from
      platform.to = to
      platform.ignoreTLS = ignoreTLS || false
    } else if (type === 'telegram') {
      platform.botToken = botToken
      platform.chatId = chatId
      platform.apiBaseUrl = apiBaseUrl
      platform.proxyUrl = proxyUrl
    }

    const result = await webhookService.testWebhook(platform)

    const identifier = (() => {
      if (type === 'bark') {
        return `Device: ${deviceKey.substring(0, 8)}...`
      }
      if (type === 'smtp') {
        const recipients = Array.isArray(to) ? to.join(', ') : to
        return `${host}:${port || 587} -> ${recipients}`
      }
      if (type === 'telegram') {
        return `Chat ID: ${chatId}`
      }
      return url
    })()

    if (result.success) {
      logger.info(`✅ Webhook测试成功: ${identifier}`)
      res.json({
        success: true,
        message: 'Webhook测试成功',
        url: type === 'bark' ? undefined : url,
        deviceKey: type === 'bark' ? `${deviceKey.substring(0, 8)}...` : undefined,
      })
    } else {
      logger.warn(`❌ Webhook测试失败: ${identifier} - ${result.error}`)
      res.status(400).json({
        success: false,
        message: 'Webhook测试失败',
        url: type === 'bark' ? undefined : url,
        deviceKey: type === 'bark' ? `${deviceKey.substring(0, 8)}...` : undefined,
        error: result.error,
      })
    }
  } catch (error) {
    logger.error('❌ Webhook测试错误:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: '测试webhook失败',
    })
  }
})

// 手动触发测试通知
router.post('/test-notification', authenticateAdmin, async (req, res) => {
  try {
    const {
      type = 'test',
      accountId = 'test-account-id',
      accountName = '测试账号',
      platform = 'claude-oauth',
      status = 'test',
      errorCode = 'TEST_NOTIFICATION',
      reason = '手动测试通知',
      message = '这是一条测试通知消息，用于验证 Webhook 通知功能是否正常工作',
    } = req.body

    logger.info(`🧪 发送测试通知: ${type}`)

    // 先检查webhook配置
    const config = await webhookConfigService.getConfig()
    logger.debug(`Webhook配置: enabled=${config.enabled}, platforms=${config.platforms?.length || 0}`)
    if (!config.enabled) {
      return res.status(400).json({
        success: false,
        message: 'Webhook通知未启用，请先在设置中启用通知功能',
      })
    }

    const enabledPlatforms = await webhookConfigService.getEnabledPlatforms()
    logger.info(`找到 ${enabledPlatforms.length} 个启用的通知平台`)

    if (enabledPlatforms.length === 0) {
      return res.status(400).json({
        success: false,
        message: '没有启用的通知平台，请先添加并启用至少一个通知平台',
      })
    }

    const testData = {
      accountId,
      accountName,
      platform,
      status,
      errorCode,
      reason,
      message,
      timestamp: getISOStringWithTimezone(new Date()),
    }

    const result = await webhookService.sendNotification(type, testData)

    // 如果没有返回结果，说明可能是配置问题
    if (!result) {
      return res.status(400).json({
        success: false,
        message: 'Webhook服务未返回结果，请检查配置和日志',
        enabledPlatforms: enabledPlatforms.length,
      })
    }

    // 如果没有成功和失败的记录
    if (result.succeeded === 0 && result.failed === 0) {
      return res.status(400).json({
        success: false,
        message: '没有发送任何通知，请检查通知类型配置',
        result,
        enabledPlatforms: enabledPlatforms.length,
      })
    }

    if (result.failed > 0) {
      logger.warn(`⚠️ 测试通知部分失败: ${result.succeeded}成功, ${result.failed}失败`)
      return res.json({
        success: true,
        message: `测试通知部分成功: ${result.succeeded}个平台成功, ${result.failed}个平台失败`,
        data: testData,
        result,
      })
    }

    logger.info(`✅ 测试通知发送成功到 ${result.succeeded} 个平台`)

    res.json({
      success: true,
      message: `测试通知已成功发送到 ${result.succeeded} 个平台`,
      data: testData,
      result,
    })
  } catch (error) {
    logger.error('❌ 发送测试通知失败:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: `发送测试通知失败: ${error.message}`,
    })
  }
})
