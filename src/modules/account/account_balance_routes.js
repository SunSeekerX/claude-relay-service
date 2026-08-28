import express from 'express'

import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { logger } from '../../common/logger.js'
import { accountBalanceService } from './account_balance_service.js'
import { balanceScriptService } from '../payment/payment_balance_script_service.js'
import { isBalanceScriptEnabled } from '../../common/feature_flags.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, badRequest, notFound, forbidden } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'

export const router = express.Router()

const ensureValidPlatform = (rawPlatform) => {
  const normalized = accountBalanceService.normalizePlatform(rawPlatform)
  if (!normalized) {
    throw badRequest('缺少 platform 参数')
  }

  const supported = accountBalanceService.getSupportedPlatforms()
  if (!supported.includes(normalized)) {
    throw badRequest(`不支持的平台: ${normalized}`)
  }

  return normalized
}

// 1) 获取账户余额（默认本地统计优先，可选触发 Provider）
// GET /admin/accounts/:accountId/balance?platform=xxx&queryApi=false
router.get(
  '/accounts/:accountId/balance',
  authenticateAdmin,
  asyncRoute('获取账户余额失败', async (req) => {
    const { accountId } = req.params
    const { platform, queryApi } = req.query

    const validPlatform = ensureValidPlatform(platform)

    const balance = await accountBalanceService.getAccountBalance(accountId, validPlatform, {
      queryApi,
    })

    if (!balance) {
      throw notFound('Account not found')
    }

    return balance
  }),
)

// 2) 强制刷新账户余额（强制触发查询：优先脚本；Provider 仅为降级）
// POST /admin/accounts/:accountId/balance/refresh
// Body: { platform: 'xxx' }
router.post(
  '/accounts/:accountId/balance/refresh',
  authenticateAdmin,
  asyncRoute('刷新账户余额失败', async (req) => {
    const { accountId } = req.params
    const { platform } = parseObjectBody(req.body, '刷新账户余额')

    const validPlatform = ensureValidPlatform(platform)

    logger.info(`手动刷新余额: ${validPlatform}:${accountId}`)

    const balance = await accountBalanceService.refreshAccountBalance(accountId, validPlatform)
    if (!balance) {
      throw notFound('Account not found')
    }

    return balance
  }),
)

// 3) 批量获取平台所有账户余额
// GET /admin/accounts/balance/platform/:platform?queryApi=false
router.get(
  '/accounts/balance/platform/:platform',
  authenticateAdmin,
  asyncRoute('批量获取余额失败', async (req) => {
    const { platform } = req.params
    const { queryApi } = req.query

    const validPlatform = ensureValidPlatform(platform)

    return accountBalanceService.getAllAccountsBalance(validPlatform, { queryApi })
  }),
)

// 4) 获取余额汇总（Dashboard 用）
// GET /admin/accounts/balance/summary
router.get(
  '/accounts/balance/summary',
  authenticateAdmin,
  asyncRoute('获取余额汇总失败', async () => accountBalanceService.getBalanceSummary()),
)

// 5) 清除缓存
// DELETE /admin/accounts/:accountId/balance/cache?platform=xxx
router.delete(
  '/accounts/:accountId/balance/cache',
  authenticateAdmin,
  asyncRoute('清除缓存失败', async (req) => {
    const { accountId } = req.params
    const { platform } = req.query

    const validPlatform = ensureValidPlatform(platform)

    await accountBalanceService.clearCache(accountId, validPlatform)

    return ok(undefined, '缓存已清除')
  }),
)

// 6) 获取/保存/测试余额脚本配置（单账户）
router.get(
  '/accounts/:accountId/balance/script',
  authenticateAdmin,
  asyncRoute('获取余额脚本配置失败', async (req) => {
    const { accountId } = req.params
    const { platform } = req.query

    const validPlatform = ensureValidPlatform(platform)

    const config = await accountBalanceService.redis.getBalanceScriptConfig(validPlatform, accountId)
    return config || null
  }),
)

router.put(
  '/accounts/:accountId/balance/script',
  authenticateAdmin,
  asyncRoute('保存余额脚本配置失败', async (req) => {
    const { accountId } = req.params
    const { platform } = req.query
    const validPlatform = ensureValidPlatform(platform)

    const payload = parseObjectBody(req.body, '保存余额脚本配置')
    await accountBalanceService.redis.setBalanceScriptConfig(validPlatform, accountId, payload)
    return payload
  }),
)

router.post(
  '/accounts/:accountId/balance/script/test',
  authenticateAdmin,
  asyncRoute('测试余额脚本失败', async (req) => {
    const { accountId } = req.params
    const { platform } = req.query
    const validPlatform = ensureValidPlatform(platform)

    if (!isBalanceScriptEnabled()) {
      throw forbidden('余额脚本功能已禁用（可通过 BALANCE_SCRIPT_ENABLED=true 启用）')
    }

    const payload = parseObjectBody(req.body, '测试余额脚本')
    const { scriptBody } = payload
    if (!scriptBody) {
      throw badRequest('脚本内容不能为空')
    }

    try {
      return await balanceScriptService.execute({
        scriptBody,
        timeoutSeconds: payload.timeoutSeconds || 10,
        variables: {
          baseUrl: payload.baseUrl || '',
          apiKey: payload.apiKey || '',
          token: payload.token || '',
          accountId,
          platform: validPlatform,
          extra: payload.extra || '',
        },
      })
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)
