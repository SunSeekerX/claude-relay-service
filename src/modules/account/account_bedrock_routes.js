import express from 'express'

import { bedrockAccountService } from './account_bedrock_service.js'
import { testModelConfigService } from '../relay/relay_test_model_config_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { accountGroupService } from './account_group_service.js'
import { redis } from '../../infra/redis.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { logger } from '../../common/logger.js'
import { webhookNotifier } from '../webhook/webhook_notifier.js'
import { formatAccountExpiry, mapExpiryField } from '../admin/admin_utils_routes.js'
import { stripReadonlyAccountFields } from '../../common/common_helper.js'
import { asyncRoute, SEND_RAW } from '../../common/route_handler.js'
import { ok, badRequest, notFound, HttpError } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'
// Admin Routes - Bedrock Accounts Management
// AWS Bedrock 账户管理路由

export const router = express.Router()

// 获取所有Bedrock账户
router.get(
  '/',
  authenticateAdmin,
  asyncRoute('Failed to get Bedrock accounts', async (req) => {
    const { platform, groupId } = req.query
    const result = await bedrockAccountService.getAllAccounts()
    if (!result.success) {
      throw new HttpError(500, result.error || 'Failed to get Bedrock accounts')
    }

    let accounts = result.data

    // 根据查询参数进行筛选
    if (platform && platform !== 'all' && platform !== 'bedrock') {
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
          const usageStats = await redis.getAccountUsageStats(account.id, 'openai')
          const groupInfos = await accountGroupService.getAccountGroups(account.id)

          const formattedAccount = formatAccountExpiry(account)
          return {
            ...formattedAccount,
            groupInfos,
            usage: {
              daily: usageStats.daily,
              total: usageStats.total,
              averages: usageStats.averages,
            },
          }
        } catch (statsError) {
          logger.warn(`Failed to get usage stats for Bedrock account ${account.id}:`, statsError.message)
          try {
            const groupInfos = await accountGroupService.getAccountGroups(account.id)
            const formattedAccount = formatAccountExpiry(account)
            return {
              ...formattedAccount,
              groupInfos,
              usage: {
                daily: { tokens: 0, requests: 0, allTokens: 0 },
                total: { tokens: 0, requests: 0, allTokens: 0 },
                averages: { rpm: 0, tpm: 0 },
              },
            }
          } catch (groupError) {
            logger.warn(`Failed to get group info for account ${account.id}:`, groupError.message)
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

// 创建新的Bedrock账户
router.post(
  '/',
  authenticateAdmin,
  asyncRoute('Failed to create Bedrock account', async (req) => {
    const {
      name,
      description,
      region,
      awsCredentials,
      bearerToken,
      defaultModel,
      priority,
      accountType,
      credentialType,
      proxy,
    } = parseObjectBody(req.body, '创建Bedrock账户')

    if (!name) {
      throw badRequest('Name is required')
    }

    // 验证priority的有效性（1-100）
    if (priority !== undefined && (priority < 1 || priority > 100)) {
      throw badRequest('Priority must be between 1 and 100')
    }

    // 验证accountType的有效性
    if (accountType && !['shared', 'dedicated'].includes(accountType)) {
      throw badRequest('Invalid account type. Must be "shared" or "dedicated"')
    }

    // 验证credentialType的有效性
    if (credentialType && !['access_key', 'bearer_token'].includes(credentialType)) {
      throw badRequest('Invalid credential type. Must be "access_key" or "bearer_token"')
    }

    const result = await bedrockAccountService.createAccount({
      name,
      description: description || '',
      region: region || 'us-east-1',
      awsCredentials,
      bearerToken,
      defaultModel,
      priority: priority || 50,
      accountType: accountType || 'shared',
      credentialType: credentialType || 'access_key',
      proxy,
    })

    if (!result.success) {
      throw new HttpError(500, result.error || 'Failed to create Bedrock account')
    }

    logger.success(`Admin created Bedrock account: ${name}`)
    return formatAccountExpiry(result.data)
  }),
)

// 更新Bedrock账户
router.put(
  '/:accountId',
  authenticateAdmin,
  asyncRoute('Failed to update Bedrock account', async (req) => {
    const { accountId } = req.params
    const updates = parseObjectBody(req.body, '更新Bedrock账户')

    // 【新增】映射字段名：前端的 expiresAt -> 后端的 subscriptionExpiresAt
    // review#3：剥离外部传入的状态类字段，禁止伪造自动停用证据
    const mappedUpdates = stripReadonlyAccountFields(mapExpiryField(updates, 'Bedrock', accountId))

    // 验证priority的有效性（1-100）
    if (mappedUpdates.priority !== undefined && (mappedUpdates.priority < 1 || mappedUpdates.priority > 100)) {
      throw badRequest('Priority must be between 1 and 100')
    }

    // 验证accountType的有效性
    if (mappedUpdates.accountType && !['shared', 'dedicated'].includes(mappedUpdates.accountType)) {
      throw badRequest('Invalid account type. Must be "shared" or "dedicated"')
    }

    // 验证credentialType的有效性
    if (mappedUpdates.credentialType && !['access_key', 'bearer_token'].includes(mappedUpdates.credentialType)) {
      throw badRequest('Invalid credential type. Must be "access_key" or "bearer_token"')
    }

    const result = await bedrockAccountService.updateAccount(accountId, mappedUpdates)

    if (!result.success) {
      throw new HttpError(500, result.error || 'Failed to update Bedrock account')
    }

    logger.success(`Admin updated Bedrock account: ${accountId}`)
    return ok(undefined, 'Bedrock account updated successfully')
  }),
)

// 删除Bedrock账户
router.delete(
  '/:accountId',
  authenticateAdmin,
  asyncRoute('Failed to delete Bedrock account', async (req) => {
    const { accountId } = req.params

    // 自动解绑所有绑定的 API Keys
    const unboundCount = await apiKeyService.unbindAccountFromAllKeys(accountId, 'bedrock')

    const result = await bedrockAccountService.deleteAccount(accountId)

    if (!result.success) {
      throw new HttpError(500, result.error || 'Failed to delete Bedrock account')
    }

    let message = 'Bedrock账号已成功删除'
    if (unboundCount > 0) {
      message += `，${unboundCount} 个 API Key 已切换为共享池模式`
    }

    logger.success(`Admin deleted Bedrock account: ${accountId}, unbound ${unboundCount} keys`)
    return ok({ unboundKeys: unboundCount }, message)
  }),
)

// 切换Bedrock账户状态
router.put(
  '/:accountId/toggle',
  authenticateAdmin,
  asyncRoute('Failed to toggle Bedrock account status', async (req) => {
    const { accountId } = req.params

    const accountResult = await bedrockAccountService.getAccount(accountId)
    if (!accountResult.success) {
      throw notFound('Account not found')
    }

    const newStatus = !accountResult.data.isActive
    const updateResult = await bedrockAccountService.updateAccount(accountId, {
      isActive: newStatus,
    })

    if (!updateResult.success) {
      throw new HttpError(500, updateResult.error || 'Failed to toggle account status')
    }

    logger.success(`Admin toggled Bedrock account status: ${accountId} -> ${newStatus ? 'active' : 'inactive'}`)
    return { isActive: newStatus }
  }),
)

// 切换Bedrock账户调度状态
router.put(
  '/:accountId/toggle-schedulable',
  authenticateAdmin,
  asyncRoute('Failed to toggle Bedrock account schedulable status', async (req) => {
    const { accountId } = req.params

    const accountResult = await bedrockAccountService.getAccount(accountId)
    if (!accountResult.success) {
      throw notFound('Account not found')
    }

    const newSchedulable = !accountResult.data.schedulable
    const updateResult = await bedrockAccountService.updateAccount(accountId, {
      schedulable: newSchedulable,
    })

    if (!updateResult.success) {
      throw new HttpError(500, updateResult.error || 'Failed to toggle schedulable status')
    }

    // 如果账号被禁用，发送webhook通知
    if (!newSchedulable) {
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId: accountResult.data.id,
        accountName: accountResult.data.name || 'Bedrock Account',
        platform: 'bedrock',
        status: 'disabled',
        errorCode: 'BEDROCK_MANUALLY_DISABLED',
        reason: '账号已被管理员手动禁用调度',
        timestamp: new Date().toISOString(),
      })
    }

    logger.success(
      ` Admin toggled Bedrock account schedulable status: ${accountId} -> ${
        newSchedulable ? 'schedulable' : 'not schedulable'
      }`,
    )
    return { schedulable: newSchedulable }
  }),
)

// 测试Bedrock账户连接（SSE 流式）
router.post(
  '/:accountId/test',
  authenticateAdmin,
  asyncRoute('Failed to test Bedrock account', async (req, res) => {
    const { accountId } = req.params

    // 请求显式指定优先，否则用后台配置的默认测试模型（单一事实源）
    const body = parseObjectBody(req.body, '测试Bedrock账户')
    const model = await testModelConfigService.resolveAccountModel('bedrock', body.model)
    await bedrockAccountService.testAccountConnection(accountId, res, model)
    return SEND_RAW
  }),
)

// 重置 Bedrock 账户状态
router.post(
  '/:accountId/reset-status',
  authenticateAdmin,
  asyncRoute('Failed to reset Bedrock account status', async (req) => {
    const { accountId } = req.params
    const result = await bedrockAccountService.resetAccountStatus(accountId)
    logger.success(`Admin reset status for Bedrock account: ${accountId}`)
    return result
  }),
)
