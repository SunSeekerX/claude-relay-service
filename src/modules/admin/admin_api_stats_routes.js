import express from 'express'
import axios from 'axios'
import { redis } from '../../infra/redis.js'
import { RedisKeys, TTL } from '../../infra/redis_key.js'
import { logger } from '../../common/logger.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { CostCalculator } from '../pricing/pricing_cost_calculator.js'
import { claudeAccountService } from '../account/account_claude_service.js'
import * as openaiAccountService from '../account/account_openai_service.js'
import { serviceRatesService } from '../payment/payment_service_rates_service.js'
import { modelsConfig } from '../../../config/models.js'
import { testModelConfigService } from '../relay/relay_test_model_config_service.js'
import { getSafeMessage } from '../../common/error_sanitizer.js'
import { parseDateTimeQuery } from '../../common/date_time.js'
import { config } from '../../../config/config.js'
import {
  sendStreamTestRequest,
  createGeminiTestPayload,
  createOpenAITestPayload,
  createClaudeTestPayload,
  extractErrorMessage,
  sanitizeErrorMsg,
} from '../../common/test_payload_helper.js'
import { pricingService } from '../pricing/pricing_service.js'
import { toPublicPricingMap } from '../pricing/pricing_model_pricing_convert.js'
import { parseObjectBody } from '../../common/parse_body.js'
import { quotaCardService } from '../payment/payment_quota_card_service.js'
import { asyncRoute, SEND_RAW } from '../../common/route_handler.js'
import { badRequest, notFound, unauthorized, forbidden, tooManyRequests } from '../../common/http_result.js'

export const router = express.Router()

const accountTypeNames = {
  claude: 'Claude官方',
  'claude-official': 'Claude官方',
  'claude-console': 'Claude Console',
  ccr: 'Claude Console Relay',
  openai: 'OpenAI',
  'openai-responses': 'OpenAI Responses',
  gemini: 'Gemini',
  'gemini-api': 'Gemini API',
  'azure-openai': 'Azure OpenAI',
  azure_openai: 'Azure OpenAI',
  droid: 'Droid',
  grok: 'Grok',
  bedrock: 'AWS Bedrock',
  unknown: '未知渠道',
}

// 获取可用模型列表（公开接口）
router.get(
  '/models',
  asyncRoute('Failed to get models', async (req) => {
    const { service } = req.query

    if (service) {
      // 返回指定服务的模型
      return modelsConfig.getModelsByService(service)
    }

    // 测试默认模型配置（后台可配置，连通性测试弹窗读取）
    // 仅取模型映射，剥离 updatedAt/updatedBy 等管理元数据，避免公开接口泄露管理员信息
    const defaultModels = await testModelConfigService.getModelDefaults()

    // 返回所有模型（按服务分组 + 平台维度）
    return {
      claude: modelsConfig.CLAUDE_MODELS,
      gemini: modelsConfig.GEMINI_MODELS,
      openai: modelsConfig.OPENAI_MODELS,
      grok: modelsConfig.GROK_MODELS,
      other: modelsConfig.OTHER_MODELS,
      all: modelsConfig.getAllModels(),
      platforms: modelsConfig.PLATFORM_TEST_MODELS,
      defaultModels,
    }
  }),
)

// 重定向页面请求到新版 admin-spa
router.get('/', (req, res) => {
  res.redirect(301, '/admin-next/api-stats')
})

// 获取 API Key 对应的 ID
router.post(
  '/api/get-key-id',
  asyncRoute('Failed to retrieve API key ID', async (req) => {
    const { apiKey } = parseObjectBody(req.body, 'API Key 查询')

    if (!apiKey) {
      throw badRequest('Please provide your API Key')
    }

    // 基本API Key格式验证
    if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 512) {
      throw badRequest('API key format is invalid')
    }

    // 验证API Key（使用不触发激活的验证方法）
    const validation = await apiKeyService.validateApiKeyForStats(apiKey)

    if (!validation.valid) {
      const clientIP = req.ip || req.connection?.remoteAddress || 'unknown'
      logger.security(`Invalid API key in get-key-id: ${validation.error} from ${clientIP}`)
      throw unauthorized(validation.error || 'Invalid API key')
    }

    const { keyData } = validation

    return {
      id: keyData.id,
    }
  }),
)

// 用户API Key统计查询接口 - 安全的自查询接口
router.post(
  '/api/user-stats',
  asyncRoute('Failed to retrieve API key statistics', async (req) => {
    const { apiKey, apiId } = parseObjectBody(req.body, '用户统计')

    let keyData
    let keyId

    if (apiId) {
      // 通过 apiId 查询
      if (
        typeof apiId !== 'string' ||
        !apiId.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)
      ) {
        throw badRequest('API ID must be a valid UUID')
      }

      // 直接通过 ID 获取 API Key 数据
      keyData = await redis.getApiKey(apiId)

      if (!keyData || Object.keys(keyData).length === 0) {
        logger.security(`API key not found for ID: ${apiId} from ${req.ip || 'unknown'}`)
        throw notFound('The specified API key does not exist')
      }

      // 检查是否激活
      if (keyData.isActive !== 'true') {
        const keyName = keyData.name || 'Unknown'
        throw forbidden(`API Key "${keyName}" 已被禁用`, { data: { keyName } })
      }

      // 检查是否过期
      if (keyData.expiresAt && new Date() > new Date(keyData.expiresAt)) {
        const keyName = keyData.name || 'Unknown'
        throw forbidden(`API Key "${keyName}" 已过期`, { data: { keyName } })
      }

      keyId = apiId

      // 获取使用统计
      const usage = await redis.getUsageStats(keyId)

      // 获取当日费用统计
      const dailyCost = await redis.getDailyCost(keyId)
      const costStats = await redis.getCostStats(keyId)

      // 处理数据格式，与 validateApiKey 返回的格式保持一致
      // 解析限制模型数据
      let restrictedModels
      try {
        restrictedModels = keyData.restrictedModels ? JSON.parse(keyData.restrictedModels) : []
      } catch (e) {
        restrictedModels = []
      }

      // 解析允许的客户端数据
      let allowedClients
      try {
        allowedClients = keyData.allowedClients ? JSON.parse(keyData.allowedClients) : []
      } catch (e) {
        allowedClients = []
      }

      // 格式化 keyData
      keyData = {
        ...keyData,
        tokenLimit: parseInt(keyData.tokenLimit) || 0,
        concurrencyLimit: parseInt(keyData.concurrencyLimit) || 0,
        rateLimitWindow: parseInt(keyData.rateLimitWindow) || 0,
        rateLimitRequests: parseInt(keyData.rateLimitRequests) || 0,
        dailyCostLimit: parseFloat(keyData.dailyCostLimit) || 0,
        totalCostLimit: parseFloat(keyData.totalCostLimit) || 0,
        dailyCost: dailyCost || 0,
        totalCost: costStats.total || 0,
        enableModelRestriction: keyData.enableModelRestriction === 'true',
        restrictedModels,
        enableClientRestriction: keyData.enableClientRestriction === 'true',
        allowedClients,
        permissions: keyData.permissions,
        // 添加激活相关字段
        expirationMode: keyData.expirationMode || 'fixed',
        isActivated: keyData.isActivated === 'true',
        activationDays: parseInt(keyData.activationDays || 0),
        activatedAt: keyData.activatedAt || null,
        usage, // 使用完整的 usage 数据，而不是只有 total
      }
    } else if (apiKey) {
      // 通过 apiKey 查询（保持向后兼容）
      if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 512) {
        logger.security(`Invalid API key format in user stats query from ${req.ip || 'unknown'}`)
        throw badRequest('API key format is invalid')
      }

      // 验证API Key（使用不触发激活的验证方法）
      const validation = await apiKeyService.validateApiKeyForStats(apiKey)

      if (!validation.valid) {
        const clientIP = req.ip || req.connection?.remoteAddress || 'unknown'
        logger.security(`Invalid API key in user stats query: ${validation.error} from ${clientIP}`)
        throw unauthorized(validation.error || 'Invalid API key')
      }

      const { keyData: validatedKeyData } = validation
      keyData = validatedKeyData
      keyId = keyData.id
    } else {
      logger.security(`Missing API key or ID in user stats query from ${req.ip || 'unknown'}`)
      throw badRequest('Please provide your API Key or API ID')
    }

    // 记录合法查询
    logger.api(`User stats query from key: ${keyData.name} (${keyId}) from ${req.ip || 'unknown'}`)

    // 获取验证结果中的完整keyData（包含isActive状态和cost信息）
    const fullKeyData = keyData

    // 使用 allTimeCost 而不是扫描月度键
    // 计算总费用 - 优先使用持久化的总费用计数器
    let totalCost = 0
    let formattedCost = '$0.000000'

    try {
      const client = redis.getClientSafe()

      // 读取累积的总费用（没有 TTL 的持久键）
      const totalCostKey = RedisKeys.usage.costTotal(keyId)
      const allTimeCost = parseFloat((await client.get(totalCostKey)) || '0')

      if (allTimeCost > 0) {
        totalCost = allTimeCost
        formattedCost = CostCalculator.formatCost(allTimeCost)
        logger.debug(`使用 allTimeCost 计算用户统计: ${allTimeCost}`)
      } else {
        // Fallback: 如果 allTimeCost 为空（旧键），尝试月度键
        const allModelResults = await redis.scanAndGetAllChunked(`usage:${keyId}:model:monthly:*:*`)
        const modelUsageMap = new Map()

        for (const { key, data } of allModelResults) {
          const modelMatch = key.match(/usage:.+:model:monthly:(.+):(\d{4}-\d{2})$/)
          if (!modelMatch) {
            continue
          }

          const model = modelMatch[1]

          if (data && Object.keys(data).length > 0) {
            if (!modelUsageMap.has(model)) {
              modelUsageMap.set(model, {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreateTokens: 0,
                cacheReadTokens: 0,
                ephemeral5mTokens: 0,
                ephemeral1hTokens: 0,
                realCostMicro: 0,
                ratedCostMicro: 0,
                costedRequests: 0,
                costedInputTokens: 0,
                costedOutputTokens: 0,
                costedCacheCreateTokens: 0,
                costedCacheReadTokens: 0,
                costedEphemeral5mTokens: 0,
                costedEphemeral1hTokens: 0,
                requests: 0,
              })
            }

            const modelUsage = modelUsageMap.get(model)
            modelUsage.inputTokens += parseInt(data.inputTokens) || 0
            modelUsage.outputTokens += parseInt(data.outputTokens) || 0
            modelUsage.cacheCreateTokens += parseInt(data.cacheCreateTokens) || 0
            modelUsage.cacheReadTokens += parseInt(data.cacheReadTokens) || 0
            modelUsage.ephemeral5mTokens += parseInt(data.ephemeral5mTokens) || 0
            modelUsage.ephemeral1hTokens += parseInt(data.ephemeral1hTokens) || 0
            modelUsage.requests += parseInt(data.requests) || 0
            modelUsage.realCostMicro += parseInt(data.realCostMicro) || 0
            modelUsage.ratedCostMicro += parseInt(data.ratedCostMicro) || 0
            modelUsage.costedRequests += parseInt(data.costedRequests) || 0
            modelUsage.costedInputTokens += parseInt(data.costedInputTokens) || 0
            modelUsage.costedOutputTokens += parseInt(data.costedOutputTokens) || 0
            modelUsage.costedCacheCreateTokens += parseInt(data.costedCacheCreateTokens) || 0
            modelUsage.costedCacheReadTokens += parseInt(data.costedCacheReadTokens) || 0
            modelUsage.costedEphemeral5mTokens += parseInt(data.costedEphemeral5mTokens) || 0
            modelUsage.costedEphemeral1hTokens += parseInt(data.costedEphemeral1hTokens) || 0
          }
        }

        // 按模型计算费用并汇总（混合桶：已结算 micro + 未结算 token）
        for (const [model, usage] of modelUsageMap) {
          const resolved = CostCalculator.resolveModelStatsCost(usage, model)
          totalCost += resolved.rated
        }

        // 如果没有模型级别的详细数据，回退到总体数据计算
        if (modelUsageMap.size === 0 && fullKeyData.usage?.total?.allTokens > 0) {
          const usage = fullKeyData.usage.total
          const costUsage = {
            input_tokens: usage.inputTokens || 0,
            output_tokens: usage.outputTokens || 0,
            cache_creation_input_tokens: usage.cacheCreateTokens || 0,
            cache_read_input_tokens: usage.cacheReadTokens || 0,
          }

          // 如果有 ephemeral 5m/1h 拆分数据，添加 cache_creation 子对象以实现精确计费
          if (usage.ephemeral5mTokens > 0 || usage.ephemeral1hTokens > 0) {
            costUsage.cache_creation = {
              ephemeral_5m_input_tokens: usage.ephemeral5mTokens,
              ephemeral_1h_input_tokens: usage.ephemeral1hTokens,
            }
          }

          const costResult = CostCalculator.calculateCost(costUsage, 'claude-3-5-sonnet-20241022')
          totalCost = costResult.costs.total
        }

        formattedCost = CostCalculator.formatCost(totalCost)
      }
    } catch (error) {
      logger.warn(`Failed to calculate cost for key ${keyId}:`, error)
      // 回退到简单计算
      if (fullKeyData.usage?.total?.allTokens > 0) {
        const usage = fullKeyData.usage.total
        const costUsage = {
          input_tokens: usage.inputTokens || 0,
          output_tokens: usage.outputTokens || 0,
          cache_creation_input_tokens: usage.cacheCreateTokens || 0,
          cache_read_input_tokens: usage.cacheReadTokens || 0,
        }

        // 如果有 ephemeral 5m/1h 拆分数据，添加 cache_creation 子对象以实现精确计费
        if (usage.ephemeral5mTokens > 0 || usage.ephemeral1hTokens > 0) {
          costUsage.cache_creation = {
            ephemeral_5m_input_tokens: usage.ephemeral5mTokens,
            ephemeral_1h_input_tokens: usage.ephemeral1hTokens,
          }
        }

        const costResult = CostCalculator.calculateCost(costUsage, 'claude-3-5-sonnet-20241022')
        totalCost = costResult.costs.total
        formattedCost = costResult.formatted.total
      }
    }

    // 获取当前使用量
    let currentWindowRequests = 0
    let currentWindowTokens = 0
    let currentWindowCost = 0 // 新增：当前窗口费用
    let currentDailyCost = 0
    let windowStartTime = null
    let windowEndTime = null
    let windowRemainingSeconds = null

    try {
      // 获取当前时间窗口的请求次数、Token使用量和费用
      if (fullKeyData.rateLimitWindow > 0) {
        const client = redis.getClientSafe()
        const requestCountKey = RedisKeys.rateLimit.requests(keyId)
        const tokenCountKey = RedisKeys.rateLimit.tokens(keyId)
        const costCountKey = RedisKeys.rateLimit.cost(keyId) // 新增：费用计数key
        const windowStartKey = RedisKeys.rateLimit.windowStart(keyId)

        currentWindowRequests = parseInt((await client.get(requestCountKey)) || '0')
        currentWindowTokens = parseInt((await client.get(tokenCountKey)) || '0')
        currentWindowCost = parseFloat((await client.get(costCountKey)) || '0') // 新增：获取当前窗口费用

        // 获取窗口开始时间和计算剩余时间
        const windowStart = await client.get(windowStartKey)
        if (windowStart) {
          const now = Date.now()
          windowStartTime = parseInt(windowStart)
          const windowDuration = TTL.rateLimitWindowMs(fullKeyData.rateLimitWindow) // 转换为毫秒
          windowEndTime = windowStartTime + windowDuration

          // 如果窗口还有效
          if (now < windowEndTime) {
            windowRemainingSeconds = Math.max(0, Math.floor((windowEndTime - now) / 1000))
          } else {
            // 窗口已过期，下次请求会重置
            windowStartTime = null
            windowEndTime = null
            windowRemainingSeconds = 0
            // 窗口已过期，重置计数为 0
            currentWindowRequests = 0
            currentWindowTokens = 0
            currentWindowCost = 0 // 新增：重置窗口费用
          }
        }
      }

      // 获取当日费用
      currentDailyCost = (await redis.getDailyCost(keyId)) || 0
    } catch (error) {
      logger.warn(`Failed to get current usage for key ${keyId}:`, error)
    }

    const boundAccountDetails = {}

    const accountDetailTasks = []

    if (fullKeyData.claudeAccountId) {
      accountDetailTasks.push(
        (async () => {
          try {
            const overview = await claudeAccountService.getAccountOverview(fullKeyData.claudeAccountId)

            if (overview && overview.accountType === 'dedicated') {
              boundAccountDetails.claude = overview
            }
          } catch (error) {
            logger.warn(`Failed to load Claude account overview for key ${keyId}:`, error)
          }
        })(),
      )
    }

    if (fullKeyData.openaiAccountId) {
      accountDetailTasks.push(
        (async () => {
          try {
            const overview = await openaiAccountService.getAccountOverview(fullKeyData.openaiAccountId)

            if (overview && overview.accountType === 'dedicated') {
              boundAccountDetails.openai = overview
            }
          } catch (error) {
            logger.warn(`Failed to load OpenAI account overview for key ${keyId}:`, error)
          }
        })(),
      )
    }

    if (accountDetailTasks.length > 0) {
      await Promise.allSettled(accountDetailTasks)
    }

    // 构建响应数据（只返回该API Key自己的信息，确保不泄露其他信息）
    return {
      id: keyId,
      name: fullKeyData.name,
      description: fullKeyData.description || keyData.description || '',
      isActive: true, // 如果能通过validateApiKey验证，说明一定是激活的
      createdAt: fullKeyData.createdAt || keyData.createdAt,
      expiresAt: fullKeyData.expiresAt || keyData.expiresAt,
      // 添加激活相关字段
      expirationMode: fullKeyData.expirationMode || 'fixed',
      isActivated: fullKeyData.isActivated === true || fullKeyData.isActivated === 'true',
      activationDays: parseInt(fullKeyData.activationDays || 0),
      activatedAt: fullKeyData.activatedAt || null,
      permissions: fullKeyData.permissions,

      // 使用统计（使用验证结果中的完整数据）
      usage: {
        total: {
          ...(fullKeyData.usage?.total || {
            requests: 0,
            tokens: 0,
            allTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
          }),
          cost: totalCost,
          formattedCost,
        },
      },

      // 限制信息（显示配置和当前使用量）
      limits: {
        tokenLimit: fullKeyData.tokenLimit || 0,
        concurrencyLimit: fullKeyData.concurrencyLimit || 0,
        rateLimitWindow: fullKeyData.rateLimitWindow || 0,
        rateLimitRequests: fullKeyData.rateLimitRequests || 0,
        rateLimitCost: parseFloat(fullKeyData.rateLimitCost) || 0, // 新增：费用限制
        dailyCostLimit: fullKeyData.dailyCostLimit || 0,
        totalCostLimit: fullKeyData.totalCostLimit || 0,
        weeklyOpusCostLimit: parseFloat(fullKeyData.weeklyOpusCostLimit) || 0, // Opus 周费用限制
        weeklyResetDay: parseInt(fullKeyData.weeklyResetDay) || 1, // 周费用重置日 (1-7)
        weeklyResetHour: parseInt(fullKeyData.weeklyResetHour) || 0, // 周费用重置时 (0-23)
        // 当前使用量
        currentWindowRequests,
        currentWindowTokens,
        currentWindowCost, // 新增：当前窗口费用
        currentDailyCost,
        currentTotalCost: totalCost,
        weeklyOpusCost:
          (await redis.getWeeklyOpusCost(
            keyId,
            parseInt(fullKeyData.weeklyResetDay) || 1,
            parseInt(fullKeyData.weeklyResetHour) || 0,
          )) || 0, // 当前 Opus 周费用
        // 时间窗口信息
        windowStartTime,
        windowEndTime,
        windowRemainingSeconds,
      },

      // 绑定的账户信息（只显示ID，不显示敏感信息）
      accounts: {
        claudeAccountId:
          fullKeyData.claudeAccountId && fullKeyData.claudeAccountId !== '' ? fullKeyData.claudeAccountId : null,
        geminiAccountId:
          fullKeyData.geminiAccountId && fullKeyData.geminiAccountId !== '' ? fullKeyData.geminiAccountId : null,
        openaiAccountId:
          fullKeyData.openaiAccountId && fullKeyData.openaiAccountId !== '' ? fullKeyData.openaiAccountId : null,
        details: Object.keys(boundAccountDetails).length > 0 ? boundAccountDetails : null,
      },

      // 模型和客户端限制信息
      restrictions: {
        enableModelRestriction: fullKeyData.enableModelRestriction || false,
        restrictedModels: fullKeyData.restrictedModels || [],
        enableClientRestriction: fullKeyData.enableClientRestriction || false,
        allowedClients: fullKeyData.allowedClients || [],
      },

      // Key 级别的服务倍率
      serviceRates: (() => {
        try {
          return fullKeyData.serviceRates
            ? typeof fullKeyData.serviceRates === 'string'
              ? JSON.parse(fullKeyData.serviceRates)
              : fullKeyData.serviceRates
            : {}
        } catch (e) {
          return {}
        }
      })(),
    }
  }),
)

router.get(
  '/api/user-usage-records',
  asyncRoute('Failed to retrieve API key usage records', async (req) => {
    const { apiId, page = 1, pageSize = 50, startDate, endDate, model, sortOrder = 'desc' } = req.query

    if (typeof apiId !== 'string' || !apiId.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)) {
      throw badRequest('API ID must be a valid UUID')
    }

    const pageNumber = Math.max(parseInt(page, 10) || 1, 1)
    const pageSizeNumber = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200)
    const normalizedSortOrder = sortOrder === 'asc' ? 'asc' : 'desc'

    const startTime = parseDateTimeQuery(startDate)
    const endTime = parseDateTimeQuery(endDate)

    if ((startDate && Number.isNaN(startTime?.getTime())) || (endDate && Number.isNaN(endTime?.getTime()))) {
      throw badRequest('Invalid date range')
    }

    if (startTime && endTime && startTime > endTime) {
      throw badRequest('Start date must be before or equal to end date')
    }

    const keyData = await redis.getApiKey(apiId)
    if (!keyData || Object.keys(keyData).length === 0) {
      throw notFound('The specified API key does not exist')
    }

    if (keyData.isActive !== 'true') {
      throw forbidden(`API Key "${keyData.name || 'Unknown'}" 已被禁用`)
    }

    if (keyData.expiresAt && new Date() > new Date(keyData.expiresAt)) {
      throw forbidden(`API Key "${keyData.name || 'Unknown'}" 已过期`)
    }

    const rawRecords = await redis.getUsageRecords(apiId, 5000)

    const toUsageObject = (record) => {
      const usage = {
        input_tokens: record.inputTokens || 0,
        output_tokens: record.outputTokens || 0,
        cache_creation_input_tokens: record.cacheCreateTokens || 0,
        cache_read_input_tokens: record.cacheReadTokens || 0,
        cache_creation: record.cacheCreation || record.cache_creation || null,
      }

      if (!usage.cache_creation) {
        const eph5m = parseInt(record.ephemeral5mTokens) || 0
        const eph1h = parseInt(record.ephemeral1hTokens) || 0
        if (eph5m > 0 || eph1h > 0) {
          usage.cache_creation = {
            ephemeral_5m_input_tokens: eph5m,
            ephemeral_1h_input_tokens: eph1h,
          }
        }
      }

      return usage
    }

    const withinRange = (record) => {
      if (!record.timestamp) {
        return false
      }

      const ts = new Date(record.timestamp)
      if (Number.isNaN(ts.getTime())) {
        return false
      }

      if (startTime && ts < startTime) {
        return false
      }
      if (endTime && ts > endTime) {
        return false
      }

      return true
    }

    const filteredRecords = rawRecords.filter((record) => {
      if (!withinRange(record)) {
        return false
      }
      if (model && record.model !== model) {
        return false
      }
      return true
    })

    filteredRecords.sort((a, b) => {
      const aTime = new Date(a.timestamp).getTime()
      const bTime = new Date(b.timestamp).getTime()
      if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
        return 0
      }
      return normalizedSortOrder === 'asc' ? aTime - bTime : bTime - aTime
    })

    const summary = {
      totalRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    }

    const modelSet = new Set()
    let earliestTimestamp = null
    let latestTimestamp = null

    for (const record of filteredRecords) {
      const usage = toUsageObject(record)
      const costData = CostCalculator.calculateCost(usage, record.model || 'unknown')
      const computedCost = typeof record.cost === 'number' ? record.cost : costData?.costs?.total || 0
      const totalTokens =
        record.totalTokens ||
        usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens

      summary.totalRequests += 1
      summary.inputTokens += usage.input_tokens
      summary.outputTokens += usage.output_tokens
      summary.cacheCreateTokens += usage.cache_creation_input_tokens
      summary.cacheReadTokens += usage.cache_read_input_tokens
      summary.totalTokens += totalTokens
      summary.totalCost += computedCost

      if (record.model) {
        modelSet.add(record.model)
      }

      if (record.timestamp) {
        const ts = new Date(record.timestamp)
        if (!Number.isNaN(ts.getTime())) {
          if (!earliestTimestamp || ts < earliestTimestamp) {
            earliestTimestamp = ts
          }
          if (!latestTimestamp || ts > latestTimestamp) {
            latestTimestamp = ts
          }
        }
      }
    }

    const totalRecords = filteredRecords.length
    const totalPages = totalRecords > 0 ? Math.ceil(totalRecords / pageSizeNumber) : 0
    const safePage = totalPages > 0 ? Math.min(pageNumber, totalPages) : 1
    const startIndex = (safePage - 1) * pageSizeNumber
    const pageRecords = totalRecords === 0 ? [] : filteredRecords.slice(startIndex, startIndex + pageSizeNumber)

    const records = pageRecords.map((record) => {
      const usage = toUsageObject(record)
      const costData = CostCalculator.calculateCost(usage, record.model || 'unknown')
      const computedCost = typeof record.cost === 'number' ? record.cost : costData?.costs?.total || 0
      const realCost = typeof record.realCost === 'number' ? record.realCost : costData?.costs?.total || 0
      const totalTokens =
        record.totalTokens ||
        usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
      const accountType = record.accountType || 'unknown'

      return {
        timestamp: record.timestamp,
        model: record.model || 'unknown',
        accountType,
        accountTypeName: accountTypeNames[accountType] || '未知渠道',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheCreateTokens: usage.cache_creation_input_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        ephemeral5mTokens: record.ephemeral5mTokens || 0,
        ephemeral1hTokens: record.ephemeral1hTokens || 0,
        totalTokens,
        isLongContextRequest: record.isLongContext || record.isLongContextRequest || false,
        cost: Number(computedCost.toFixed(6)),
        costFormatted: CostCalculator.formatCost(computedCost),
        realCost: Number(realCost.toFixed(6)),
        realCostFormatted: CostCalculator.formatCost(realCost),
        costBreakdown: record.realCostBreakdown ||
          record.costBreakdown || {
            input: costData?.costs?.input || 0,
            output: costData?.costs?.output || 0,
            cacheCreate: costData?.costs?.cacheWrite || 0,
            cacheRead: costData?.costs?.cacheRead || 0,
            total: costData?.costs?.total || computedCost,
          },
        responseTime: record.responseTime || null,
      }
    })

    return {
      records,
      pagination: {
        currentPage: safePage,
        pageSize: pageSizeNumber,
        totalRecords,
        totalPages,
        hasNextPage: totalPages > 0 && safePage < totalPages,
        hasPreviousPage: totalPages > 0 && safePage > 1,
      },
      filters: {
        startDate: startDate || null,
        endDate: endDate || null,
        model: model || null,
        accountId: null,
        sortOrder: normalizedSortOrder,
      },
      apiKeyInfo: {
        id: apiId,
        name: keyData.name || keyData.label || apiId,
      },
      summary: {
        ...summary,
        totalCost: Number(summary.totalCost.toFixed(6)),
        avgCost: summary.totalRequests > 0 ? Number((summary.totalCost / summary.totalRequests).toFixed(6)) : 0,
      },
      availableFilters: {
        models: Array.from(modelSet),
        accounts: [],
        dateRange: {
          earliest: earliestTimestamp ? earliestTimestamp.toISOString() : null,
          latest: latestTimestamp ? latestTimestamp.toISOString() : null,
        },
      },
    }
  }),
)

// 批量查询统计数据接口
router.post(
  '/api/batch-stats',
  asyncRoute('Failed to retrieve batch statistics', async (req) => {
    const { apiIds } = parseObjectBody(req.body, '批量统计')

    // 验证输入
    if (!apiIds || !Array.isArray(apiIds) || apiIds.length === 0) {
      throw badRequest('API IDs array is required')
    }

    // 限制最多查询 30 个
    if (apiIds.length > 30) {
      throw badRequest('Maximum 30 API keys can be queried at once')
    }

    // 验证所有 ID 格式
    const uuidRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
    const invalidIds = apiIds.filter((id) => !uuidRegex.test(id))
    if (invalidIds.length > 0) {
      throw badRequest(`Invalid API IDs: ${invalidIds.join(', ')}`)
    }

    const individualStats = []
    const aggregated = {
      totalKeys: apiIds.length,
      activeKeys: 0,
      usage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        allTokens: 0,
        cost: 0,
        formattedCost: '$0.000000',
      },
      dailyUsage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        allTokens: 0,
        cost: 0,
        formattedCost: '$0.000000',
      },
      monthlyUsage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        allTokens: 0,
        cost: 0,
        formattedCost: '$0.000000',
      },
    }

    // 并行查询所有 API Key 数据（复用单key查询逻辑）
    const results = await Promise.allSettled(
      apiIds.map(async (apiId) => {
        const keyData = await redis.getApiKey(apiId)

        if (!keyData || Object.keys(keyData).length === 0) {
          return { error: 'Not found', apiId }
        }

        // 检查是否激活
        if (keyData.isActive !== 'true') {
          return { error: 'Disabled', apiId }
        }

        // 检查是否过期
        if (keyData.expiresAt && new Date() > new Date(keyData.expiresAt)) {
          return { error: 'Expired', apiId }
        }

        // 复用单key查询的逻辑：获取使用统计
        const usage = await redis.getUsageStats(apiId)

        // 获取费用统计（与单key查询一致）
        const costStats = await redis.getCostStats(apiId)

        return {
          apiId,
          name: keyData.name,
          description: keyData.description || '',
          isActive: true,
          createdAt: keyData.createdAt,
          usage: usage.total || {},
          dailyStats: {
            ...usage.daily,
            cost: costStats.daily,
          },
          monthlyStats: {
            ...usage.monthly,
            cost: costStats.monthly,
          },
          totalCost: costStats.total,
          serviceRates: (() => {
            try {
              return keyData.serviceRates
                ? typeof keyData.serviceRates === 'string'
                  ? JSON.parse(keyData.serviceRates)
                  : keyData.serviceRates
                : {}
            } catch (e) {
              return {}
            }
          })(),
        }
      }),
    )

    // 处理结果并聚合
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value && !result.value.error) {
        const stats = result.value
        aggregated.activeKeys++

        // 聚合总使用量
        if (stats.usage) {
          aggregated.usage.requests += stats.usage.requests || 0
          aggregated.usage.inputTokens += stats.usage.inputTokens || 0
          aggregated.usage.outputTokens += stats.usage.outputTokens || 0
          aggregated.usage.cacheCreateTokens += stats.usage.cacheCreateTokens || 0
          aggregated.usage.cacheReadTokens += stats.usage.cacheReadTokens || 0
          aggregated.usage.allTokens += stats.usage.allTokens || 0
        }

        // 聚合总费用
        aggregated.usage.cost += stats.totalCost || 0

        // 聚合今日使用量
        aggregated.dailyUsage.requests += stats.dailyStats.requests || 0
        aggregated.dailyUsage.inputTokens += stats.dailyStats.inputTokens || 0
        aggregated.dailyUsage.outputTokens += stats.dailyStats.outputTokens || 0
        aggregated.dailyUsage.cacheCreateTokens += stats.dailyStats.cacheCreateTokens || 0
        aggregated.dailyUsage.cacheReadTokens += stats.dailyStats.cacheReadTokens || 0
        aggregated.dailyUsage.allTokens += stats.dailyStats.allTokens || 0
        aggregated.dailyUsage.cost += stats.dailyStats.cost || 0

        // 聚合本月使用量
        aggregated.monthlyUsage.requests += stats.monthlyStats.requests || 0
        aggregated.monthlyUsage.inputTokens += stats.monthlyStats.inputTokens || 0
        aggregated.monthlyUsage.outputTokens += stats.monthlyStats.outputTokens || 0
        aggregated.monthlyUsage.cacheCreateTokens += stats.monthlyStats.cacheCreateTokens || 0
        aggregated.monthlyUsage.cacheReadTokens += stats.monthlyStats.cacheReadTokens || 0
        aggregated.monthlyUsage.allTokens += stats.monthlyStats.allTokens || 0
        aggregated.monthlyUsage.cost += stats.monthlyStats.cost || 0

        // 添加到个体统计
        individualStats.push({
          apiId: stats.apiId,
          name: stats.name,
          isActive: true,
          usage: stats.usage,
          dailyUsage: {
            ...stats.dailyStats,
            formattedCost: CostCalculator.formatCost(stats.dailyStats.cost || 0),
          },
          monthlyUsage: {
            ...stats.monthlyStats,
            formattedCost: CostCalculator.formatCost(stats.monthlyStats.cost || 0),
          },
        })
      }
    })

    // 格式化费用显示
    aggregated.usage.formattedCost = CostCalculator.formatCost(aggregated.usage.cost)
    aggregated.dailyUsage.formattedCost = CostCalculator.formatCost(aggregated.dailyUsage.cost)
    aggregated.monthlyUsage.formattedCost = CostCalculator.formatCost(aggregated.monthlyUsage.cost)

    logger.api(`Batch stats query for ${apiIds.length} keys from ${req.ip || 'unknown'}`)

    return {
      aggregated,
      individual: individualStats,
    }
  }),
)

// 批量模型统计查询接口
router.post(
  '/api/batch-model-stats',
  asyncRoute('Failed to retrieve batch model statistics', async (req) => {
    const { apiIds, period = 'daily' } = parseObjectBody(req.body, '批量模型统计')

    // 验证输入
    if (!apiIds || !Array.isArray(apiIds) || apiIds.length === 0) {
      throw badRequest('API IDs array is required')
    }

    // 限制最多查询 30 个
    if (apiIds.length > 30) {
      throw badRequest('Maximum 30 API keys can be queried at once')
    }

    const _client = redis.getClientSafe()
    const tzDate = redis.getDateInTimezone()
    const today = redis.getDateStringInTimezone()
    const currentMonth = `${tzDate.getFullYear()}-${String(tzDate.getMonth() + 1).padStart(2, '0')}`

    const modelUsageMap = new Map()

    // 并行查询所有 API Key 的模型统计
    await Promise.all(
      apiIds.map(async (apiId) => {
        const pattern =
          period === 'daily'
            ? `usage:${apiId}:model:daily:*:${today}`
            : `usage:${apiId}:model:monthly:*:${currentMonth}`

        const results = await redis.scanAndGetAllChunked(pattern)

        for (const { key, data } of results) {
          const match = key.match(
            period === 'daily'
              ? /usage:.+:model:daily:(.+):\d{4}-\d{2}-\d{2}$/
              : /usage:.+:model:monthly:(.+):\d{4}-\d{2}$/,
          )

          if (!match) {
            continue
          }

          const model = match[1]

          if (data && Object.keys(data).length > 0) {
            if (!modelUsageMap.has(model)) {
              modelUsageMap.set(model, {
                requests: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreateTokens: 0,
                cacheReadTokens: 0,
                thinkingTokens: 0,
                ephemeral5mTokens: 0,
                ephemeral1hTokens: 0,
                allTokens: 0,
                realCostMicro: 0,
                ratedCostMicro: 0,
                costedRequests: 0,
                costedInputTokens: 0,
                costedOutputTokens: 0,
                costedCacheCreateTokens: 0,
                costedCacheReadTokens: 0,
                costedEphemeral5mTokens: 0,
                costedEphemeral1hTokens: 0,
              })
            }

            const modelUsage = modelUsageMap.get(model)
            modelUsage.requests += parseInt(data.requests) || 0
            modelUsage.inputTokens += parseInt(data.inputTokens) || 0
            modelUsage.outputTokens += parseInt(data.outputTokens) || 0
            modelUsage.cacheCreateTokens += parseInt(data.cacheCreateTokens) || 0
            modelUsage.cacheReadTokens += parseInt(data.cacheReadTokens) || 0
            modelUsage.thinkingTokens += parseInt(data.thinkingTokens) || 0
            modelUsage.ephemeral5mTokens += parseInt(data.ephemeral5mTokens) || 0
            modelUsage.ephemeral1hTokens += parseInt(data.ephemeral1hTokens) || 0
            modelUsage.allTokens += parseInt(data.allTokens) || 0
            modelUsage.realCostMicro += parseInt(data.realCostMicro) || 0
            modelUsage.ratedCostMicro += parseInt(data.ratedCostMicro) || 0
            modelUsage.costedRequests += parseInt(data.costedRequests) || 0
            modelUsage.costedInputTokens += parseInt(data.costedInputTokens) || 0
            modelUsage.costedOutputTokens += parseInt(data.costedOutputTokens) || 0
            modelUsage.costedCacheCreateTokens += parseInt(data.costedCacheCreateTokens) || 0
            modelUsage.costedCacheReadTokens += parseInt(data.costedCacheReadTokens) || 0
            modelUsage.costedEphemeral5mTokens += parseInt(data.costedEphemeral5mTokens) || 0
            modelUsage.costedEphemeral1hTokens += parseInt(data.costedEphemeral1hTokens) || 0
          }
        }
      }),
    )

    // 转换为数组并处理费用（混合桶）
    const modelStats = []
    for (const [model, usage] of modelUsageMap) {
      const resolved = CostCalculator.resolveModelStatsCost(usage, model)
      modelStats.push({
        model,
        requests: usage.requests,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreateTokens: usage.cacheCreateTokens,
        cacheReadTokens: usage.cacheReadTokens,
        thinkingTokens: usage.thinkingTokens || 0,
        allTokens: usage.allTokens,
        costs: resolved.costs,
        formatted: resolved.formatted,
        pricing: resolved.pricing,
        isLegacy: resolved.source === 'recalculated',
        costSource: resolved.source,
      })
    }

    // 按总 token 数降序排列
    modelStats.sort((a, b) => b.allTokens - a.allTokens)

    logger.api(`Batch model stats query for ${apiIds.length} keys, period: ${period}`)

    return modelStats
  }),
)

// maxTokens 白名单
const ALLOWED_MAX_TOKENS = [100, 500, 1000, 2000, 4096]
const sanitizeMaxTokens = (value) => (ALLOWED_MAX_TOKENS.includes(Number(value)) ? Number(value) : 1000)

// API Key 端点测试接口 - 测试API Key是否能正常访问服务
router.post(
  '/api-key/test',
  asyncRoute('API Key test failed', async (req, res) => {
    const body = parseObjectBody(req.body, 'Claude 连通测试')
    const { apiKey, prompt = 'hi' } = body
    const model = await testModelConfigService.resolveApikeyModel('claude', body.model)
    const maxTokens = sanitizeMaxTokens(body.maxTokens)

    if (!apiKey) {
      throw badRequest('Please provide your API Key')
    }

    if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 512) {
      throw badRequest('API key format is invalid')
    }

    const validation = await apiKeyService.validateApiKeyForStats(apiKey)
    if (!validation.valid) {
      throw unauthorized(validation.error || 'Invalid API key')
    }

    logger.api(`API Key test started for: ${validation.keyData.name} (${validation.keyData.id})`)

    const port = config.server.port || 3000
    const apiUrl = `http://127.0.0.1:${port}/api/v1/messages?beta=true`

    try {
      await sendStreamTestRequest({
        apiUrl,
        authorization: apiKey,
        responseStream: res,
        payload: createClaudeTestPayload(model, { stream: true, prompt, maxTokens }),
        timeout: 60000,
        extraHeaders: {
          'x-api-key': apiKey,
          'x-app': 'claude-code',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
        },
        sanitize: false,
      })
    } catch (error) {
      logger.error('API Key test failed:', error)
      const errorMsg = error.message || 'An unexpected error occurred'
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: errorMsg })}\n\n`)
        res.end()
        return SEND_RAW
      }
      throw error
    }

    return SEND_RAW
  }),
)

// Gemini API Key 端点测试接口
router.post(
  '/api-key/test-gemini',
  asyncRoute('Gemini API Key test failed', async (req, res) => {
    const body = parseObjectBody(req.body, 'Gemini 连通测试')
    const { apiKey, prompt = 'hi' } = body
    const model = await testModelConfigService.resolveApikeyModel('gemini', body.model)
    const maxTokens = sanitizeMaxTokens(body.maxTokens)

    if (!apiKey) {
      throw badRequest('Please provide your API Key')
    }

    if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 512) {
      throw badRequest('API key format is invalid')
    }

    const validation = await apiKeyService.validateApiKeyForStats(apiKey)
    if (!validation.valid) {
      throw unauthorized(validation.error || 'Invalid API key')
    }

    // 检查 Gemini 权限
    if (!apiKeyService.hasPermission(validation.keyData.permissions, 'gemini')) {
      throw forbidden('This API key does not have Gemini permission')
    }

    logger.api(`Gemini API Key test started for: ${validation.keyData.name} (${validation.keyData.id})`)

    const port = config.server.port || 3000
    const apiUrl = `http://127.0.0.1:${port}/gemini/v1/models/${model}:streamGenerateContent?alt=sse`

    // 设置 SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    res.write(`data: ${JSON.stringify({ type: 'test_start', message: 'Test started' })}\n\n`)

    const payload = createGeminiTestPayload(model, { prompt, maxTokens })

    try {
      const response = await axios.post(apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        timeout: 60000,
        responseType: 'stream',
        validateStatus: () => true,
      })

      if (response.status !== 200) {
        const chunks = []
        response.data.on('data', (chunk) => chunks.push(chunk))
        response.data.on('end', () => {
          const errorData = Buffer.concat(chunks).toString()
          let errorMsg = `API Error: ${response.status}`
          try {
            const json = JSON.parse(errorData)
            errorMsg = extractErrorMessage(json, errorMsg)
          } catch {
            if (errorData.length < 200) {
              errorMsg = errorData || errorMsg
            }
          }
          res.write(
            `data: ${JSON.stringify({ type: 'test_complete', success: false, error: sanitizeErrorMsg(errorMsg) })}\n\n`,
          )
          res.end()
        })
        return SEND_RAW
      }

      let buffer = ''
      response.data.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data:')) {
            continue
          }
          const jsonStr = line.substring(5).trim()
          if (!jsonStr || jsonStr === '[DONE]') {
            continue
          }

          try {
            const data = JSON.parse(jsonStr)
            // Gemini 格式: candidates[0].content.parts[0].text
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text
            if (text) {
              res.write(`data: ${JSON.stringify({ type: 'content', text })}\n\n`)
            }
          } catch {
            // ignore
          }
        }
      })

      response.data.on('end', () => {
        res.write(`data: ${JSON.stringify({ type: 'test_complete', success: true })}\n\n`)
        res.end()
      })

      response.data.on('error', (err) => {
        res.write(`data: ${JSON.stringify({ type: 'test_complete', success: false, error: getSafeMessage(err) })}\n\n`)
        res.end()
      })
    } catch (axiosError) {
      res.write(
        `data: ${JSON.stringify({ type: 'test_complete', success: false, error: getSafeMessage(axiosError) })}\n\n`,
      )
      res.end()
    }

    return SEND_RAW
  }),
)

// OpenAI/Codex API Key 端点测试接口
router.post(
  '/api-key/test-openai',
  asyncRoute('OpenAI API Key test failed', async (req, res) => {
    const body = parseObjectBody(req.body, 'OpenAI 连通测试')
    const { apiKey, prompt = 'hi' } = body
    const model = await testModelConfigService.resolveApikeyModel('openai', body.model)
    const maxTokens = sanitizeMaxTokens(body.maxTokens)

    if (!apiKey) {
      throw badRequest('Please provide your API Key')
    }

    if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 512) {
      throw badRequest('API key format is invalid')
    }

    const validation = await apiKeyService.validateApiKeyForStats(apiKey)
    if (!validation.valid) {
      throw unauthorized(validation.error || 'Invalid API key')
    }

    // 检查 OpenAI 权限
    if (!apiKeyService.hasPermission(validation.keyData.permissions, 'openai')) {
      throw forbidden('This API key does not have OpenAI permission')
    }

    logger.api(`OpenAI API Key test started for: ${validation.keyData.name} (${validation.keyData.id})`)

    const port = config.server.port || 3000
    const apiUrl = `http://127.0.0.1:${port}/openai/responses`

    // 设置 SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    res.write(`data: ${JSON.stringify({ type: 'test_start', message: 'Test started' })}\n\n`)

    const payload = createOpenAITestPayload(model, { prompt, maxTokens })

    try {
      const response = await axios.post(apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'User-Agent': 'codex_cli_rs/1.0.0',
        },
        timeout: 60000,
        responseType: 'stream',
        validateStatus: () => true,
      })

      if (response.status !== 200) {
        const chunks = []
        response.data.on('data', (chunk) => chunks.push(chunk))
        response.data.on('end', () => {
          const errorData = Buffer.concat(chunks).toString()
          let errorMsg = `API Error: ${response.status}`
          try {
            const json = JSON.parse(errorData)
            errorMsg = extractErrorMessage(json, errorMsg)
          } catch {
            if (errorData.length < 200) {
              errorMsg = errorData || errorMsg
            }
          }
          res.write(
            `data: ${JSON.stringify({ type: 'test_complete', success: false, error: sanitizeErrorMsg(errorMsg) })}\n\n`,
          )
          res.end()
        })
        return SEND_RAW
      }

      let buffer = ''
      response.data.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data:')) {
            continue
          }
          const jsonStr = line.substring(5).trim()
          if (!jsonStr || jsonStr === '[DONE]') {
            continue
          }

          try {
            const data = JSON.parse(jsonStr)
            // OpenAI Responses 格式: output[].content[].text 或 delta
            if (data.type === 'response.output_text.delta' && data.delta) {
              res.write(`data: ${JSON.stringify({ type: 'content', text: data.delta })}\n\n`)
            } else if (data.type === 'response.content_part.delta' && data.delta?.text) {
              res.write(`data: ${JSON.stringify({ type: 'content', text: data.delta.text })}\n\n`)
            }
          } catch {
            // ignore
          }
        }
      })

      response.data.on('end', () => {
        res.write(`data: ${JSON.stringify({ type: 'test_complete', success: true })}\n\n`)
        res.end()
      })

      response.data.on('error', (err) => {
        res.write(`data: ${JSON.stringify({ type: 'test_complete', success: false, error: getSafeMessage(err) })}\n\n`)
        res.end()
      })
    } catch (axiosError) {
      res.write(
        `data: ${JSON.stringify({ type: 'test_complete', success: false, error: getSafeMessage(axiosError) })}\n\n`,
      )
      res.end()
    }

    return SEND_RAW
  }),
)

// 用户模型统计查询接口 - 安全的自查询接口
router.post(
  '/api/user-model-stats',
  asyncRoute('Failed to retrieve model statistics', async (req) => {
    const { apiKey, apiId, period = 'monthly' } = parseObjectBody(req.body, '模型统计')

    let keyData
    let keyId

    if (apiId) {
      // 通过 apiId 查询
      if (
        typeof apiId !== 'string' ||
        !apiId.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)
      ) {
        throw badRequest('API ID must be a valid UUID')
      }

      // 直接通过 ID 获取 API Key 数据
      keyData = await redis.getApiKey(apiId)

      if (!keyData || Object.keys(keyData).length === 0) {
        logger.security(`API key not found for ID: ${apiId} from ${req.ip || 'unknown'}`)
        throw notFound('The specified API key does not exist')
      }

      // 检查是否激活
      if (keyData.isActive !== 'true') {
        const keyName = keyData.name || 'Unknown'
        throw forbidden(`API Key "${keyName}" 已被禁用`, { data: { keyName } })
      }

      keyId = apiId

      // 获取使用统计
      const usage = await redis.getUsageStats(keyId)
      keyData.usage = { total: usage.total }
    } else if (apiKey) {
      // 通过 apiKey 查询（保持向后兼容）
      // 验证API Key（使用不触发激活的验证方法，与其它统计接口一致）
      const validation = await apiKeyService.validateApiKeyForStats(apiKey)

      if (!validation.valid) {
        const clientIP = req.ip || req.connection?.remoteAddress || 'unknown'
        logger.security(`Invalid API key in user model stats query: ${validation.error} from ${clientIP}`)
        throw unauthorized(validation.error || 'Invalid API key')
      }

      const { keyData: validatedKeyData } = validation
      keyData = validatedKeyData
      keyId = keyData.id
    } else {
      logger.security(`Missing API key or ID in user model stats query from ${req.ip || 'unknown'}`)
      throw badRequest('Please provide your API Key or API ID')
    }

    logger.api(`User model stats query from key: ${keyData.name} (${keyId}) for period: ${period}`)

    // 重用管理后台的模型统计逻辑，但只返回该API Key的数据
    const _client = redis.getClientSafe()
    // 使用与管理页面相同的时区处理逻辑
    const tzDate = redis.getDateInTimezone()
    const today = redis.getDateStringInTimezone()
    const currentMonth = `${tzDate.getFullYear()}-${String(tzDate.getMonth() + 1).padStart(2, '0')}`

    let pattern
    let matchRegex
    if (period === 'daily') {
      pattern = `usage:${keyId}:model:daily:*:${today}`
      matchRegex = /usage:.+:model:daily:(.+):\d{4}-\d{2}-\d{2}$/
    } else if (period === 'alltime') {
      pattern = RedisKeys.usage.keyAlltimePattern(keyId)
      matchRegex = /usage:.+:model:alltime:(.+)$/
    } else {
      // monthly
      pattern = `usage:${keyId}:model:monthly:*:${currentMonth}`
      matchRegex = /usage:.+:model:monthly:(.+):\d{4}-\d{2}$/
    }

    const results = await redis.scanAndGetAllChunked(pattern)
    const modelStats = []

    for (const { key, data } of results) {
      const match = key.match(matchRegex)

      if (!match) {
        continue
      }

      const model = match[1]

      if (data && Object.keys(data).length > 0) {
        const ephemeral5m = parseInt(data.ephemeral5mTokens) || 0
        const ephemeral1h = parseInt(data.ephemeral1hTokens) || 0
        const usage = {
          input_tokens: parseInt(data.inputTokens) || 0,
          output_tokens: parseInt(data.outputTokens) || 0,
          cache_creation_input_tokens: parseInt(data.cacheCreateTokens) || 0,
          cache_read_input_tokens: parseInt(data.cacheReadTokens) || 0,
        }

        // 如果有 ephemeral 5m/1h 拆分数据，添加 cache_creation 子对象以实现精确计费
        if (ephemeral5m > 0 || ephemeral1h > 0) {
          usage.cache_creation = {
            ephemeral_5m_input_tokens: ephemeral5m,
            ephemeral_1h_input_tokens: ephemeral1h,
          }
        }

        // 混合桶解析：已结算 micro + 未结算 token
        const resolved = CostCalculator.resolveModelStatsCost(
          {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheCreateTokens: usage.cache_creation_input_tokens,
            cacheReadTokens: usage.cache_read_input_tokens,
            ephemeral5mTokens: ephemeral5m,
            ephemeral1hTokens: ephemeral1h,
            requests: parseInt(data.requests) || 0,
            realCostMicro: parseInt(data.realCostMicro) || 0,
            ratedCostMicro: parseInt(data.ratedCostMicro) || 0,
            costedRequests: parseInt(data.costedRequests) || 0,
            costedInputTokens: parseInt(data.costedInputTokens) || 0,
            costedOutputTokens: parseInt(data.costedOutputTokens) || 0,
            costedCacheCreateTokens: parseInt(data.costedCacheCreateTokens) || 0,
            costedCacheReadTokens: parseInt(data.costedCacheReadTokens) || 0,
            costedEphemeral5mTokens: parseInt(data.costedEphemeral5mTokens) || 0,
            costedEphemeral1hTokens: parseInt(data.costedEphemeral1hTokens) || 0,
          },
          model,
        )
        const costData = {
          costs: resolved.costs,
          formatted: resolved.formatted,
          pricing: resolved.pricing,
        }

        // alltime 的 allTokens 由基础分项 + thinkingInAllTokens 推导。
        // 禁止使用历史上可能只累计了新流量的 allTokens；也禁止用 thinkingTokens 兜底——OpenAI/Grok 的思考是 output 子集。
        const baseTokenSum =
          usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
        const allTokens = baseTokenSum + (parseInt(data.thinkingInAllTokens) || 0)

        modelStats.push({
          model,
          requests: parseInt(data.requests) || 0,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheCreateTokens: usage.cache_creation_input_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          thinkingTokens: parseInt(data.thinkingTokens) || 0,
          allTokens,
          costs: costData.costs,
          formatted: costData.formatted,
          pricing: costData.pricing,
          isLegacy: resolved.source === 'recalculated',
        })
      }
    }

    // 如果没有详细的模型数据，不显示历史数据以避免混淆
    // 只有在查询特定时间段时返回空数组，表示该时间段确实没有数据
    if (modelStats.length === 0) {
      logger.info(`No model stats found for key ${keyId} in period ${period}`)
    }

    // 按总token数降序排列
    modelStats.sort((a, b) => b.allTokens - a.allTokens)

    return modelStats
  }),
)

// 获取服务倍率配置（公开接口）
router.get(
  '/service-rates',
  asyncRoute('Failed to retrieve service rates', async () => serviceRatesService.getRates()),
)

// 获取模型价格列表（公开只读，用户统计页展示用）
// 内部完整计费模型优先；无内部则回落外部种子
router.get(
  '/model-pricing',
  asyncRoute('Failed to retrieve model pricing', async () => {
    if (!pricingService.pricingData || Object.keys(pricingService.pricingData).length === 0) {
      await pricingService.loadPricingData()
    }
    const status = pricingService.getStatus()
    // 公开面只投影展示字段，禁止把内部 metadata 任意键暴露给未认证访客
    const pricing = toPublicPricingMap(pricingService.getEffectivePricingData())
    return {
      pricing: pricing || {},
      status: {
        lastUpdated: status.lastUpdated,
        modelCount: status.modelCount,
        seedModelCount: status.seedModelCount,
        internalBillingModels: status.internalBillingModels,
      },
    }
  }),
)

// 公开的额度卡兑换接口（通过 apiId 验证身份）
router.post(
  '/api/redeem-card',
  asyncRoute('Failed to redeem card', async (req) => {
    const { apiId, code } = parseObjectBody(req.body, '兑换码')
    const clientIP = req.ip || req.connection?.remoteAddress || 'unknown'
    const hour = new Date().toISOString().slice(0, 13)

    // 防暴力破解：检查失败锁定
    const failKey = RedisKeys.redeemCard.fail(clientIP)
    const failCount = parseInt((await redis.client.get(failKey)) || '0')
    if (failCount >= 5) {
      logger.security(`Card redemption locked for IP: ${clientIP}`)
      throw forbidden('失败次数过多，请1小时后再试')
    }

    // 防暴力破解：检查 IP 速率限制
    const ipKey = RedisKeys.redeemCard.ip(clientIP, hour)
    const ipCount = await redis.client.incr(ipKey)
    await redis.client.expire(ipKey, TTL.redeemCardWindow)
    if (ipCount > 10) {
      logger.security(`Card redemption rate limit for IP: ${clientIP}`)
      throw tooManyRequests('请求过于频繁，请稍后再试')
    }

    if (!apiId || !code) {
      throw badRequest('请输入卡号')
    }

    // 验证 apiId 格式
    if (typeof apiId !== 'string' || !apiId.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)) {
      throw badRequest('API ID 格式无效')
    }

    // 验证 API Key 存在且有效
    const keyData = await redis.getApiKey(apiId)
    if (!keyData || Object.keys(keyData).length === 0) {
      throw notFound('API Key 不存在')
    }

    if (keyData.isActive !== 'true') {
      throw forbidden('API Key 已禁用')
    }

    try {
      // 调用兑换服务
      const result = await quotaCardService.redeemCard(code, apiId, null, keyData.name || 'API Stats')

      // 成功时清除失败计数（静默处理，不影响成功响应）
      redis.client.del(failKey).catch((e) => console.error(e))

      logger.api(`Card redeemed via API Stats: ${code} -> ${apiId}`)

      return result
    } catch (error) {
      console.error(error)
      // 失败时增加失败计数（静默处理，不影响错误响应）
      redis.client
        .incr(failKey)
        .then(() => redis.client.expire(failKey, TTL.redeemCardWindow))
        .catch((e) => console.error(e))

      logger.error('Failed to redeem card:', error)
      throw badRequest(error.message)
    }
  }),
)

// 公开的兑换记录查询接口（通过 apiId 验证身份）
router.get(
  '/api/redemption-history',
  asyncRoute('Failed to get redemption history', async (req) => {
    const { apiId, limit = 50, offset = 0 } = req.query

    if (!apiId) {
      throw badRequest('缺少 API ID')
    }

    // 验证 apiId 格式
    if (typeof apiId !== 'string' || !apiId.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)) {
      throw badRequest('API ID 格式无效')
    }

    // 验证 API Key 存在
    const keyData = await redis.getApiKey(apiId)
    if (!keyData || Object.keys(keyData).length === 0) {
      throw notFound('API Key 不存在')
    }

    // 获取该 API Key 的兑换记录
    return quotaCardService.getRedemptions({
      apiKeyId: apiId,
      limit: parseInt(limit),
      offset: parseInt(offset),
    })
  }),
)
