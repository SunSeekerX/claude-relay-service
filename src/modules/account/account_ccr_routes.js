import express from 'express'
import axios from 'axios'

import { ccrAccountService } from './account_ccr_service.js'
import { testModelConfigService } from '../relay/relay_test_model_config_service.js'
import { accountGroupService } from './account_group_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { redis } from '../../infra/redis.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { logger } from '../../common/logger.js'
import { webhookNotifier } from '../webhook/webhook_notifier.js'
import { formatAccountExpiry, mapExpiryField } from '../admin/admin_utils_routes.js'
import { stripReadonlyAccountFields } from '../../common/common_helper.js'
import { extractErrorMessage } from '../../common/test_payload_helper.js'
import { ProxyHelper } from '../proxy/proxy_helper.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, badRequest, notFound, unauthorized, fail } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'

export const router = express.Router()

// CCR 账户管理

// 获取所有CCR账户
router.get(
  '/',
  authenticateAdmin,
  asyncRoute('Failed to get CCR accounts', async (req) => {
    const { platform, groupId } = req.query
    let accounts = await ccrAccountService.getAllAccounts()

    // 根据查询参数进行筛选
    if (platform && platform !== 'all' && platform !== 'ccr') {
      // 如果指定了其他平台，返回空数组
      accounts = []
    }

    // 如果指定了分组筛选
    if (groupId && groupId !== 'all') {
      if (groupId === 'ungrouped') {
        // 筛选未分组账户
        const filteredAccounts = []
        for (const account of accounts) {
          const groups = await accountGroupService.getAccountGroups(account.id)
          if (!groups || groups.length === 0) {
            filteredAccounts.push(account)
          }
        }
        accounts = filteredAccounts
      } else {
        // 筛选特定分组的账户
        const groupMembers = await accountGroupService.getGroupMembers(groupId)
        accounts = accounts.filter((account) => groupMembers.includes(account.id))
      }
    }

    // 为每个账户添加使用统计信息
    const accountsWithStats = await Promise.all(
      accounts.map(async (account) => {
        try {
          const usageStats = await redis.getAccountUsageStats(account.id)
          const groupInfos = await accountGroupService.getAccountGroups(account.id)

          const formattedAccount = formatAccountExpiry(account)
          return {
            ...formattedAccount,
            // 转换schedulable为布尔值
            schedulable: account.schedulable === 'true' || account.schedulable === true,
            groupInfos,
            usage: {
              daily: usageStats.daily,
              total: usageStats.total,
              averages: usageStats.averages,
            },
          }
        } catch (statsError) {
          logger.warn(`Failed to get usage stats for CCR account ${account.id}:`, statsError.message)
          try {
            const groupInfos = await accountGroupService.getAccountGroups(account.id)
            const formattedAccount = formatAccountExpiry(account)
            return {
              ...formattedAccount,
              // 转换schedulable为布尔值
              schedulable: account.schedulable === 'true' || account.schedulable === true,
              groupInfos,
              usage: {
                daily: { tokens: 0, requests: 0, allTokens: 0 },
                total: { tokens: 0, requests: 0, allTokens: 0 },
                averages: { rpm: 0, tpm: 0 },
              },
            }
          } catch (groupError) {
            logger.warn(`Failed to get group info for CCR account ${account.id}:`, groupError.message)
            return {
              ...account,
              groupInfos: [],
              usage: {
                daily: { tokens: 0, requests: 0, allTokens: 0 },
                total: { tokens: 0, requests: 0, allTokens: 0 },
                averages: { rpm: 0, tpm: 0 },
              },
            }
          }
        }
      }),
    )

    return accountsWithStats
  }),
)

// 创建新的CCR账户
router.post(
  '/',
  authenticateAdmin,
  asyncRoute('Failed to create CCR account', async (req) => {
    const {
      name,
      description,
      apiUrl,
      apiKey,
      priority,
      supportedModels,
      userAgent,
      rateLimitDuration,
      proxy,
      accountType,
      groupId,
      dailyQuota,
      quotaResetTime,
    } = parseObjectBody(req.body, '创建CCR账户')

    if (!name || !apiUrl || !apiKey) {
      throw badRequest('Name, API URL and API Key are required')
    }

    // 验证priority的有效性（1-100）
    if (priority !== undefined && (priority < 1 || priority > 100)) {
      throw badRequest('Priority must be between 1 and 100')
    }

    // 验证accountType的有效性
    if (accountType && !['shared', 'dedicated', 'group'].includes(accountType)) {
      throw badRequest('Invalid account type. Must be "shared", "dedicated" or "group"')
    }

    // 如果是分组类型，验证groupId
    if (accountType === 'group' && !groupId) {
      throw badRequest('Group ID is required for group type accounts')
    }

    const newAccount = await ccrAccountService.createAccount({
      name,
      description,
      apiUrl,
      apiKey,
      priority: priority || 50,
      supportedModels: supportedModels || [],
      userAgent,
      rateLimitDuration: rateLimitDuration !== undefined && rateLimitDuration !== null ? rateLimitDuration : 60,
      proxy,
      accountType: accountType || 'shared',
      dailyQuota: dailyQuota || 0,
      quotaResetTime: quotaResetTime || '00:00',
    })

    // 如果是分组类型，将账户添加到分组
    if (accountType === 'group' && groupId) {
      await accountGroupService.addAccountToGroup(newAccount.id, groupId)
    }

    logger.success(`Admin created CCR account: ${name}`)
    return formatAccountExpiry(newAccount)
  }),
)

// 更新CCR账户
router.put(
  '/:accountId',
  authenticateAdmin,
  asyncRoute('Failed to update CCR account', async (req) => {
    const { accountId } = req.params
    const updates = parseObjectBody(req.body, '更新CCR账户')

    // 【新增】映射字段名：前端的 expiresAt -> 后端的 subscriptionExpiresAt
    // review#3：剥离外部传入的状态类字段，禁止伪造自动停用证据
    const mappedUpdates = stripReadonlyAccountFields(mapExpiryField(updates, 'CCR', accountId))

    // 验证priority的有效性（1-100）
    if (mappedUpdates.priority !== undefined && (mappedUpdates.priority < 1 || mappedUpdates.priority > 100)) {
      throw badRequest('Priority must be between 1 and 100')
    }

    // 验证accountType的有效性
    if (mappedUpdates.accountType && !['shared', 'dedicated', 'group'].includes(mappedUpdates.accountType)) {
      throw badRequest('Invalid account type. Must be "shared", "dedicated" or "group"')
    }

    // 如果更新为分组类型，验证groupId
    if (mappedUpdates.accountType === 'group' && !mappedUpdates.groupId) {
      throw badRequest('Group ID is required for group type accounts')
    }

    // 获取账户当前信息以处理分组变更
    const currentAccount = await ccrAccountService.getAccount(accountId)
    if (!currentAccount) {
      throw notFound('Account not found')
    }

    // 处理分组的变更
    if (mappedUpdates.accountType !== undefined) {
      // 如果之前是分组类型，需要从所有分组中移除
      if (currentAccount.accountType === 'group') {
        const oldGroups = await accountGroupService.getAccountGroups(accountId)
        for (const oldGroup of oldGroups) {
          await accountGroupService.removeAccountFromGroup(accountId, oldGroup.id)
        }
      }
      // 如果新类型是分组，处理多分组支持
      if (mappedUpdates.accountType === 'group') {
        if (Object.prototype.hasOwnProperty.call(mappedUpdates, 'groupIds')) {
          // 如果明确提供了 groupIds 参数（包括空数组）
          if (mappedUpdates.groupIds && mappedUpdates.groupIds.length > 0) {
            // 设置新的多分组
            await accountGroupService.setAccountGroups(accountId, mappedUpdates.groupIds, 'claude')
          } else {
            // groupIds 为空数组，从所有分组中移除
            await accountGroupService.removeAccountFromAllGroups(accountId)
          }
        } else if (mappedUpdates.groupId) {
          // 向后兼容：仅当没有 groupIds 但有 groupId 时使用单分组逻辑
          await accountGroupService.addAccountToGroup(accountId, mappedUpdates.groupId, 'claude')
        }
      }
    }

    await ccrAccountService.updateAccount(accountId, mappedUpdates)

    logger.success(`Admin updated CCR account: ${accountId}`)
    return ok(undefined, 'CCR account updated successfully')
  }),
)

// 删除CCR账户
router.delete(
  '/:accountId',
  authenticateAdmin,
  asyncRoute('Failed to delete CCR account', async (req) => {
    const { accountId } = req.params

    // 尝试自动解绑（CCR账户实际上不会绑定API Key，但保持代码一致性）
    const unboundCount = await apiKeyService.unbindAccountFromAllKeys(accountId, 'ccr')

    // 获取账户信息以检查是否在分组中
    const account = await ccrAccountService.getAccount(accountId)
    if (account && account.accountType === 'group') {
      const groups = await accountGroupService.getAccountGroups(accountId)
      for (const group of groups) {
        await accountGroupService.removeAccountFromGroup(accountId, group.id)
      }
    }

    await ccrAccountService.deleteAccount(accountId)

    let message = 'CCR账号已成功删除'
    if (unboundCount > 0) {
      // 理论上不会发生，但保持消息格式一致
      message += `，${unboundCount} 个 API Key 已切换为共享池模式`
    }

    logger.success(`Admin deleted CCR account: ${accountId}`)
    return ok({ unboundKeys: unboundCount }, message)
  }),
)

// 切换CCR账户状态
router.put(
  '/:accountId/toggle',
  authenticateAdmin,
  asyncRoute('Failed to toggle account status', async (req) => {
    const { accountId } = req.params

    const account = await ccrAccountService.getAccount(accountId)
    if (!account) {
      throw notFound('Account not found')
    }

    const newStatus = !account.isActive
    await ccrAccountService.updateAccount(accountId, { isActive: newStatus })

    logger.success(`Admin toggled CCR account status: ${accountId} -> ${newStatus ? 'active' : 'inactive'}`)
    return { isActive: newStatus }
  }),
)

// 切换CCR账户调度状态
router.put(
  '/:accountId/toggle-schedulable',
  authenticateAdmin,
  asyncRoute('Failed to toggle schedulable status', async (req) => {
    const { accountId } = req.params

    const account = await ccrAccountService.getAccount(accountId)
    if (!account) {
      throw notFound('Account not found')
    }

    const newSchedulable = !account.schedulable
    await ccrAccountService.updateAccount(accountId, { schedulable: newSchedulable })

    // 如果账号被禁用，发送webhook通知
    if (!newSchedulable) {
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId: account.id,
        accountName: account.name || 'CCR Account',
        platform: 'ccr',
        status: 'disabled',
        errorCode: 'CCR_MANUALLY_DISABLED',
        reason: '账号已被管理员手动禁用调度',
        timestamp: new Date().toISOString(),
      })
    }

    logger.success(
      ` Admin toggled CCR account schedulable status: ${accountId} -> ${
        newSchedulable ? 'schedulable' : 'not schedulable'
      }`,
    )
    return { schedulable: newSchedulable }
  }),
)

// 获取CCR账户的使用统计
router.get(
  '/:accountId/usage',
  authenticateAdmin,
  asyncRoute('Failed to get usage stats', async (req) => {
    const { accountId } = req.params
    const usageStats = await ccrAccountService.getAccountUsageStats(accountId)

    if (!usageStats) {
      throw notFound('Account not found')
    }

    return usageStats
  }),
)

// 手动重置CCR账户的每日使用量
router.post(
  '/:accountId/reset-usage',
  authenticateAdmin,
  asyncRoute('Failed to reset daily usage', async (req) => {
    const { accountId } = req.params
    await ccrAccountService.resetDailyUsage(accountId)

    logger.success(`Admin manually reset daily usage for CCR account: ${accountId}`)
    return ok(undefined, 'Daily usage reset successfully')
  }),
)

// 重置CCR账户状态（清除所有异常状态）
router.post(
  '/:accountId/reset-status',
  authenticateAdmin,
  asyncRoute('Failed to reset status', async (req) => {
    const { accountId } = req.params
    const result = await ccrAccountService.resetAccountStatus(accountId)
    logger.success(`Admin reset status for CCR account: ${accountId}`)
    return result
  }),
)

// 手动重置所有CCR账户的每日使用量
router.post(
  '/reset-all-usage',
  authenticateAdmin,
  asyncRoute('Failed to reset all daily usage', async () => {
    await ccrAccountService.resetAllDailyUsage()

    logger.success('Admin manually reset daily usage for all CCR accounts')
    return ok(undefined, 'All daily usage reset successfully')
  }),
)

// 测试 CCR 账户连通性
router.post(
  '/:accountId/test',
  authenticateAdmin,
  asyncRoute('CCR account test failed', async (req) => {
    const { accountId } = req.params
    const startTime = Date.now()

    try {
      // 请求显式指定优先，否则用后台配置的默认测试模型（单一事实源）
      const body = parseObjectBody(req.body, '测试CCR账户')
      const model = await testModelConfigService.resolveAccountModel('ccr', body.model)
      // 获取账户信息
      const account = await ccrAccountService.getAccount(accountId)
      if (!account) {
        throw notFound('Account not found')
      }

      // 获取解密后的凭据
      const credentials = await ccrAccountService.getDecryptedCredentials(accountId)
      if (!credentials) {
        throw unauthorized('Credentials not found or decryption failed')
      }

      // 构造测试请求

      const baseUrl = account.baseUrl || 'https://api.anthropic.com'
      const apiUrl = `${baseUrl}/v1/messages`
      const payload = {
        model,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Say "Hello" in one word.' }],
      }

      const requestConfig = {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': credentials.apiKey,
          'anthropic-version': '2023-06-01',
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

      // 提取响应文本
      let responseText = ''
      if (response.data?.content?.[0]?.text) {
        responseText = response.data.content[0].text
      }

      logger.success(`CCR account test passed: ${account.name} (${accountId}), latency: ${latency}ms`)

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
      logger.error(`CCR account test failed: ${accountId}`, error.message)

      return fail(500, extractErrorMessage(error.response?.data, error.message), {
        data: { latency },
      })
    }
  }),
)
