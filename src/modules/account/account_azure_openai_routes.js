import express from 'express'
import axios from 'axios'

import * as azureOpenaiAccountService from './account_azure_openai_service.js'
import { accountGroupService } from './account_group_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { redis } from '../../infra/redis.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, badRequest, notFound, unauthorized, fail } from '../../common/http_result.js'
import { logger } from '../../common/logger.js'
import { webhookNotifier } from '../webhook/webhook_notifier.js'
import { formatAccountExpiry, mapExpiryField } from '../admin/admin_utils_routes.js'
import { stripReadonlyAccountFields } from '../../common/common_helper.js'
import { ProxyHelper } from '../proxy/proxy_helper.js'
import { createChatCompletionsTestPayload, extractErrorMessage } from '../../common/test_payload_helper.js'
import { parseObjectBody } from '../../common/parse_body.js'

export const router = express.Router()

// 获取所有 Azure OpenAI 账户
router.get(
  '/azure-openai-accounts',
  authenticateAdmin,
  asyncRoute('Failed to fetch Azure OpenAI accounts', async (req) => {
    const { platform, groupId } = req.query
    let accounts = await azureOpenaiAccountService.getAllAccounts()

    // 根据查询参数进行筛选
    if (platform && platform !== 'all' && platform !== 'azure_openai') {
      // 如果指定了其他平台,返回空数组
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

    // 为每个账户添加使用统计信息和分组信息
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
        } catch (error) {
          logger.debug(`Failed to get usage stats for Azure OpenAI account ${account.id}:`, error)
          try {
            const groupInfos = await accountGroupService.getAccountGroups(account.id)
            const formattedAccount = formatAccountExpiry(account)
            return {
              ...formattedAccount,
              groupInfos,
              usage: {
                daily: { requests: 0, tokens: 0, allTokens: 0 },
                total: { requests: 0, tokens: 0, allTokens: 0 },
                averages: { rpm: 0, tpm: 0 },
              },
            }
          } catch (groupError) {
            logger.debug(`Failed to get group info for account ${account.id}:`, groupError)
            return {
              ...account,
              groupInfos: [],
              usage: {
                daily: { requests: 0, tokens: 0, allTokens: 0 },
                total: { requests: 0, tokens: 0, allTokens: 0 },
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

// 创建 Azure OpenAI 账户
router.post(
  '/azure-openai-accounts',
  authenticateAdmin,
  asyncRoute('Failed to create Azure OpenAI account', async (req) => {
    const {
      name,
      description,
      accountType,
      azureEndpoint,
      apiVersion,
      deploymentName,
      apiKey,
      supportedModels,
      proxy,
      groupId,
      groupIds,
      priority,
      isActive,
      schedulable,
    } = parseObjectBody(req.body, '创建Azure OpenAI账户')

    // 验证必填字段
    if (!name) {
      throw badRequest('Account name is required')
    }

    if (!azureEndpoint) {
      throw badRequest('Azure endpoint is required')
    }

    if (!apiKey) {
      throw badRequest('API key is required')
    }

    if (!deploymentName) {
      throw badRequest('Deployment name is required')
    }

    // 验证 Azure endpoint 格式
    if (!azureEndpoint.match(/^https:\/\/[\w-]+\.openai\.azure\.com$/)) {
      throw badRequest('Invalid Azure OpenAI endpoint format. Expected: https://your-resource.openai.azure.com')
    }

    // 测试连接
    try {
      const testUrl = `${azureEndpoint}/openai/deployments/${deploymentName}?api-version=${apiVersion || '2024-02-01'}`
      await axios.get(testUrl, {
        headers: {
          'api-key': apiKey,
        },
        timeout: 5000,
      })
    } catch (testError) {
      if (testError.response?.status === 404) {
        logger.warn('Azure OpenAI deployment not found, but continuing with account creation')
      } else if (testError.response?.status === 401) {
        throw badRequest('Invalid API key or unauthorized access')
      }
    }

    const account = await azureOpenaiAccountService.createAccount({
      name,
      description,
      accountType: accountType || 'shared',
      azureEndpoint,
      apiVersion: apiVersion || '2024-02-01',
      deploymentName,
      apiKey,
      supportedModels,
      proxy,
      groupId,
      priority: priority || 50,
      isActive: isActive !== false,
      schedulable: schedulable !== false,
    })

    // 如果是分组类型,将账户添加到分组
    if (accountType === 'group') {
      if (groupIds && groupIds.length > 0) {
        // 使用多分组设置
        await accountGroupService.setAccountGroups(account.id, groupIds, 'azure_openai')
      } else if (groupId) {
        // 兼容单分组模式
        await accountGroupService.addAccountToGroup(account.id, groupId, 'azure_openai')
      }
    }

    return ok(account, 'Azure OpenAI account created successfully')
  }),
)

// 更新 Azure OpenAI 账户
router.put(
  '/azure-openai-accounts/:id',
  authenticateAdmin,
  asyncRoute('Failed to update Azure OpenAI account', async (req) => {
    const { id } = req.params
    const updates = parseObjectBody(req.body, '更新Azure OpenAI账户')

    // 【新增】映射字段名:前端的 expiresAt -> 后端的 subscriptionExpiresAt
    // review#3：剥离外部传入的状态类字段，禁止伪造自动停用证据
    const mappedUpdates = stripReadonlyAccountFields(mapExpiryField(updates, 'Azure OpenAI', id))

    const account = await azureOpenaiAccountService.updateAccount(id, mappedUpdates)

    return ok(account, 'Azure OpenAI account updated successfully')
  }),
)

// 删除 Azure OpenAI 账户
router.delete(
  '/azure-openai-accounts/:id',
  authenticateAdmin,
  asyncRoute('Failed to delete Azure OpenAI account', async (req) => {
    const { id } = req.params

    // 自动解绑所有绑定的 API Keys
    const unboundCount = await apiKeyService.unbindAccountFromAllKeys(id, 'azure_openai')

    await azureOpenaiAccountService.deleteAccount(id)

    let message = 'Azure OpenAI账号已成功删除'
    if (unboundCount > 0) {
      message += `,${unboundCount} 个 API Key 已切换为共享池模式`
    }

    logger.success(`Admin deleted Azure OpenAI account: ${id}, unbound ${unboundCount} keys`)

    return ok({ unboundKeys: unboundCount }, message)
  }),
)

// 切换 Azure OpenAI 账户状态
router.put(
  '/azure-openai-accounts/:id/toggle',
  authenticateAdmin,
  asyncRoute('Failed to toggle Azure OpenAI account status', async (req) => {
    const { id } = req.params

    const account = await azureOpenaiAccountService.getAccount(id)
    if (!account) {
      throw notFound('Account not found')
    }

    const newStatus = account.isActive === 'true' ? 'false' : 'true'
    await azureOpenaiAccountService.updateAccount(id, { isActive: newStatus })

    return ok(
      { isActive: newStatus === 'true' },
      `Account ${newStatus === 'true' ? 'activated' : 'deactivated'} successfully`,
    )
  }),
)

// 切换 Azure OpenAI 账户调度状态
router.put(
  '/azure-openai-accounts/:accountId/toggle-schedulable',
  authenticateAdmin,
  asyncRoute('切换 Azure OpenAI 账户调度状态失败', async (req) => {
    const { accountId } = req.params

    const result = await azureOpenaiAccountService.toggleSchedulable(accountId)

    // 如果账号被禁用,发送webhook通知
    if (!result.schedulable) {
      // 获取账号信息
      const account = await azureOpenaiAccountService.getAccount(accountId)
      if (account) {
        await webhookNotifier.sendAccountAnomalyNotification({
          accountId: account.id,
          accountName: account.name || 'Azure OpenAI Account',
          platform: 'azure-openai',
          status: 'disabled',
          errorCode: 'AZURE_OPENAI_MANUALLY_DISABLED',
          reason: '账号已被管理员手动禁用调度',
          timestamp: new Date().toISOString(),
        })
      }
    }

    return ok({ schedulable: result.schedulable }, result.schedulable ? '已启用调度' : '已禁用调度')
  }),
)

// 健康检查单个 Azure OpenAI 账户
router.post(
  '/azure-openai-accounts/:id/health-check',
  authenticateAdmin,
  asyncRoute('Failed to perform health check', async (req) => {
    const { id } = req.params
    return azureOpenaiAccountService.healthCheckAccount(id)
  }),
)

// 批量健康检查所有 Azure OpenAI 账户
router.post(
  '/azure-openai-accounts/health-check-all',
  authenticateAdmin,
  asyncRoute('Failed to perform batch health check', async () => azureOpenaiAccountService.performHealthChecks()),
)

// 迁移 API Keys 以支持 Azure OpenAI
router.post(
  '/migrate-api-keys-azure',
  authenticateAdmin,
  asyncRoute('Failed to migrate API keys', async () => {
    const migratedCount = await azureOpenaiAccountService.migrateApiKeysForAzureSupport()
    return ok(undefined, `Successfully migrated ${migratedCount} API keys for Azure OpenAI support`)
  }),
)

// 测试 Azure OpenAI 账户连通性
router.post(
  '/azure-openai-accounts/:accountId/test',
  authenticateAdmin,
  asyncRoute('Azure OpenAI account test failed', async (req) => {
    const { accountId } = req.params
    const startTime = Date.now()
    try {
      // 获取账户信息
      const account = await azureOpenaiAccountService.getAccount(accountId)
      if (!account) {
        throw notFound('Account not found')
      }

      // 获取解密后的 API Key
      const apiKey = await azureOpenaiAccountService.getDecryptedApiKey(accountId)
      if (!apiKey) {
        throw unauthorized('API Key not found or decryption failed')
      }

      // 构造测试请求

      const deploymentName = account.deploymentName || 'gpt-4o-mini'
      const apiVersion = account.apiVersion || '2024-02-15-preview'
      const apiUrl = `${account.endpoint}/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`
      const payload = createChatCompletionsTestPayload(deploymentName)

      const requestConfig = {
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey,
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
      if (response.data?.choices?.[0]?.message?.content) {
        responseText = response.data.choices[0].message.content
      }

      logger.success(`Azure OpenAI account test passed: ${account.name} (${accountId}), latency: ${latency}ms`)

      return {
        accountId,
        accountName: account.name,
        model: deploymentName,
        latency,
        responseText: responseText.substring(0, 200),
      }
    } catch (error) {
      if (error.statusCode) {
        throw error
      }
      const latency = Date.now() - startTime
      logger.error(`Azure OpenAI account test failed: ${accountId}`, error.message)
      return fail(500, extractErrorMessage(error.response?.data, error.message), {
        data: { latency },
      })
    }
  }),
)

// 重置 Azure OpenAI 账户状态
router.post(
  '/:accountId/reset-status',
  authenticateAdmin,
  asyncRoute('Failed to reset Azure OpenAI account status', async (req) => {
    const { accountId } = req.params
    const result = await azureOpenaiAccountService.resetAccountStatus(accountId)
    logger.success(`Admin reset status for Azure OpenAI account: ${accountId}`)
    return result
  }),
)
