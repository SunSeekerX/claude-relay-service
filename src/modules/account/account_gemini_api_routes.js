import express from 'express'
import axios from 'axios'

import { geminiApiAccountService } from './account_gemini_api_service.js'
import { testModelConfigService } from '../relay/relay_test_model_config_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { accountGroupService } from './account_group_service.js'
import { redis } from '../../infra/redis.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute, SEND_RAW } from '../../common/route_handler.js'
import { ok, badRequest, notFound, unauthorized } from '../../common/http_result.js'
import { logger } from '../../common/logger.js'
import { webhookNotifier } from '../webhook/webhook_notifier.js'
import { stripReadonlyAccountFields } from '../../common/common_helper.js'
import { createGeminiTestPayload, extractErrorMessage } from '../../common/test_payload_helper.js'
import { parseObjectBody } from '../../common/parse_body.js'
import { buildGeminiApiUrl } from '../relay/relay_gemini_handlers_routes.js'
import { ProxyHelper } from '../proxy/proxy_helper.js'

export const router = express.Router()

// 获取所有 Gemini-API 账户
router.get(
  '/gemini-api-accounts',
  authenticateAdmin,
  asyncRoute('Failed to get Gemini-API accounts', async (req) => {
    const { platform, groupId } = req.query
    let accounts = await geminiApiAccountService.getAllAccounts(true)

    // 根据查询参数进行筛选
    if (platform && platform !== 'gemini-api') {
      accounts = []
    }

    // 根据分组ID筛选
    if (groupId) {
      const group = await accountGroupService.getGroup(groupId)
      if (group && group.platform === 'gemini') {
        const groupMembers = await accountGroupService.getGroupMembers(groupId)
        accounts = accounts.filter((account) => groupMembers.includes(account.id))
      } else {
        accounts = []
      }
    }

    const accountIds = accounts.map((a) => a.id)

    const [allGroupInfosMap, dailyCostMap] = await Promise.all([
      accountGroupService.batchGetAccountGroupsByIndex(accountIds, 'gemini'),
      redis.batchGetAccountDailyCost(accountIds),
    ])

    // 批量获取使用统计
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

    // 处理账户数据
    return accounts.map((account) => {
      const groupInfos = allGroupInfosMap.get(account.id) || []
      const usageStats = allUsageStatsMap.get(account.id) || {
        daily: { requests: 0, tokens: 0, allTokens: 0 },
        total: { requests: 0, tokens: 0, allTokens: 0 },
        monthly: { requests: 0, tokens: 0, allTokens: 0 },
      }
      const dailyCost = dailyCostMap.get(account.id) || 0
      // DEC_20260907_115439 列表不扫全库 Key；绑定数由 SPA binding-counts 覆盖
      const boundCount = 0

      // 计算 averages（rpm/tpm）
      const createdAt = account.createdAt ? new Date(account.createdAt) : new Date()
      const daysSinceCreated = Math.max(1, Math.ceil((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)))
      const totalMinutes = daysSinceCreated * 24 * 60
      const totalRequests = usageStats.total.requests || 0
      const totalTokens = usageStats.total.tokens || usageStats.total.allTokens || 0

      return {
        ...account,
        groupInfos,
        usage: {
          daily: { ...usageStats.daily, cost: dailyCost },
          total: usageStats.total,
          averages: {
            rpm: Math.round((totalRequests / totalMinutes) * 100) / 100,
            tpm: Math.round((totalTokens / totalMinutes) * 100) / 100,
          },
        },
        boundApiKeys: boundCount,
      }
    })
  }),
)

// 创建 Gemini-API 账户
router.post(
  '/gemini-api-accounts',
  authenticateAdmin,
  asyncRoute('Failed to create Gemini-API account', async (req) => {
    const body = parseObjectBody(req.body, '创建Gemini-API账户')
    const { accountType, groupId, groupIds } = body

    // 验证accountType的有效性
    if (accountType && !['shared', 'dedicated', 'group'].includes(accountType)) {
      throw badRequest('Invalid account type. Must be "shared", "dedicated" or "group"')
    }

    // 如果是分组类型，验证groupId或groupIds
    if (accountType === 'group' && !groupId && (!groupIds || groupIds.length === 0)) {
      throw badRequest('Group ID or Group IDs are required for group type accounts')
    }

    const account = await geminiApiAccountService.createAccount(body)

    // 如果是分组类型，将账户添加到分组
    if (accountType === 'group') {
      if (groupIds && groupIds.length > 0) {
        // 使用多分组设置
        await accountGroupService.setAccountGroups(account.id, groupIds, 'gemini')
      } else if (groupId) {
        // 兼容单分组模式
        await accountGroupService.addAccountToGroup(account.id, groupId, 'gemini')
      }
    }

    logger.success(`Admin created new Gemini-API account: ${account.name} (${accountType || 'shared'})`)

    return account
  }),
)

// 获取单个 Gemini-API 账户
router.get(
  '/gemini-api-accounts/:id',
  authenticateAdmin,
  asyncRoute('Failed to get Gemini-API account', async (req) => {
    const { id } = req.params
    const account = await geminiApiAccountService.getAccount(id)

    if (!account) {
      throw notFound('Account not found')
    }

    // 隐藏敏感信息
    account.apiKey = '***'

    return account
  }),
)

// 更新 Gemini-API 账户
router.put(
  '/gemini-api-accounts/:id',
  authenticateAdmin,
  asyncRoute('Failed to update Gemini-API account', async (req) => {
    const { id } = req.params
    // review#3：剥离外部传入的状态类字段，禁止伪造自动停用证据
    const updates = stripReadonlyAccountFields(parseObjectBody(req.body, '更新Gemini-API账户'))

    // 验证priority的有效性（1-100）
    if (updates.priority !== undefined) {
      const priority = parseInt(updates.priority)
      if (isNaN(priority) || priority < 1 || priority > 100) {
        throw badRequest('Priority must be a number between 1 and 100')
      }
    }

    // 验证accountType的有效性
    if (updates.accountType && !['shared', 'dedicated', 'group'].includes(updates.accountType)) {
      throw badRequest('Invalid account type. Must be "shared", "dedicated" or "group"')
    }

    // 如果更新为分组类型，验证groupId或groupIds
    if (updates.accountType === 'group' && !updates.groupId && (!updates.groupIds || updates.groupIds.length === 0)) {
      throw badRequest('Group ID or Group IDs are required for group type accounts')
    }

    // 获取账户当前信息以处理分组变更
    const currentAccount = await geminiApiAccountService.getAccount(id)
    if (!currentAccount) {
      throw notFound('Account not found')
    }

    // 处理分组的变更
    if (updates.accountType !== undefined) {
      // 如果之前是分组类型，需要从所有分组中移除
      if (currentAccount.accountType === 'group') {
        await accountGroupService.removeAccountFromAllGroups(id)
      }

      // 如果新类型是分组，添加到新分组
      if (updates.accountType === 'group') {
        // 处理多分组/单分组的兼容性
        if (Object.prototype.hasOwnProperty.call(updates, 'groupIds')) {
          if (updates.groupIds && updates.groupIds.length > 0) {
            // 使用多分组设置
            await accountGroupService.setAccountGroups(id, updates.groupIds, 'gemini')
          }
        } else if (updates.groupId) {
          // 兼容单分组模式
          await accountGroupService.addAccountToGroup(id, updates.groupId, 'gemini')
        }
      }
    }

    const result = await geminiApiAccountService.updateAccount(id, updates)

    if (!result.success) {
      throw badRequest(result.error || result.message || 'Update failed')
    }

    logger.success(`Admin updated Gemini-API account: ${currentAccount.name}`)

    const { success: _success, ...rest } = result
    return rest
  }),
)

// 删除 Gemini-API 账户
router.delete(
  '/gemini-api-accounts/:id',
  authenticateAdmin,
  asyncRoute('Failed to delete Gemini-API account', async (req) => {
    const { id } = req.params

    const account = await geminiApiAccountService.getAccount(id)
    if (!account) {
      throw notFound('Account not found')
    }

    // 自动解绑所有绑定的 API Keys（支持 api: 前缀）
    const unboundCount = await apiKeyService.unbindAccountFromAllKeys(id, 'gemini-api')

    // 从所有分组中移除此账户
    if (account.accountType === 'group') {
      await accountGroupService.removeAccountFromAllGroups(id)
      logger.info(`Removed Gemini-API account ${id} from all groups`)
    }

    const result = await geminiApiAccountService.deleteAccount(id)

    let message = 'Gemini-API账号已成功删除'
    if (unboundCount > 0) {
      message += `，${unboundCount} 个 API Key 已切换为共享池模式`
    }

    logger.success(`${message}`)

    const { success: _success, ...rest } = result || {}
    return ok({ ...rest, unboundKeys: unboundCount }, message)
  }),
)

// 切换 Gemini-API 账户调度状态
router.put(
  '/gemini-api-accounts/:id/toggle-schedulable',
  authenticateAdmin,
  asyncRoute('Failed to toggle Gemini-API account schedulable status', async (req) => {
    const { id } = req.params

    const result = await geminiApiAccountService.toggleSchedulable(id)

    if (!result.success) {
      throw badRequest(result.error || result.message || 'Toggle schedulable failed')
    }

    // 仅在停止调度时发送通知
    if (!result.schedulable) {
      await webhookNotifier.sendAccountEvent('account.status_changed', {
        accountId: id,
        platform: 'gemini-api',
        schedulable: result.schedulable,
        changedBy: 'admin',
        action: 'stopped_scheduling',
      })
    }

    return { schedulable: result.schedulable }
  }),
)

// 切换 Gemini-API 账户激活状态
router.put(
  '/gemini-api-accounts/:id/toggle',
  authenticateAdmin,
  asyncRoute('Failed to toggle Gemini-API account status', async (req) => {
    const { id } = req.params

    const account = await geminiApiAccountService.getAccount(id)
    if (!account) {
      throw notFound('Account not found')
    }

    const newActiveStatus = account.isActive === 'true' ? 'false' : 'true'
    await geminiApiAccountService.updateAccount(id, {
      isActive: newActiveStatus,
    })

    return {
      isActive: newActiveStatus === 'true',
    }
  }),
)

// 重置 Gemini-API 账户限流状态
router.post(
  '/gemini-api-accounts/:id/reset-rate-limit',
  authenticateAdmin,
  asyncRoute('Failed to reset Gemini-API account rate limit', async (req) => {
    const { id } = req.params

    await geminiApiAccountService.updateAccount(id, {
      rateLimitedAt: '',
      rateLimitStatus: '',
      status: 'active',
      errorMessage: '',
    })

    logger.info(`Admin manually reset rate limit for Gemini-API account ${id}`)

    return ok(undefined, 'Rate limit reset successfully')
  }),
)

// 重置 Gemini-API 账户状态（清除所有异常状态）
router.post(
  '/gemini-api-accounts/:id/reset-status',
  authenticateAdmin,
  asyncRoute('Failed to reset Gemini-API account status', async (req) => {
    const { id } = req.params

    const result = await geminiApiAccountService.resetAccountStatus(id)

    logger.success(`Admin reset status for Gemini-API account: ${id}`)
    return result
  }),
)

// 测试 Gemini-API 账户连通性（SSE 流式）
const ALLOWED_MAX_TOKENS = [100, 500, 1000, 2000, 4096]
const sanitizeMaxTokens = (value) => (ALLOWED_MAX_TOKENS.includes(Number(value)) ? Number(value) : 500)

router.post(
  '/gemini-api-accounts/:accountId/test',
  authenticateAdmin,
  asyncRoute('Gemini-API account test failed', async (req, res) => {
    const { accountId } = req.params
    const body = parseObjectBody(req.body, '测试Gemini-API账户')
    const { prompt = 'hi' } = body
    const maxTokens = sanitizeMaxTokens(body.maxTokens)

    const abortController = new AbortController()
    res.on('close', () => abortController.abort())

    const safeWrite = (data) => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(data)
      }
    }
    const safeEnd = () => {
      if (!res.writableEnded && !res.destroyed) {
        res.end()
      }
    }

    // 请求显式指定优先，否则用后台配置的默认测试模型（单一事实源）
    const model = await testModelConfigService.resolveAccountModel('gemini-api', body.model)
    const account = await geminiApiAccountService.getAccount(accountId)
    if (!account) {
      throw notFound('Account not found')
    }
    if (!account.apiKey) {
      throw unauthorized('API Key not found or decryption failed')
    }

    const baseUrl = account.baseUrl || 'https://generativelanguage.googleapis.com'
    const apiUrl = buildGeminiApiUrl(baseUrl, model, 'streamGenerateContent', account.apiKey, {
      stream: true,
    })

    // 设置 SSE 响应头
    if (res.writableEnded || res.destroyed) {
      return SEND_RAW
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    safeWrite(`data: ${JSON.stringify({ type: 'test_start', message: 'Test started' })}\n\n`)

    const payload = createGeminiTestPayload(model, { prompt, maxTokens })
    const requestConfig = {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
      responseType: 'stream',
      validateStatus: () => true,
      signal: abortController.signal,
    }

    // 配置代理
    if (account.proxy) {
      const agent = ProxyHelper.createProxyAgent(account.proxy)
      if (agent) {
        requestConfig.httpsAgent = agent
        requestConfig.httpAgent = agent
      }
    }

    try {
      const response = await axios.post(apiUrl, payload, requestConfig)

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
            if (errorData.length < 500) {
              errorMsg = errorData || errorMsg
            }
          }
          safeWrite(`data: ${JSON.stringify({ type: 'test_complete', success: false, error: errorMsg })}\n\n`)
          safeEnd()
        })
        response.data.on('error', () => {
          safeWrite(
            `data: ${JSON.stringify({ type: 'test_complete', success: false, error: `API Error: ${response.status}` })}\n\n`,
          )
          safeEnd()
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
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text
            if (text) {
              safeWrite(`data: ${JSON.stringify({ type: 'content', text })}\n\n`)
            }
          } catch {
            // ignore parse errors
          }
        }
      })

      response.data.on('end', () => {
        safeWrite(`data: ${JSON.stringify({ type: 'test_complete', success: true })}\n\n`)
        safeEnd()
      })

      response.data.on('error', (err) => {
        safeWrite(`data: ${JSON.stringify({ type: 'test_complete', success: false, error: err.message })}\n\n`)
        safeEnd()
      })
    } catch (axiosError) {
      if (axiosError.name === 'CanceledError') {
        return SEND_RAW
      }
      safeWrite(`data: ${JSON.stringify({ type: 'test_complete', success: false, error: axiosError.message })}\n\n`)
      safeEnd()
    }

    return SEND_RAW
  }),
)
