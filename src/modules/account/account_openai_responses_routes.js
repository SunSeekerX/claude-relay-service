import express from 'express'
import axios from 'axios'

import { openaiResponsesAccountService } from './account_openai_responses_service.js'
import { testModelConfigService } from '../relay/relay_test_model_config_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { accountGroupService } from './account_group_service.js'
import { redis } from '../../infra/redis.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, badRequest, notFound, unauthorized, fail, HttpError } from '../../common/http_result.js'
import { logger } from '../../common/logger.js'
import { webhookNotifier } from '../webhook/webhook_notifier.js'
import { formatAccountExpiry, mapExpiryField } from '../admin/admin_utils_routes.js'
import { stripReadonlyAccountFields } from '../../common/common_helper.js'
import { createOpenAITestPayload, extractErrorMessage } from '../../common/test_payload_helper.js'
import { parseObjectBody } from '../../common/parse_body.js'
import { ProxyHelper } from '../proxy/proxy_helper.js'
/**
 * Admin Routes - OpenAI-Responses 账户管理
 * 处理 OpenAI-Responses 账户的增删改查和状态管理
 */

export const router = express.Router()

// === OpenAI-Responses 账户管理 API ===

// 获取所有 OpenAI-Responses 账户
router.get(
  '/openai-responses-accounts',
  authenticateAdmin,
  asyncRoute('Failed to get OpenAI-Responses accounts', async (req) => {
    const { platform, groupId } = req.query
    let accounts = await openaiResponsesAccountService.getAllAccounts(true)

    // 根据查询参数进行筛选
    if (platform && platform !== 'openai-responses') {
      accounts = []
    }

    // 根据分组ID筛选
    if (groupId) {
      const group = await accountGroupService.getGroup(groupId)
      if (group && group.platform === 'openai') {
        const groupMembers = await accountGroupService.getGroupMembers(groupId)
        accounts = accounts.filter((account) => groupMembers.includes(account.id))
      } else {
        accounts = []
      }
    }

    const accountIds = accounts.map((a) => a.id)

    // 并行获取：轻量 API Keys + 分组信息 + daily cost + 清理限流状态
    const [allApiKeys, allGroupInfosMap, dailyCostMap] = await Promise.all([
      apiKeyService.getAllApiKeysLite(),
      accountGroupService.batchGetAccountGroupsByIndex(accountIds, 'openai'),
      redis.batchGetAccountDailyCost(accountIds),
      // 批量清理限流状态
      Promise.all(accountIds.map((id) => openaiResponsesAccountService.checkAndClearRateLimit(id))),
    ])

    // 单次遍历构建绑定数映射（只算直连，不算 group）
    const bindingCountMap = new Map()
    for (const key of allApiKeys) {
      const binding = key.openaiAccountId
      if (!binding) {
        continue
      }
      // 处理 responses: 前缀
      const accountId = binding.startsWith('responses:') ? binding.substring(10) : binding
      bindingCountMap.set(accountId, (bindingCountMap.get(accountId) || 0) + 1)
    }

    // 批量获取使用统计（不含 daily cost，已单独获取）
    const client = redis.getClientSafe()
    const today = redis.getDateStringInTimezone()
    const tzDate = redis.getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`

    const statsPipeline = client.pipeline()
    for (const accountId of accountIds) {
      statsPipeline.hgetall(RedisKeys.accountUsage.total(accountId))
      statsPipeline.hgetall(RedisKeys.accountUsage.daily(accountId, today))
      statsPipeline.hgetall(RedisKeys.accountUsage.monthly(accountId, currentMonth))
    }
    const statsResults = await statsPipeline.exec()

    // 处理统计数据
    const allUsageStatsMap = new Map()
    for (let i = 0; i < accountIds.length; i++) {
      const accountId = accountIds[i]
      const [errTotal, total] = statsResults[i * 3]
      const [errDaily, daily] = statsResults[i * 3 + 1]
      const [errMonthly, monthly] = statsResults[i * 3 + 2]

      const parseUsage = (data) => ({
        requests: parseInt(data?.totalRequests || data?.requests) || 0,
        tokens: parseInt(data?.totalTokens || data?.tokens) || 0,
        inputTokens: parseInt(data?.totalInputTokens || data?.inputTokens) || 0,
        outputTokens: parseInt(data?.totalOutputTokens || data?.outputTokens) || 0,
        cacheCreateTokens: parseInt(data?.totalCacheCreateTokens || data?.cacheCreateTokens) || 0,
        cacheReadTokens: parseInt(data?.totalCacheReadTokens || data?.cacheReadTokens) || 0,
        allTokens:
          parseInt(data?.totalAllTokens || data?.allTokens) ||
          (parseInt(data?.totalInputTokens || data?.inputTokens) || 0) +
            (parseInt(data?.totalOutputTokens || data?.outputTokens) || 0) +
            (parseInt(data?.totalCacheCreateTokens || data?.cacheCreateTokens) || 0) +
            (parseInt(data?.totalCacheReadTokens || data?.cacheReadTokens) || 0),
      })

      allUsageStatsMap.set(accountId, {
        total: errTotal ? {} : parseUsage(total),
        daily: errDaily ? {} : parseUsage(daily),
        monthly: errMonthly ? {} : parseUsage(monthly),
      })
    }

    // 处理额度信息、使用统计和绑定的 API Key 数量
    const accountsWithStats = accounts.map((account) => {
      const usageStats = allUsageStatsMap.get(account.id) || {
        daily: { requests: 0, tokens: 0, allTokens: 0 },
        total: { requests: 0, tokens: 0, allTokens: 0 },
        monthly: { requests: 0, tokens: 0, allTokens: 0 },
      }

      const groupInfos = allGroupInfosMap.get(account.id) || []
      const boundCount = bindingCountMap.get(account.id) || 0
      const dailyCost = dailyCostMap.get(account.id) || 0

      const formattedAccount = formatAccountExpiry(account)
      return {
        ...formattedAccount,
        groupInfos,
        boundApiKeysCount: boundCount,
        usage: {
          daily: { ...usageStats.daily, cost: dailyCost },
          total: usageStats.total,
          monthly: usageStats.monthly,
        },
      }
    })

    return accountsWithStats
  }),
)

// 创建 OpenAI-Responses 账户
router.post(
  '/openai-responses-accounts',
  authenticateAdmin,
  asyncRoute('Failed to create OpenAI-Responses account', async (req) => {
    const accountData = parseObjectBody(req.body, '创建OpenAI-Responses账户')

    // 验证分组类型
    if (
      accountData.accountType === 'group' &&
      !accountData.groupId &&
      (!accountData.groupIds || accountData.groupIds.length === 0)
    ) {
      throw badRequest('Group ID is required for group type accounts')
    }

    const account = await openaiResponsesAccountService.createAccount(accountData)

    // 如果是分组类型，处理分组绑定
    if (accountData.accountType === 'group') {
      if (accountData.groupIds && accountData.groupIds.length > 0) {
        // 多分组模式
        await accountGroupService.setAccountGroups(account.id, accountData.groupIds, 'openai')
        logger.info(`Added OpenAI-Responses account ${account.id} to groups: ${accountData.groupIds.join(', ')}`)
      } else if (accountData.groupId) {
        // 单分组模式（向后兼容）
        await accountGroupService.addAccountToGroup(account.id, accountData.groupId, 'openai')
        logger.info(`Added OpenAI-Responses account ${account.id} to group: ${accountData.groupId}`)
      }
    }

    return formatAccountExpiry(account)
  }),
)

// 更新 OpenAI-Responses 账户
router.put(
  '/openai-responses-accounts/:id',
  authenticateAdmin,
  asyncRoute('Failed to update OpenAI-Responses account', async (req) => {
    const { id } = req.params
    const updates = parseObjectBody(req.body, '更新OpenAI-Responses账户')

    // 获取当前账户信息
    const currentAccount = await openaiResponsesAccountService.getAccount(id)
    if (!currentAccount) {
      throw notFound('Account not found')
    }

    // 【新增】映射字段名：前端的 expiresAt -> 后端的 subscriptionExpiresAt
    // review#3：剥离外部传入的状态类字段，禁止伪造自动停用证据
    const mappedUpdates = stripReadonlyAccountFields(mapExpiryField(updates, 'OpenAI-Responses', id))

    // 验证priority的有效性（1-100）
    if (mappedUpdates.priority !== undefined) {
      const priority = parseInt(mappedUpdates.priority)
      if (isNaN(priority) || priority < 1 || priority > 100) {
        throw badRequest('Priority must be a number between 1 and 100')
      }
      mappedUpdates.priority = priority.toString()
    }

    // 处理分组变更
    if (mappedUpdates.accountType !== undefined) {
      // 如果之前是分组类型，需要从所有分组中移除
      if (currentAccount.accountType === 'group') {
        const oldGroups = await accountGroupService.getAccountGroups(id)
        for (const oldGroup of oldGroups) {
          await accountGroupService.removeAccountFromGroup(id, oldGroup.id)
        }
        logger.info(`Removed OpenAI-Responses account ${id} from all groups`)
      }

      // 如果新类型是分组，处理多分组支持
      if (mappedUpdates.accountType === 'group') {
        if (Object.prototype.hasOwnProperty.call(mappedUpdates, 'groupIds')) {
          if (mappedUpdates.groupIds && mappedUpdates.groupIds.length > 0) {
            // 设置新的多分组
            await accountGroupService.setAccountGroups(id, mappedUpdates.groupIds, 'openai')
            logger.info(`Added OpenAI-Responses account ${id} to groups: ${mappedUpdates.groupIds.join(', ')}`)
          } else {
            // groupIds 为空数组，从所有分组中移除
            await accountGroupService.removeAccountFromAllGroups(id)
            logger.info(`Removed OpenAI-Responses account ${id} from all groups (empty groupIds)`)
          }
        } else if (mappedUpdates.groupId) {
          // 向后兼容：仅当没有 groupIds 但有 groupId 时使用单分组逻辑
          await accountGroupService.addAccountToGroup(id, mappedUpdates.groupId, 'openai')
          logger.info(`Added OpenAI-Responses account ${id} to group: ${mappedUpdates.groupId}`)
        }
      }
    }

    const result = await openaiResponsesAccountService.updateAccount(id, mappedUpdates)

    if (!result.success) {
      throw badRequest(result.error || result.message || 'Failed to update account')
    }

    logger.success(`Admin updated OpenAI-Responses account: ${id}`)
    const { success: _success, ...payload } = result
    return payload
  }),
)

// 删除 OpenAI-Responses 账户
router.delete(
  '/openai-responses-accounts/:id',
  authenticateAdmin,
  asyncRoute('Failed to delete OpenAI-Responses account', async (req) => {
    const { id } = req.params

    const account = await openaiResponsesAccountService.getAccount(id)
    if (!account) {
      throw notFound('Account not found')
    }

    // 自动解绑所有绑定的 API Keys
    const unboundCount = await apiKeyService.unbindAccountFromAllKeys(id, 'openai-responses')

    // 从所有分组中移除此账户
    if (account.accountType === 'group') {
      await accountGroupService.removeAccountFromAllGroups(id)
      logger.info(`Removed OpenAI-Responses account ${id} from all groups`)
    }

    const result = await openaiResponsesAccountService.deleteAccount(id)

    let message = 'OpenAI-Responses账号已成功删除'
    if (unboundCount > 0) {
      message += `，${unboundCount} 个 API Key 已切换为共享池模式`
    }

    logger.success(`Admin deleted OpenAI-Responses account: ${id}, unbound ${unboundCount} keys`)

    const { success: _success, ...resultPayload } = result || {}
    return ok({ ...resultPayload, unboundKeys: unboundCount }, message)
  }),
)

// 切换 OpenAI-Responses 账户调度状态
router.put(
  '/openai-responses-accounts/:id/toggle-schedulable',
  authenticateAdmin,
  asyncRoute('Failed to toggle OpenAI-Responses account schedulable status', async (req) => {
    const { id } = req.params

    const result = await openaiResponsesAccountService.toggleSchedulable(id)

    if (!result.success) {
      throw badRequest(result.error || result.message || 'Failed to toggle schedulable')
    }

    // 仅在停止调度时发送通知
    if (!result.schedulable) {
      await webhookNotifier.sendAccountEvent('account.status_changed', {
        accountId: id,
        platform: 'openai-responses',
        schedulable: result.schedulable,
        changedBy: 'admin',
        action: 'stopped_scheduling',
      })
    }

    const { success: _success, ...payload } = result
    return payload
  }),
)

// 切换 OpenAI-Responses 账户激活状态
router.put(
  '/openai-responses-accounts/:id/toggle',
  authenticateAdmin,
  asyncRoute('Failed to toggle OpenAI-Responses account status', async (req) => {
    const { id } = req.params

    const account = await openaiResponsesAccountService.getAccount(id)
    if (!account) {
      throw notFound('Account not found')
    }

    const newActiveStatus = account.isActive === 'true' ? 'false' : 'true'
    await openaiResponsesAccountService.updateAccount(id, {
      isActive: newActiveStatus,
    })

    return { isActive: newActiveStatus === 'true' }
  }),
)

// 重置 OpenAI-Responses 账户限流状态
router.post(
  '/openai-responses-accounts/:id/reset-rate-limit',
  authenticateAdmin,
  asyncRoute('Failed to reset OpenAI-Responses account rate limit', async (req) => {
    const { id } = req.params

    await openaiResponsesAccountService.updateAccount(id, {
      rateLimitedAt: '',
      rateLimitStatus: '',
      status: 'active',
      errorMessage: '',
    })

    logger.info(`Admin manually reset rate limit for OpenAI-Responses account ${id}`)

    return ok(undefined, 'Rate limit reset successfully')
  }),
)

// 重置 OpenAI-Responses 账户状态（清除所有异常状态）
router.post(
  '/openai-responses-accounts/:id/reset-status',
  authenticateAdmin,
  asyncRoute('Failed to reset OpenAI-Responses account status', async (req) => {
    const { id } = req.params

    const result = await openaiResponsesAccountService.resetAccountStatus(id)

    logger.success(`Admin reset status for OpenAI-Responses account: ${id}`)
    return result
  }),
)

// 手动重置 OpenAI-Responses 账户的每日使用量
router.post(
  '/openai-responses-accounts/:id/reset-usage',
  authenticateAdmin,
  asyncRoute('Failed to reset OpenAI-Responses account usage', async (req) => {
    const { id } = req.params

    await openaiResponsesAccountService.updateAccount(id, {
      dailyUsage: '0',
      lastResetDate: redis.getDateStringInTimezone(),
      quotaStoppedAt: '',
    })

    logger.success(`Admin manually reset daily usage for OpenAI-Responses account ${id}`)

    return ok(undefined, 'Daily usage reset successfully')
  }),
)

// 测试 OpenAI-Responses 账户连通性
router.post(
  '/openai-responses-accounts/:accountId/test',
  authenticateAdmin,
  asyncRoute('OpenAI-Responses account test failed', async (req) => {
    const { accountId } = req.params
    const startTime = Date.now()

    try {
      // 请求显式指定优先，否则用后台配置的默认测试模型（单一事实源）
      const body = parseObjectBody(req.body, '测试OpenAI-Responses账户')
      const model = await testModelConfigService.resolveAccountModel('openai-responses', body.model)
      // 获取账户信息（apiKey 已自动解密）
      const account = await openaiResponsesAccountService.getAccount(accountId)
      if (!account) {
        throw notFound('Account not found')
      }

      if (!account.apiKey) {
        throw unauthorized('API Key not found or decryption failed')
      }

      // 构造测试请求（根据 providerEndpoint 和 baseApi 决定端点路径）
      const baseUrl = account.baseApi || 'https://api.openai.com'
      const providerEndpoint = account.providerEndpoint || 'responses'
      let endpointPath = '/responses'
      if (providerEndpoint === 'auto') {
        endpointPath = '/responses' // 测试时默认用 responses
      }
      // 防止 baseApi 已含 /v1 时路径重复
      if (!baseUrl.endsWith('/v1')) {
        endpointPath = `/v1${endpointPath}`
      }
      const apiUrl = `${baseUrl}${endpointPath}`
      const payload = createOpenAITestPayload(model, { stream: false })

      const requestConfig = {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${account.apiKey}`,
        },
        timeout: 30000,
      }

      // 配置代理
      if (account.proxy) {
        const agent = ProxyHelper.createProxyAgent(account.proxy)
        if (agent) {
          requestConfig.httpsAgent = agent
          requestConfig.httpAgent = agent
        }
      }

      const response = await axios.post(apiUrl, payload, requestConfig)
      const latency = Date.now() - startTime

      // 提取响应文本（Responses API 格式）
      let responseText = ''
      const output = response.data?.output
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const block of item.content) {
              if (block.type === 'output_text' && block.text) {
                responseText += block.text
              }
            }
          }
        }
      }

      logger.success(`OpenAI-Responses account test passed: ${account.name} (${accountId}), latency: ${latency}ms`)

      return {
        accountId,
        accountName: account.name,
        model,
        latency,
        responseText: responseText.substring(0, 200),
      }
    } catch (error) {
      if (error.statusCode) {
        throw error
      }
      const latency = Date.now() - startTime
      logger.error(`OpenAI-Responses account test failed: ${accountId}`, error.message)
      return fail(500, extractErrorMessage(error.response?.data, error.message), {
        data: { latency },
      })
    }
  }),
)

// 从上游同步模型列表（对齐 sub2api/CLIProxy：GET {base}/models）
// body: { accountId? } 或 { baseApi, apiKey }（创建前探测）
router.post(
  '/openai-responses-accounts/fetch-models',
  authenticateAdmin,
  asyncRoute('Failed to fetch OpenAI-Responses upstream models', async (req) => {
    const body = parseObjectBody(req.body, '获取OpenAI-Responses模型列表')
    let baseApi = String(body.baseApi || '').trim()
    let apiKey = String(body.apiKey || '').trim()
    const { accountId } = body

    if (accountId) {
      const account = await openaiResponsesAccountService.getAccount(accountId)
      if (!account) {
        throw notFound('Account not found')
      }
      // 表单已填的 baseApi/apiKey 优先（编辑未保存时按当前表单探测）；空才回落账户已存值
      if (!baseApi) {
        baseApi = account.baseApi || ''
      }
      if (!apiKey && account.apiKey && account.apiKey !== '***') {
        ;({ apiKey } = account)
      }
    }

    if (!baseApi) {
      throw badRequest('baseApi is required')
    }
    if (!apiKey) {
      throw badRequest('apiKey is required')
    }

    const normalizedBase = baseApi.replace(/\/+$/, '')
    // 兼容 base 已含 /v1 或不含
    const candidates = normalizedBase.endsWith('/v1')
      ? [`${normalizedBase}/models`, `${normalizedBase}/v1/models`]
      : [`${normalizedBase}/v1/models`, `${normalizedBase}/models`]

    let lastError = null
    let models = []
    for (const url of candidates) {
      try {
        const response = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
          validateStatus: () => true,
          proxy: false,
        })
        if (response.status >= 400) {
          lastError = `HTTP ${response.status} from ${url}`
          continue
        }
        const { data } = response
        // OpenAI: { data: [{id}] }；Codex: { models: [{id|slug}] }
        if (Array.isArray(data?.data)) {
          models = data.data
            .map((item) => item?.id || item?.model || item?.name)
            .filter((id) => typeof id === 'string' && id.trim())
        } else if (Array.isArray(data?.models)) {
          models = data.models
            .map((item) => item?.id || item?.slug || item?.model || item?.name)
            .filter((id) => typeof id === 'string' && id.trim())
        } else if (Array.isArray(data)) {
          models = data
            .map((item) => (typeof item === 'string' ? item : item?.id))
            .filter((id) => typeof id === 'string' && id.trim())
        }
        if (models.length > 0) {
          lastError = null
          break
        }
        lastError = `No models in response from ${url}`
      } catch (error) {
        lastError = error.message
        console.error(error)
      }
    }

    if (models.length === 0) {
      throw new HttpError(502, lastError || 'Failed to fetch models from upstream')
    }

    // 去重保序
    const seen = new Set()
    const unique = []
    for (const id of models) {
      if (!seen.has(id)) {
        seen.add(id)
        unique.push(id)
      }
    }

    logger.info(`[openai-responses] fetch-models base=${normalizedBase} count=${unique.length}`)
    return { models: unique }
  }),
)
