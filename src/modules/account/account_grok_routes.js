import express from 'express'
import axios from 'axios'

import { grokAccountService } from './account_grok_service.js'
import { testModelConfigService } from '../relay/relay_test_model_config_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { accountGroupService } from './account_group_service.js'
import { redis } from '../../infra/redis.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { stripReadonlyAccountFields } from '../../common/common_helper.js'
import { extractErrorMessage } from '../../common/test_payload_helper.js'
import { ProxyHelper } from '../proxy/proxy_helper.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import * as xaiHelper from '../../common/xai_helper.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, badRequest, notFound, fail } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'
/**
 * Admin Routes - Grok / xAI 账户管理
 */

export const router = express.Router()

// 生成 OAuth 授权 URL
router.post(
  '/grok-accounts/generate-auth-url',
  authenticateAdmin,
  asyncRoute('Failed to generate Grok OAuth URL', async (req) => {
    const { proxy, proxyGroupId, proxyId, redirectUri } = parseObjectBody(req.body, '生成Grok授权URL')
    // 绑池 fail-closed：有池绑定必须走 resolveAuthProxy
    const effectiveProxy = proxyResolver.resolveAuthProxy({ proxyGroupId, proxyId, platform: 'grok' }, 'grok', proxy)
    return grokAccountService.generateAuthUrl({
      proxy: effectiveProxy,
      redirectUri,
      proxyBound: !!(proxyGroupId || proxyId),
    })
  }),
)

// 用 code 换 token（不创建账户）
router.post(
  '/grok-accounts/exchange-code',
  authenticateAdmin,
  asyncRoute('Failed to exchange Grok OAuth code', async (req) => {
    const { sessionId, code, state, redirectUri, proxy, proxyGroupId, proxyId } = parseObjectBody(
      req.body,
      'Grok授权码交换',
    )
    if (!sessionId || !code) {
      throw badRequest('sessionId and code are required')
    }
    // exchange 阶段优先用 session 里存的授权代理；若调用方仍传池绑定则再解析
    let effectiveProxy = proxy || null
    if (proxyGroupId || proxyId) {
      effectiveProxy = proxyResolver.resolveAuthProxy({ proxyGroupId, proxyId, platform: 'grok' }, 'grok', proxy)
    }
    try {
      const tokenInfo = await grokAccountService.exchangeCode({
        sessionId,
        code,
        state,
        redirectUri,
        proxy: effectiveProxy,
      })
      return {
        ...tokenInfo,
        accessToken: tokenInfo.accessToken,
        refreshToken: tokenInfo.refreshToken,
      }
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// OAuth 一键创建账户
router.post(
  '/grok-accounts/create-from-oauth',
  authenticateAdmin,
  asyncRoute('Failed to create Grok account from OAuth', async (req) => {
    try {
      return await grokAccountService.createAccountFromOAuth(parseObjectBody(req.body, '从OAuth创建Grok账户'))
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// 列表
router.get(
  '/grok-accounts',
  authenticateAdmin,
  asyncRoute('Failed to list Grok accounts', async (req) => {
    const { groupId } = req.query
    let accounts = await grokAccountService.getAllAccounts(true)

    if (groupId) {
      const group = await accountGroupService.getGroup(groupId)
      if (group && group.platform === 'grok') {
        const members = await accountGroupService.getGroupMembers(groupId)
        accounts = accounts.filter((account) => members.includes(account.id))
      } else {
        accounts = []
      }
    }

    const accountIds = accounts.map((account) => account.id)
    await Promise.all(accountIds.map((id) => grokAccountService.checkAndClearRateLimit(id)))

    // 重新拉一次清限流后的列表（轻量：仅列表字段）
    accounts = await grokAccountService.getAllAccounts(true)
    if (groupId) {
      const group = await accountGroupService.getGroup(groupId)
      if (group && group.platform === 'grok') {
        const members = await accountGroupService.getGroupMembers(groupId)
        accounts = accounts.filter((account) => members.includes(account.id))
      } else {
        accounts = []
      }
    }

    const [allApiKeys, allGroupInfosMap, dailyCostMap] = await Promise.all([
      apiKeyService.getAllApiKeysLite(),
      accountGroupService.batchGetAccountGroupsByIndex
        ? accountGroupService.batchGetAccountGroupsByIndex(accountIds, 'grok')
        : Promise.resolve(new Map()),
      redis.batchGetAccountDailyCost ? redis.batchGetAccountDailyCost(accountIds) : Promise.resolve(new Map()),
    ])

    const bindingCountMap = new Map()
    for (const key of allApiKeys) {
      const binding = key.grokAccountId
      if (!binding || String(binding).startsWith('group:')) {
        continue
      }
      bindingCountMap.set(binding, (bindingCountMap.get(binding) || 0) + 1)
    }

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

    return accounts.map((account, index) => {
      const [errTotal, total] = statsResults[index * 3] || []
      const [errDaily, daily] = statsResults[index * 3 + 1] || []
      const [errMonthly, monthly] = statsResults[index * 3 + 2] || []
      const parseUsage = (data) => ({
        requests: parseInt(data?.totalRequests || data?.requests) || 0,
        tokens: parseInt(data?.totalTokens || data?.tokens) || 0,
        allTokens: parseInt(data?.totalAllTokens || data?.allTokens) || 0,
      })
      return {
        ...account,
        groupInfos: allGroupInfosMap?.get?.(account.id) || [],
        boundApiKeyCount: bindingCountMap.get(account.id) || 0,
        dailyCost: dailyCostMap?.get?.(account.id) || 0,
        usage: {
          total: errTotal ? {} : parseUsage(total),
          daily: errDaily ? {} : parseUsage(daily),
          monthly: errMonthly ? {} : parseUsage(monthly),
        },
      }
    })
  }),
)

// 创建（API Key 或已有 token）
router.post(
  '/grok-accounts',
  authenticateAdmin,
  asyncRoute('Failed to create Grok account', async (req) => {
    try {
      const body = stripReadonlyAccountFields(parseObjectBody(req.body, '创建Grok账户'))
      return await grokAccountService.createAccount(body)
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// 详情
router.get(
  '/grok-accounts/:id',
  authenticateAdmin,
  asyncRoute('Failed to get Grok account', async (req) => {
    const account = await grokAccountService.getAccount(req.params.id, { decryptSecrets: false })
    if (!account) {
      throw notFound('Account not found')
    }
    return {
      ...account,
      accessToken: account.accessToken ? '***' : '',
      refreshToken: account.refreshToken ? '***' : '',
      apiKey: account.apiKey ? '***' : '',
      idToken: account.idToken ? '***' : '',
    }
  }),
)

// 更新
router.put(
  '/grok-accounts/:id',
  authenticateAdmin,
  asyncRoute('Failed to update Grok account', async (req) => {
    try {
      const updates = stripReadonlyAccountFields(parseObjectBody(req.body, '更新Grok账户'))
      // 前端可能传 *** 表示不改
      for (const field of ['accessToken', 'refreshToken', 'apiKey', 'idToken']) {
        if (updates[field] === '***' || updates[field] === '') {
          delete updates[field]
        }
      }
      await grokAccountService.updateAccount(req.params.id, updates)
      return ok()
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// 删除
router.delete(
  '/grok-accounts/:id',
  authenticateAdmin,
  asyncRoute('Failed to delete Grok account', async (req) => {
    await grokAccountService.deleteAccount(req.params.id)
    return ok()
  }),
)

// 切换调度
router.put(
  '/grok-accounts/:id/toggle-schedulable',
  authenticateAdmin,
  asyncRoute('Failed to toggle Grok schedulable', async (req) => {
    try {
      return await grokAccountService.toggleSchedulable(req.params.id)
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// 刷新 token
router.post(
  '/grok-accounts/:id/refresh-token',
  authenticateAdmin,
  asyncRoute('Failed to refresh Grok token', async (req) => {
    try {
      const account = await grokAccountService.refreshAccountToken(req.params.id)
      return {
        id: account.id,
        expiresAt: account.expiresAt,
        lastRefresh: account.lastRefresh,
        status: account.status,
      }
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// 重置状态
router.post(
  '/grok-accounts/:id/reset-status',
  authenticateAdmin,
  asyncRoute('Failed to reset Grok status', async (req) => {
    try {
      await grokAccountService.resetAccountStatus(req.params.id)
      return ok()
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// 配额探测
router.get(
  '/grok-accounts/:id/quota',
  authenticateAdmin,
  asyncRoute('Failed to query Grok quota', async (req) => {
    try {
      return await grokAccountService.queryQuota(req.params.id)
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// runtime sanity
router.get(
  '/grok/runtime-sanity',
  authenticateAdmin,
  asyncRoute('Failed to run Grok sanity check', async () => grokAccountService.runtimeSanity()),
)

// SSO cookie 批量导入
router.post(
  '/grok-accounts/sso-to-oauth',
  authenticateAdmin,
  asyncRoute('Failed Grok SSO import', async (req) => {
    try {
      const body = parseObjectBody(req.body, 'Grok SSO导入')
      return await grokAccountService.createAccountsFromSSO({
        ssoTokens: body.sso_tokens || body.ssoTokens || [],
        ssoToken: body.sso_token || body.ssoToken || '',
        proxy: body.proxy || null,
        proxyGroupId: body.proxyGroupId || body.proxy_group_id || '',
        proxyId: body.proxyId || body.proxy_id || '',
        name: body.name || '',
        priority: body.priority,
        groupId: body.groupId || body.group_id || '',
        baseUrl: body.baseUrl || body.base_url || '',
      })
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// OAuth 批量对账
router.post(
  '/grok/oauth/reconcile',
  authenticateAdmin,
  asyncRoute('Grok reconcile failed', async (req) => {
    try {
      const body = parseObjectBody(req.body, 'Grok OAuth对账')
      return await grokAccountService.reconcileOAuthAccounts({
        mode: body.mode || (body.apply === true ? 'apply' : 'dry_run'),
        limit: body.limit,
        nearExpiryMinutes: body.nearExpiryMinutes || body.near_expiry_minutes,
      })
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// 媒体资格探测
router.get(
  '/grok-accounts/:id/media-eligibility',
  authenticateAdmin,
  asyncRoute('Failed to probe media eligibility', async (req) => {
    try {
      const result = await grokAccountService.ensureMediaEligible(req.params.id)
      return {
        eligible: result.eligible,
        reason: result.reason,
        planType: result.account?.planType || '',
        subscriptionTiers: result.account?.subscriptionTiers || '',
      }
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// 连通性测试
router.post(
  '/grok-accounts/:accountId/test',
  authenticateAdmin,
  asyncRoute('Grok account test failed', async (req) => {
    const { accountId } = req.params
    const account = await grokAccountService.ensureFreshToken(accountId)
    if (!account) {
      throw notFound('Account not found')
    }

    const body = parseObjectBody(req.body, '测试Grok账户')
    const model = body.model || (await testModelConfigService.resolveAccountModel?.('grok', body.model)) || 'grok-4.5'
    const mappedModel = xaiHelper.mapModel(model)
    const token = account.authType === 'apikey' ? account.apiKey : account.accessToken
    if (!token) {
      throw badRequest('No credential available')
    }

    const url = xaiHelper.buildChatCompletionsUrl(grokAccountService.getUpstreamBaseUrl(account))
    const agent = account.proxy ? ProxyHelper.createProxyAgent(account.proxy) : null
    const started = Date.now()
    const response = await axios.post(
      url,
      {
        model: mappedModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(account.authType === 'oauth' ? xaiHelper.buildCliIdentityHeaders() : {}),
        },
        timeout: 30000,
        httpAgent: agent || undefined,
        httpsAgent: agent || undefined,
        proxy: false,
        validateStatus: () => true,
      },
    )

    const latencyMs = Date.now() - started
    if (response.status >= 200 && response.status < 300) {
      return {
        ok: true,
        status: response.status,
        latencyMs,
        model: mappedModel,
      }
    }

    return fail(400, extractErrorMessage(response.data) || `status ${response.status}`, {
      data: { status: response.status, latencyMs, model: mappedModel },
    })
  }),
)
