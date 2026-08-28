import { apiKeyService } from '../modules/apikey/apikey_service.js'
import { redis } from '../infra/redis.js'
import { logger } from './logger.js'
import { ClientValidator } from './validator_client_validator.js'
import { balanceLedger } from '../modules/payment/payment_balance_ledger.js'
import * as groupPolicy from '../modules/account/account_group_policy.js'
import crypto from 'node:crypto'
import { env } from '../../config/env.js'
// WebSocket / HTTP Upgrade 鉴权：对齐 authenticateApiKey 的硬门（无 Express 排队）
// - validateApiKey.valid
// - 客户端限制
// - 服务权限
// - 预付费余额 / 日总额度
// - 并发槽 + 租约续期（长连接必须续租，否则 300s 后槽位过期可被突破）

export const extractBearerOrQueryKey = (req, url) => {
  const authHeader = req.headers.authorization || req.headers.Authorization || ''
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim()
    if (token) {
      return token
    }
  }
  if (url && url.searchParams) {
    return url.searchParams.get('api_key') || url.searchParams.get('key') || url.searchParams.get('access_token') || ''
  }
  return ''
}

const fail = (status, message, code = null) => ({
  ok: false,
  status,
  message,
  code,
  keyData: null,
  requestId: null,
  leaseSeconds: null,
  release: async () => {},
})

const resolveLeaseSeconds = () => {
  if (typeof redis._getConcurrencyConfig === 'function') {
    const cfg = redis._getConcurrencyConfig()
    return Math.max(Number(cfg?.leaseSeconds) || 300, 30)
  }
  return 300
}

const resolveRenewIntervalSeconds = (leaseSeconds) => {
  if (typeof redis._getConcurrencyConfig === 'function') {
    const cfg = redis._getConcurrencyConfig()
    let renew = Number(cfg?.renewIntervalSeconds)
    if (!Number.isFinite(renew)) {
      renew = 30
    }
    if (renew <= 0) {
      return 0
    }
    const maxSafe = Math.max(leaseSeconds - 5, 15)
    return Math.min(Math.max(renew, 15), maxSafe)
  }
  return Math.min(30, Math.max(leaseSeconds - 5, 15))
}

/**
 * 为已占用的并发槽启动续租；返回 stop() 在连接结束时调用
 * Realtime 默认最长 2 小时（与 call 绑定 TTL 对齐），可用 env 覆盖
 */
export const startConcurrencyLeaseRenewal = ({
  apiKeyId,
  requestId,
  leaseSeconds,
  maxLifetimeMinutes = null,
  label = 'ws',
  onLeaseExpired = null,
} = {}) => {
  if (!apiKeyId || !requestId || !leaseSeconds) {
    return () => {}
  }

  const renewIntervalSeconds = resolveRenewIntervalSeconds(leaseSeconds)
  if (renewIntervalSeconds <= 0) {
    return () => {}
  }

  const renewIntervalMs = Math.max(renewIntervalSeconds * 1000, 15000)
  const lifetimeMinutes =
    maxLifetimeMinutes !== null ? maxLifetimeMinutes : parseInt(env.CONCURRENCY_WS_MAX_LIFETIME_MINUTES, 10) || 120
  const maxRefreshCount = Math.max(1, Math.ceil((lifetimeMinutes * 60 * 1000) / renewIntervalMs))
  let refreshCount = 0
  let stopped = false

  const timer = setInterval(() => {
    if (stopped) {
      return
    }
    refreshCount += 1
    if (refreshCount > maxRefreshCount) {
      logger.warn(`[${label}] concurrency lease refresh exceeded max=${maxRefreshCount} key=${apiKeyId}, force expire`)
      stopped = true
      clearInterval(timer)
      // 必须断连+释放槽：仅停续租会导致 Redis 槽蒸发后在线连接突破并发上限
      if (typeof onLeaseExpired === 'function') {
        try {
          onLeaseExpired()
        } catch (error) {
          console.error(error)
        }
      }
      return
    }
    redis.refreshConcurrencyLease(apiKeyId, requestId, leaseSeconds).catch((error) => {
      console.error(error)
      logger.error(`[${label}] refreshConcurrencyLease failed key=${apiKeyId}:`, error)
    })
  }, renewIntervalMs)

  if (typeof timer.unref === 'function') {
    timer.unref()
  }

  return () => {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(timer)
  }
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {URL} url
 * @param {{ requiredPermission?: string, maxLifetimeMinutes?: number }} [opts]
 */
export const authenticateApiKeyForUpgrade = async (req, url, opts = {}) => {
  const requiredPermission = opts.requiredPermission || 'openai'
  const apiKey = extractBearerOrQueryKey(req, url)
  if (!apiKey) {
    return fail(401, 'Missing API key')
  }

  const validation = await apiKeyService.validateApiKey(apiKey)
  if (!validation || validation.valid !== true || !validation.keyData) {
    return fail(401, (validation && validation.error) || 'Invalid API key')
  }

  const { keyData } = validation

  if (keyData.enableClientRestriction && keyData.allowedClients?.length > 0) {
    const clientResult = ClientValidator.validateRequest(keyData.allowedClients, req)
    if (!clientResult.allowed) {
      logger.security(`WS client restriction failed for key: ${keyData.id} (${keyData.name})`)
      return fail(403, 'Client not allowed')
    }
  }

  if (!apiKeyService.hasPermission(keyData.permissions, requiredPermission)) {
    return fail(403, `API key missing permission: ${requiredPermission}`)
  }

  const isPrepaid = keyData.billingMode === 'prepaid'
  if (isPrepaid) {
    const prepaidBalance = await balanceLedger.get(keyData.id)
    if (prepaidBalance <= 0) {
      return fail(402, '预付费余额不足，请充值', 'prepaid_balance_exhausted')
    }
  }

  const dailyCostLimit = keyData.dailyCostLimit || 0
  if (!isPrepaid && dailyCostLimit > 0) {
    const dailyCost = keyData.dailyCost || 0
    if (dailyCost >= dailyCostLimit) {
      return fail(402, `已达到每日费用限制 ($${dailyCostLimit})`, 'daily_cost_limit_exceeded')
    }
  }

  const totalCostLimit = keyData.totalCostLimit || 0
  if (!isPrepaid && totalCostLimit > 0) {
    const totalCost = keyData.totalCost || 0
    if (totalCost >= totalCostLimit) {
      return fail(402, `已达到总费用限制 ($${totalCostLimit})`, 'total_cost_limit_exceeded')
    }
  }

  const concurrencyLimit = keyData.concurrencyLimit || 0
  let requestId = null
  let hasSlot = false
  let leaseSeconds = null
  let stopRenew = () => {}

  if (concurrencyLimit > 0) {
    leaseSeconds = resolveLeaseSeconds()
    requestId = crypto.randomUUID()
    const current = await redis.incrConcurrency(keyData.id, requestId, leaseSeconds)
    hasSlot = true
    if (current > concurrencyLimit) {
      try {
        await redis.decrConcurrency(keyData.id, requestId)
      } catch (error) {
        console.error(error)
      }
      hasSlot = false
      return fail(429, `Too many concurrent requests. Limit: ${concurrencyLimit}`, 'concurrency_limit_exceeded')
    }

    stopRenew = startConcurrencyLeaseRenewal({
      apiKeyId: keyData.id,
      requestId,
      leaseSeconds,
      maxLifetimeMinutes: opts.maxLifetimeMinutes,
      label: 'RealtimeWS',
      onLeaseExpired: opts.onLeaseExpired,
    })
  }

  // 供调度器挂分组 USD hold（与 HTTP req.apiKey.groupCostHoldGroupId 同语义）
  keyData.groupCostHoldGroupId = keyData.groupCostHoldGroupId || null
  keyData.groupCostHoldMeta = keyData.groupCostHoldMeta || null

  let released = false
  const release = async () => {
    if (released) {
      return
    }
    released = true
    try {
      stopRenew()
    } catch (error) {
      console.error(error)
    }
    // 连接结束兜底释放分组 hold（选号成功但未/零计费时）
    const holdGroupId = keyData.groupCostHoldGroupId
    if (holdGroupId) {
      keyData.groupCostHoldGroupId = null
      keyData.groupCostHoldMeta = null
      try {
        await groupPolicy.releaseGroupCostHolds(holdGroupId)
      } catch (error) {
        console.error(error)
      }
    }
    if (!hasSlot || !requestId) {
      return
    }
    hasSlot = false
    try {
      await redis.decrConcurrency(keyData.id, requestId)
    } catch (error) {
      console.error(error)
      logger.error(`WS concurrency release failed key=${keyData.id}:`, error)
    }
  }

  return {
    ok: true,
    status: 200,
    message: 'ok',
    code: null,
    keyData,
    requestId,
    leaseSeconds,
    release,
  }
}
