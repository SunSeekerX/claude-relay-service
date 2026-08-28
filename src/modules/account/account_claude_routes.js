import express from 'express'
import crypto from 'node:crypto'

import { claudeAccountService } from './account_claude_service.js'
import { claudeRelayService } from '../relay/relay_claude_relay_service.js'
import { accountGroupService } from './account_group_service.js'
import { accountTestSchedulerService } from './account_test_scheduler_service.js'
import { testModelConfigService } from '../relay/relay_test_model_config_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { redis } from '../../infra/redis.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute, SEND_RAW } from '../../common/route_handler.js'
import { ok, badRequest, notFound, conflict } from '../../common/http_result.js'
import { logger } from '../../common/logger.js'
import * as oauthHelper from '../../common/oauth_helper.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { CostCalculator } from '../pricing/pricing_cost_calculator.js'
import { webhookNotifier } from '../webhook/webhook_notifier.js'
import { formatAccountExpiry, mapExpiryField } from '../admin/admin_utils_routes.js'
import { stripReadonlyAccountFields } from '../../common/common_helper.js'
import { parseObjectBody } from '../../common/parse_body.js'
import {
  isEmptyValue,
  parseBooleanLike,
  normalizeOptionalNonNegativeInteger,
} from '../relay/relay_temp_unavailable_policy.js'
/**
 * Admin Routes - Claude 官方账户管理
 * OAuth 方式授权的 Claude 账户
 */

export const router = express.Router()

const TEMP_UNAVAILABLE_TTL_FIELDS = ['tempUnavailable503TtlSeconds', 'tempUnavailable5xxTtlSeconds']

const normalizeTempUnavailablePolicyPayload = (payload, options = {}) => {
  const { partial = false } = options
  const normalized = {}

  for (const field of TEMP_UNAVAILABLE_TTL_FIELDS) {
    if (partial && !Object.prototype.hasOwnProperty.call(payload, field)) {
      continue
    }

    const rawValue = payload[field]
    const parsedValue = normalizeOptionalNonNegativeInteger(rawValue)
    if (!isEmptyValue(rawValue) && parsedValue === null) {
      return { error: `${field} must be a non-negative integer` }
    }
    normalized[field] = parsedValue
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'disableTempUnavailable')) {
    normalized.disableTempUnavailable = parseBooleanLike(payload.disableTempUnavailable)
  }

  return { normalized }
}

// 生成OAuth授权URL
router.post(
  '/claude-accounts/generate-auth-url',
  authenticateAdmin,
  asyncRoute('Failed to generate OAuth URL', async (req) => {
    const { proxy, proxyGroupId, proxyId } = parseObjectBody(req.body, '生成Claude授权URL')
    // 账户绑代理池时授权请求也走池代理（未绑池回退静态 proxy）
    const effectiveProxy = proxyResolver.resolveAuthProxy(
      { proxyGroupId, proxyId, platform: 'claude' },
      'claude',
      proxy,
    )
    const oauthParams = await oauthHelper.generateOAuthParams()

    // 将codeVerifier和state临时存储到Redis，用于后续验证
    const sessionId = crypto.randomUUID()
    await redis.setOAuthSession(sessionId, {
      codeVerifier: oauthParams.codeVerifier,
      state: oauthParams.state,
      codeChallenge: oauthParams.codeChallenge,
      proxy: effectiveProxy, // 存储已解析代理（池或静态）
      proxyBound: !!(proxyGroupId || proxyId), // 代理来源是否池绑定，供 exchange 一致性校验
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10分钟过期
    })

    logger.success('Generated OAuth authorization URL with proxy support')
    return {
      authUrl: oauthParams.authUrl,
      sessionId,
      instructions: [
        '1. 复制上面的链接到浏览器中打开',
        '2. 登录您的 Anthropic 账户',
        '3. 同意应用权限',
        '4. 复制浏览器地址栏中的完整 URL',
        '5. 在添加账户表单中粘贴完整的回调 URL 和授权码',
      ],
    }
  }),
)

// 验证授权码并获取token
router.post(
  '/claude-accounts/exchange-code',
  authenticateAdmin,
  asyncRoute('Failed to exchange authorization code', async (req) => {
    const { sessionId, authorizationCode, callbackUrl } = parseObjectBody(req.body, 'Claude授权码交换')

    if (!sessionId || (!authorizationCode && !callbackUrl)) {
      throw badRequest('Session ID and authorization code (or callback URL) are required')
    }

    // 从Redis获取OAuth会话信息
    const oauthSession = await redis.getOAuthSession(sessionId)
    if (!oauthSession) {
      throw badRequest('Invalid or expired OAuth session')
    }

    // 检查会话是否过期
    if (new Date() > new Date(oauthSession.expiresAt)) {
      await redis.deleteOAuthSession(sessionId)
      throw badRequest('OAuth session has expired, please generate a new authorization URL')
    }

    // 一致性校验：会话来源为池绑定但无已解析代理，拒绝（不允许授权直连暴露真实出口）
    if (oauthSession.proxyBound && !oauthSession.proxy) {
      await redis.deleteOAuthSession(sessionId)
      throw conflict('账户绑定的代理池当前无可用代理，已阻止授权请求直连（避免暴露真实出口）')
    }

    // 统一处理授权码输入（可能是直接的code或完整的回调URL）
    let finalAuthCode
    const inputValue = callbackUrl || authorizationCode

    try {
      finalAuthCode = oauthHelper.parseCallbackUrl(inputValue)
    } catch (parseError) {
      throw badRequest(parseError.message)
    }

    // 交换访问令牌
    const tokenData = await oauthHelper.exchangeCodeForTokens(
      finalAuthCode,
      oauthSession.codeVerifier,
      oauthSession.state,
      oauthSession.proxy, // 传递代理配置
    )

    // 清理OAuth会话
    await redis.deleteOAuthSession(sessionId)

    logger.success('Successfully exchanged authorization code for tokens')
    return {
      claudeAiOauth: tokenData,
    }
  }),
)

// 生成Claude setup-token授权URL
router.post(
  '/claude-accounts/generate-setup-token-url',
  authenticateAdmin,
  asyncRoute('Failed to generate Setup Token URL', async (req) => {
    const { proxy, proxyGroupId, proxyId } = parseObjectBody(req.body, '生成Claude Setup Token URL')
    // 账户绑代理池时授权请求也走池代理（未绑池回退静态 proxy）
    const effectiveProxy = proxyResolver.resolveAuthProxy(
      { proxyGroupId, proxyId, platform: 'claude' },
      'claude',
      proxy,
    )
    const setupTokenParams = await oauthHelper.generateSetupTokenParams()

    // 将codeVerifier和state临时存储到Redis，用于后续验证
    const sessionId = crypto.randomUUID()
    await redis.setOAuthSession(sessionId, {
      type: 'setup-token', // 标记为setup-token类型
      codeVerifier: setupTokenParams.codeVerifier,
      state: setupTokenParams.state,
      codeChallenge: setupTokenParams.codeChallenge,
      proxy: effectiveProxy, // 存储已解析代理（池或静态）
      proxyBound: !!(proxyGroupId || proxyId), // 代理来源是否池绑定，供 exchange 一致性校验
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10分钟过期
    })

    logger.success('Generated Setup Token authorization URL with proxy support')
    return {
      authUrl: setupTokenParams.authUrl,
      sessionId,
      instructions: [
        '1. 复制上面的链接到浏览器中打开',
        '2. 登录您的 Claude 账户并授权 Claude Code',
        '3. 完成授权后，从返回页面复制 Authorization Code',
        '4. 在添加账户表单中粘贴 Authorization Code',
      ],
    }
  }),
)

// 验证setup-token授权码并获取token
router.post(
  '/claude-accounts/exchange-setup-token-code',
  authenticateAdmin,
  asyncRoute('Failed to exchange setup token authorization code', async (req) => {
    const { sessionId, authorizationCode, callbackUrl } = parseObjectBody(req.body, 'Claude Setup Token交换')

    if (!sessionId || (!authorizationCode && !callbackUrl)) {
      throw badRequest('Session ID and authorization code (or callback URL) are required')
    }

    // 从Redis获取OAuth会话信息
    const oauthSession = await redis.getOAuthSession(sessionId)
    if (!oauthSession) {
      throw badRequest('Invalid or expired OAuth session')
    }

    // 检查是否是setup-token类型
    if (oauthSession.type !== 'setup-token') {
      throw badRequest('Invalid session type for setup token exchange')
    }

    // 检查会话是否过期
    if (new Date() > new Date(oauthSession.expiresAt)) {
      await redis.deleteOAuthSession(sessionId)
      throw badRequest('OAuth session has expired, please generate a new authorization URL')
    }

    // 一致性校验：会话来源为池绑定但无已解析代理，拒绝（不允许授权直连暴露真实出口）
    if (oauthSession.proxyBound && !oauthSession.proxy) {
      await redis.deleteOAuthSession(sessionId)
      throw conflict('账户绑定的代理池当前无可用代理，已阻止授权请求直连（避免暴露真实出口）')
    }

    // 统一处理授权码输入（可能是直接的code或完整的回调URL）
    let finalAuthCode
    const inputValue = callbackUrl || authorizationCode

    try {
      finalAuthCode = oauthHelper.parseCallbackUrl(inputValue)
    } catch (parseError) {
      throw badRequest(parseError.message)
    }

    // 交换Setup Token
    const tokenData = await oauthHelper.exchangeSetupTokenCode(
      finalAuthCode,
      oauthSession.codeVerifier,
      oauthSession.state,
      oauthSession.proxy, // 传递代理配置
    )

    // 清理OAuth会话
    await redis.deleteOAuthSession(sessionId)

    logger.success('Successfully exchanged setup token authorization code for tokens')
    return {
      claudeAiOauth: tokenData,
    }
  }),
)

// ===
// Cookie自动授权端点 (基于sessionKey自动完成OAuth流程)
// ===

// 普通OAuth的Cookie自动授权
router.post(
  '/claude-accounts/oauth-with-cookie',
  authenticateAdmin,
  asyncRoute('Cookie授权失败', async (req) => {
    const { sessionKey, proxy, proxyGroupId, proxyId } = parseObjectBody(req.body, 'Claude Cookie授权')

    // 验证sessionKey参数
    if (!sessionKey || typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
      throw badRequest('请提供有效的sessionKey值')
    }

    const trimmedSessionKey = sessionKey.trim()
    // 账户绑代理池时授权也走池代理（未绑池回退静态 proxy）
    const effectiveProxy = proxyResolver.resolveAuthProxy(
      { proxyGroupId, proxyId, platform: 'claude' },
      'claude',
      proxy,
    )

    logger.info('Starting Cookie-based OAuth authorization', {
      sessionKeyLength: trimmedSessionKey.length,
      sessionKeyPrefix: `${trimmedSessionKey.substring(0, 10)}...`,
      hasProxy: !!effectiveProxy,
    })

    // 执行Cookie自动授权流程
    const result = await oauthHelper.oauthWithCookie(trimmedSessionKey, effectiveProxy, false)

    logger.success('Cookie-based OAuth authorization completed successfully')

    return {
      claudeAiOauth: result.claudeAiOauth,
      organizationUuid: result.organizationUuid,
      capabilities: result.capabilities,
    }
  }),
)

// Setup Token的Cookie自动授权
router.post(
  '/claude-accounts/setup-token-with-cookie',
  authenticateAdmin,
  asyncRoute('Cookie授权失败', async (req) => {
    const { sessionKey, proxy, proxyGroupId, proxyId } = parseObjectBody(req.body, 'Claude Setup Token Cookie授权')

    // 验证sessionKey参数
    if (!sessionKey || typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
      throw badRequest('请提供有效的sessionKey值')
    }

    const trimmedSessionKey = sessionKey.trim()
    // 账户绑代理池时授权也走池代理（未绑池回退静态 proxy）
    const effectiveProxy = proxyResolver.resolveAuthProxy(
      { proxyGroupId, proxyId, platform: 'claude' },
      'claude',
      proxy,
    )

    logger.info('Starting Cookie-based Setup Token authorization', {
      sessionKeyLength: trimmedSessionKey.length,
      sessionKeyPrefix: `${trimmedSessionKey.substring(0, 10)}...`,
      hasProxy: !!effectiveProxy,
    })

    // 执行Cookie自动授权流程（Setup Token模式）
    const result = await oauthHelper.oauthWithCookie(trimmedSessionKey, effectiveProxy, true)

    logger.success('Cookie-based Setup Token authorization completed successfully')

    return {
      claudeAiOauth: result.claudeAiOauth,
      organizationUuid: result.organizationUuid,
      capabilities: result.capabilities,
    }
  }),
)

// 获取所有Claude账户
router.get(
  '/claude-accounts',
  authenticateAdmin,
  asyncRoute('Failed to get Claude accounts', async (req) => {
    const { platform, groupId } = req.query
    let accounts = await claudeAccountService.getAllAccounts()

    // 根据查询参数进行筛选
    if (platform && platform !== 'all' && platform !== 'claude') {
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

          // 获取会话窗口使用统计（仅对有活跃窗口的账户）
          let sessionWindowUsage = null
          if (account.sessionWindow && account.sessionWindow.hasActiveWindow) {
            const windowUsage = await redis.getAccountSessionWindowUsage(
              account.id,
              account.sessionWindow.windowStart,
              account.sessionWindow.windowEnd,
            )

            // 计算会话窗口的总费用
            let totalCost = 0
            const modelCosts = {}

            for (const [modelName, usage] of Object.entries(windowUsage.modelUsage)) {
              const usageData = {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                cache_creation_input_tokens: usage.cacheCreateTokens,
                cache_read_input_tokens: usage.cacheReadTokens,
              }

              // 添加 cache_creation 子对象以支持精确 ephemeral 定价
              if (usage.ephemeral5mTokens > 0 || usage.ephemeral1hTokens > 0) {
                usageData.cache_creation = {
                  ephemeral_5m_input_tokens: usage.ephemeral5mTokens,
                  ephemeral_1h_input_tokens: usage.ephemeral1hTokens,
                }
              }

              logger.debug(`Calculating cost for model ${modelName}:`, JSON.stringify(usageData))
              const costResult = CostCalculator.calculateCost(usageData, modelName)
              logger.debug(`Cost result for ${modelName}: total=${costResult.costs.total}`)

              modelCosts[modelName] = {
                ...usage,
                cost: costResult.costs.total,
              }
              totalCost += costResult.costs.total
            }

            sessionWindowUsage = {
              totalTokens: windowUsage.totalAllTokens,
              totalRequests: windowUsage.totalRequests,
              totalCost,
              modelUsage: modelCosts,
            }
          }

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
              sessionWindow: sessionWindowUsage,
            },
          }
        } catch (statsError) {
          logger.warn(`Failed to get usage stats for account ${account.id}:`, statsError.message)
          // 如果获取统计失败，返回空统计
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
                sessionWindow: null,
              },
            }
          } catch (groupError) {
            logger.warn(`Failed to get group info for account ${account.id}:`, groupError.message)
            const formattedAccount = formatAccountExpiry(account)
            return {
              ...formattedAccount,
              groupInfos: [],
              usage: {
                daily: { tokens: 0, requests: 0, allTokens: 0 },
                total: { tokens: 0, requests: 0, allTokens: 0 },
                averages: { rpm: 0, tpm: 0 },
                sessionWindow: null,
              },
            }
          }
        }
      }),
    )

    return accountsWithStats
  }),
)

// 批量获取 Claude 账户的 OAuth Usage 数据
router.get(
  '/claude-accounts/usage',
  authenticateAdmin,
  asyncRoute('Failed to fetch usage data', async (_req) => {
    const accounts = await redis.getAllClaudeAccounts()
    const now = Date.now()
    const usageCacheTtlMs = 300 * 1000

    // 批量并发获取所有活跃 OAuth 账户的 Usage
    const usagePromises = accounts.map(async (account) => {
      // 检查是否为 OAuth 账户：scopes 包含 OAuth 相关权限
      const scopes = account.scopes && account.scopes.trim() ? account.scopes.split(' ') : []
      const isOAuth = scopes.includes('user:profile') && scopes.includes('user:inference')

      // 仅为 OAuth 授权的活跃账户调用 usage API
      if (isOAuth && account.isActive === 'true' && account.accessToken && account.status === 'active') {
        // 若快照在 300 秒内更新，直接使用缓存避免频繁请求
        const cachedUsage = claudeAccountService.buildClaudeUsageSnapshot(account)
        const lastUpdatedAt = account.claudeUsageUpdatedAt ? new Date(account.claudeUsageUpdatedAt).getTime() : 0
        const isCacheFresh = cachedUsage && lastUpdatedAt && now - lastUpdatedAt < usageCacheTtlMs
        if (isCacheFresh) {
          return {
            accountId: account.id,
            claudeUsage: cachedUsage,
          }
        }

        try {
          const usageData = await claudeAccountService.fetchOAuthUsage(account.id)
          if (usageData) {
            await claudeAccountService.updateClaudeUsageSnapshot(account.id, usageData)
          }
          // 重新读取更新后的数据
          const updatedAccount = await redis.getClaudeAccount(account.id)
          return {
            accountId: account.id,
            claudeUsage: claudeAccountService.buildClaudeUsageSnapshot(updatedAccount),
          }
        } catch (error) {
          logger.debug(`Failed to fetch OAuth usage for ${account.id}:`, error.message)
          return { accountId: account.id, claudeUsage: null }
        }
      }
      // Setup Token 账户不调用 usage API，直接返回 null
      return { accountId: account.id, claudeUsage: null }
    })

    const results = await Promise.allSettled(usagePromises)

    // 转换为 { accountId: usage } 映射
    const usageMap = {}
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value) {
        usageMap[result.value.accountId] = result.value.claudeUsage
      }
    })

    return usageMap
  }),
)

// 创建新的Claude账户
router.post(
  '/claude-accounts',
  authenticateAdmin,
  asyncRoute('Failed to create Claude account', async (req) => {
    const {
      name,
      description,
      email,
      password,
      refreshToken,
      claudeAiOauth,
      proxy,
      accountType,
      platform = 'claude',
      priority,
      groupId,
      groupIds,
      autoStopOnWarning,
      disableAutoProtection,
      useUnifiedUserAgent,
      useUnifiedClientId,
      unifiedClientId,
      expiresAt,
      extInfo,
      maxConcurrency,
      interceptWarmup,
      disableTempUnavailable,
      tempUnavailable503TtlSeconds,
      tempUnavailable5xxTtlSeconds,
    } = parseObjectBody(req.body, '创建Claude账户')

    if (!name) {
      throw badRequest('Name is required')
    }

    // 验证accountType的有效性
    if (accountType && !['shared', 'dedicated', 'group'].includes(accountType)) {
      throw badRequest('Invalid account type. Must be "shared", "dedicated" or "group"')
    }

    // 如果是分组类型，验证groupId或groupIds
    if (accountType === 'group' && !groupId && (!groupIds || groupIds.length === 0)) {
      throw badRequest('Group ID or Group IDs are required for group type accounts')
    }

    // 验证priority的有效性
    if (priority !== undefined && (typeof priority !== 'number' || priority < 1 || priority > 100)) {
      throw badRequest('Priority must be a number between 1 and 100')
    }

    const { normalized: normalizedTempUnavailablePolicy, error: tempUnavailablePolicyError } =
      normalizeTempUnavailablePolicyPayload({
        disableTempUnavailable,
        tempUnavailable503TtlSeconds,
        tempUnavailable5xxTtlSeconds,
      })
    if (tempUnavailablePolicyError) {
      throw badRequest(tempUnavailablePolicyError)
    }

    const newAccount = await claudeAccountService.createAccount({
      name,
      description,
      email,
      password,
      refreshToken,
      claudeAiOauth,
      proxy,
      accountType: accountType || 'shared', // 默认为共享类型
      platform,
      priority: priority || 50, // 默认优先级为50
      autoStopOnWarning: autoStopOnWarning === true, // 默认为false
      disableAutoProtection: disableAutoProtection === true, // 关闭自动防护：默认为false
      useUnifiedUserAgent: useUnifiedUserAgent === true, // 默认为false
      useUnifiedClientId: useUnifiedClientId === true, // 默认为false
      unifiedClientId: unifiedClientId || '', // 统一的客户端标识
      expiresAt: expiresAt || null, // 账户订阅到期时间
      extInfo: extInfo || null,
      maxConcurrency: maxConcurrency || 0, // 账户级串行队列：0=使用全局配置，>0=强制启用
      interceptWarmup: interceptWarmup === true, // 拦截预热请求：默认为false
      disableTempUnavailable: normalizedTempUnavailablePolicy.disableTempUnavailable,
      tempUnavailable503TtlSeconds: normalizedTempUnavailablePolicy.tempUnavailable503TtlSeconds,
      tempUnavailable5xxTtlSeconds: normalizedTempUnavailablePolicy.tempUnavailable5xxTtlSeconds,
    })

    // 如果是分组类型，将账户添加到分组
    if (accountType === 'group') {
      if (groupIds && groupIds.length > 0) {
        // 使用多分组设置
        await accountGroupService.setAccountGroups(newAccount.id, groupIds, newAccount.platform)
      } else if (groupId) {
        // 兼容单分组模式
        await accountGroupService.addAccountToGroup(newAccount.id, groupId, newAccount.platform)
      }
    }

    logger.success(`Admin created new Claude account: ${name} (${accountType || 'shared'})`)
    const formattedAccount = formatAccountExpiry(newAccount)
    return formattedAccount
  }),
)

// 更新Claude账户
router.put(
  '/claude-accounts/:accountId',
  authenticateAdmin,
  asyncRoute('Failed to update Claude account', async (req) => {
    const { accountId } = req.params
    const updates = parseObjectBody(req.body, '更新Claude账户')

    // 【修改】映射字段名：前端的 expiresAt -> 后端的 subscriptionExpiresAt（提前到参数验证之前）
    // review#3：剥离外部传入的状态类字段，禁止伪造自动停用证据
    const mappedUpdates = stripReadonlyAccountFields(mapExpiryField(updates, 'Claude', accountId))

    // 验证priority的有效性
    if (
      mappedUpdates.priority !== undefined &&
      (typeof mappedUpdates.priority !== 'number' || mappedUpdates.priority < 1 || mappedUpdates.priority > 100)
    ) {
      throw badRequest('Priority must be a number between 1 and 100')
    }

    const { normalized: normalizedTempUnavailablePolicy, error: tempUnavailablePolicyError } =
      normalizeTempUnavailablePolicyPayload(mappedUpdates, { partial: true })
    if (tempUnavailablePolicyError) {
      throw badRequest(tempUnavailablePolicyError)
    }
    Object.assign(mappedUpdates, normalizedTempUnavailablePolicy)

    // 验证accountType的有效性
    if (mappedUpdates.accountType && !['shared', 'dedicated', 'group'].includes(mappedUpdates.accountType)) {
      throw badRequest('Invalid account type. Must be "shared", "dedicated" or "group"')
    }

    // 如果更新为分组类型，验证groupId或groupIds
    if (
      mappedUpdates.accountType === 'group' &&
      !mappedUpdates.groupId &&
      (!mappedUpdates.groupIds || mappedUpdates.groupIds.length === 0)
    ) {
      throw badRequest('Group ID or Group IDs are required for group type accounts')
    }

    // 获取账户当前信息以处理分组变更
    const currentAccount = await claudeAccountService.getAccount(accountId)
    if (!currentAccount) {
      throw notFound('Account not found')
    }

    // 处理分组的变更
    if (mappedUpdates.accountType !== undefined) {
      // 如果之前是分组类型，需要从所有分组中移除
      if (currentAccount.accountType === 'group') {
        await accountGroupService.removeAccountFromAllGroups(accountId)
      }

      // 如果新类型是分组，添加到新分组
      if (mappedUpdates.accountType === 'group') {
        // 处理多分组/单分组的兼容性
        if (Object.prototype.hasOwnProperty.call(mappedUpdates, 'groupIds')) {
          if (mappedUpdates.groupIds && mappedUpdates.groupIds.length > 0) {
            // 使用多分组设置
            await accountGroupService.setAccountGroups(accountId, mappedUpdates.groupIds, 'claude')
          } else {
            // groupIds 为空数组，从所有分组中移除
            await accountGroupService.removeAccountFromAllGroups(accountId)
          }
        } else if (mappedUpdates.groupId) {
          // 兼容单分组模式
          await accountGroupService.addAccountToGroup(accountId, mappedUpdates.groupId, 'claude')
        }
      }
    }

    await claudeAccountService.updateAccount(accountId, mappedUpdates)

    logger.success(`Admin updated Claude account: ${accountId}`)
    return ok(undefined, 'Claude account updated successfully')
  }),
)

// 删除Claude账户
router.delete(
  '/claude-accounts/:accountId',
  authenticateAdmin,
  asyncRoute('Failed to delete Claude account', async (req) => {
    const { accountId } = req.params

    // 自动解绑所有绑定的 API Keys
    const unboundCount = await apiKeyService.unbindAccountFromAllKeys(accountId, 'claude')

    // 获取账户信息以检查是否在分组中
    const account = await claudeAccountService.getAccount(accountId)
    if (account && account.accountType === 'group') {
      const groups = await accountGroupService.getAccountGroups(accountId)
      for (const group of groups) {
        await accountGroupService.removeAccountFromGroup(accountId, group.id)
      }
    }

    await claudeAccountService.deleteAccount(accountId)

    let message = 'Claude账号已成功删除'
    if (unboundCount > 0) {
      message += `，${unboundCount} 个 API Key 已切换为共享池模式`
    }

    logger.success(`Admin deleted Claude account: ${accountId}, unbound ${unboundCount} keys`)
    return ok({ unboundKeys: unboundCount }, message)
  }),
)

// 更新单个Claude账户的Profile信息
router.post(
  '/claude-accounts/:accountId/update-profile',
  authenticateAdmin,
  asyncRoute('Failed to update account profile', async (req) => {
    const { accountId } = req.params

    const profileInfo = await claudeAccountService.fetchAndUpdateAccountProfile(accountId)

    logger.success(`Updated profile for Claude account: ${accountId}`)
    return ok(profileInfo, 'Account profile updated successfully')
  }),
)

// 批量更新所有Claude账户的Profile信息
router.post(
  '/claude-accounts/update-all-profiles',
  authenticateAdmin,
  asyncRoute('Failed to update all account profiles', async (_req) => {
    const result = await claudeAccountService.updateAllAccountProfiles()

    logger.success('Batch profile update completed')
    return ok(result, 'Batch profile update completed')
  }),
)

// 刷新Claude账户token
router.post(
  '/claude-accounts/:accountId/refresh',
  authenticateAdmin,
  asyncRoute('Failed to refresh token', async (req) => {
    const { accountId } = req.params

    const result = await claudeAccountService.refreshAccountToken(accountId)

    logger.success(`Admin refreshed token for Claude account: ${accountId}`)
    return result
  }),
)

// 重置Claude账户状态（清除所有异常状态）
router.post(
  '/claude-accounts/:accountId/reset-status',
  authenticateAdmin,
  asyncRoute('Failed to reset status', async (req) => {
    const { accountId } = req.params

    const result = await claudeAccountService.resetAccountStatus(accountId)

    logger.success(`Admin reset status for Claude account: ${accountId}`)
    return result
  }),
)

// 切换Claude账户调度状态
router.put(
  '/claude-accounts/:accountId/toggle-schedulable',
  authenticateAdmin,
  asyncRoute('Failed to toggle schedulable status', async (req) => {
    const { accountId } = req.params

    const accounts = await claudeAccountService.getAllAccounts()
    const account = accounts.find((acc) => acc.id === accountId)

    if (!account) {
      throw notFound('Account not found')
    }

    const newSchedulable = !account.schedulable
    await claudeAccountService.updateAccount(accountId, { schedulable: newSchedulable })

    // 如果账号被禁用，发送webhook通知
    if (!newSchedulable) {
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId: account.id,
        accountName: account.name || account.claudeAiOauth?.email || 'Claude Account',
        platform: 'claude-oauth',
        status: 'disabled',
        errorCode: 'CLAUDE_OAUTH_MANUALLY_DISABLED',
        reason: '账号已被管理员手动禁用调度',
        timestamp: new Date().toISOString(),
      })
    }

    logger.success(
      ` Admin toggled Claude account schedulable status: ${accountId} -> ${
        newSchedulable ? 'schedulable' : 'not schedulable'
      }`,
    )
    return { schedulable: newSchedulable }
  }),
)

// 测试Claude OAuth账户连通性（流式响应）- 复用 claudeRelayService
router.post(
  '/claude-accounts/:accountId/test',
  authenticateAdmin,
  asyncRoute('Failed to test Claude OAuth account', async (req, res) => {
    const { accountId } = req.params

    // 请求显式指定优先，否则用后台配置的默认测试模型（单一事实源）
    const body = parseObjectBody(req.body, '测试Claude账户')
    const model = await testModelConfigService.resolveAccountModel('claude', body.model)
    await claudeRelayService.testAccountConnection(accountId, res, model)
    return SEND_RAW
  }),
)

// ===
// 账户定时测试相关端点
// ===

// 获取账户测试历史
router.get(
  '/claude-accounts/:accountId/test-history',
  authenticateAdmin,
  asyncRoute('Failed to get test history', async (req) => {
    const { accountId } = req.params

    const history = await redis.getAccountTestHistory(accountId, 'claude')
    return {
      accountId,
      platform: 'claude',
      history,
    }
  }),
)

// 获取账户定时测试配置
router.get(
  '/claude-accounts/:accountId/test-config',
  authenticateAdmin,
  asyncRoute('Failed to get test config', async (req) => {
    const { accountId } = req.params

    const testConfig = await redis.getAccountTestConfig(accountId, 'claude')
    const config = testConfig || { enabled: false, cronExpression: '0 8 * * *' }
    // 模型缺省时回退后台"测试模型"全局配置（单一事实源），兼容历史无 model 记录
    config.model = await testModelConfigService.resolveAccountModel('claude', config.model)
    return {
      accountId,
      platform: 'claude',
      config,
    }
  }),
)

// 设置账户定时测试配置
router.put(
  '/claude-accounts/:accountId/test-config',
  authenticateAdmin,
  asyncRoute('Failed to update test config', async (req) => {
    const { accountId } = req.params
    const { enabled, cronExpression, model } = parseObjectBody(req.body, '更新Claude测试配置')

    // 验证 enabled 参数
    if (typeof enabled !== 'boolean') {
      throw badRequest('enabled must be a boolean')
    }

    // 验证 cronExpression 参数
    if (!cronExpression || typeof cronExpression !== 'string') {
      throw badRequest('cronExpression is required and must be a string')
    }

    // 限制 cronExpression 长度防止 DoS
    const MAX_CRON_LENGTH = 100
    if (cronExpression.length > MAX_CRON_LENGTH) {
      throw badRequest(`cronExpression too long (max ${MAX_CRON_LENGTH} characters)`)
    }

    // 使用 service 的方法验证 cron 表达式
    if (!accountTestSchedulerService.validateCronExpression(cronExpression)) {
      throw badRequest(
        `Invalid cron expression: ${cronExpression}. Format: "minute hour day month weekday" (e.g., "0 8 * * *" for daily at 8:00)`,
      )
    }

    // 验证模型参数（未传时回退后台"测试模型"全局配置，单一事实源）
    const testModel = await testModelConfigService.resolveAccountModel('claude', model)
    if (typeof testModel !== 'string' || testModel.length > 256) {
      throw badRequest('model must be a valid string (max 256 characters)')
    }

    // 检查账户是否存在
    const account = await claudeAccountService.getAccount(accountId)
    if (!account) {
      throw notFound(`Claude account ${accountId} not found`)
    }

    // 保存配置
    await redis.saveAccountTestConfig(accountId, 'claude', {
      enabled,
      cronExpression,
      model: testModel,
    })

    logger.success(
      ` Updated test config for Claude account ${accountId}: enabled=${enabled}, cronExpression=${cronExpression}, model=${testModel}`,
    )

    return ok(
      {
        accountId,
        platform: 'claude',
        config: { enabled, cronExpression, model: testModel },
      },
      'Test config updated successfully',
    )
  }),
)

// 手动触发账户测试（非流式，返回JSON结果）
router.post(
  '/claude-accounts/:accountId/test-sync',
  authenticateAdmin,
  asyncRoute('Failed to run test', async (req) => {
    const { accountId } = req.params

    // 检查账户是否存在
    const account = await claudeAccountService.getAccount(accountId)
    if (!account) {
      throw notFound(`Claude account ${accountId} not found`)
    }

    logger.info(`Manual sync test triggered for Claude account: ${accountId}`)

    // 执行测试（请求显式指定优先，否则用后台配置默认）
    const body = parseObjectBody(req.body, '同步测试Claude账户')
    const model = await testModelConfigService.resolveAccountModel('claude', body.model)
    const testResult = await claudeRelayService.testAccountConnectionSync(accountId, model)

    // 保存测试结果到历史
    await redis.saveAccountTestResult(accountId, 'claude', testResult)
    await redis.setAccountLastTestTime(accountId, 'claude')

    return {
      accountId,
      platform: 'claude',
      result: testResult,
    }
  }),
)

// 批量获取多个账户的测试历史
router.post(
  '/claude-accounts/batch-test-history',
  authenticateAdmin,
  asyncRoute('Failed to get batch test history', async (req) => {
    const { accountIds } = parseObjectBody(req.body, '批量测试历史查询')

    if (!Array.isArray(accountIds) || accountIds.length === 0) {
      throw badRequest('accountIds must be a non-empty array')
    }

    // 限制批量查询数量
    const limitedIds = accountIds.slice(0, 100)

    const accounts = limitedIds.map((accountId) => ({
      accountId,
      platform: 'claude',
    }))

    const historyMap = await redis.getAccountsTestHistory(accounts)

    return historyMap
  }),
)
