import { grokAccountService } from '../account/account_grok_service.js'
import { accountGroupService } from '../account/account_group_service.js'
import * as groupPolicy from '../account/account_group_policy.js'
import { redis } from '../../infra/redis.js'
import { logger } from '../../common/logger.js'
import * as upstreamErrorHelper from './relay_upstream_error_helper.js'
import { RedisKeys } from '../../infra/redis_key.js'
import * as xaiHelper from '../../common/xai_helper.js'
import * as commonHelper from '../../common/common_helper.js'
/**
 * Grok 调度器
 * 硬门权威清单在 _passesGrokSyncGates / _isGrokAccountUsable
 */

class GrokScheduler {
  // 同步硬门：isActive / schedulable / 订阅 / 模型 / 预算(方案甲)
  // status 健康检查属上游错误类，disableAutoProtection 时跳过
  _passesGrokSyncGates(account, requestedModel) {
    if (!account) {
      return false
    }
    if (!commonHelper.isTruthy(account.isActive)) {
      return false
    }
    if (!commonHelper.isTruthy(account.schedulable ?? true)) {
      return false
    }
    if (this._isSubscriptionExpired(account)) {
      return false
    }
    if (this._isDailyQuotaBlocked(account)) {
      return false
    }
    if (requestedModel && !this._supportsModel(account, requestedModel)) {
      return false
    }
    return commonHelper.isAutoProtectionDisabled(account) || commonHelper.isAccountHealthy(account)
  }

  async _isGrokAccountUsable(account, requestedModel, options = {}) {
    if (!this._passesGrokSyncGates(account, requestedModel)) {
      return false
    }
    // 媒体生成路径：Free 硬挡；unobserved 仍可选（转发前 probe）
    if (options.mediaGeneration) {
      const eligibility = grokAccountService.getMediaGenerationEligibility(account)
      if (!eligibility.eligible && eligibility.reason !== 'billing_unobserved') {
        return false
      }
    }
    if (commonHelper.isAutoProtectionDisabled(account)) {
      return true
    }
    if (account.rateLimitStatus === 'limited') {
      const cleared = await grokAccountService.checkAndClearRateLimit(account.id)
      if (!cleared) {
        return false
      }
    }
    return !(await upstreamErrorHelper.isTempUnavailable(account.id, 'grok'))
  }

  _isSubscriptionExpired(account) {
    const expiresAt = account.subscriptionExpiresAt || account.expiresAt
    // OAuth token expiresAt 不是订阅到期；仅 subscriptionExpiresAt 作订阅硬门
    if (!account.subscriptionExpiresAt) {
      return false
    }
    const ts = Date.parse(expiresAt)
    return Number.isFinite(ts) && ts <= Date.now()
  }

  _isDailyQuotaBlocked(account) {
    const dailyQuota = parseFloat(account.dailyQuota) || 0
    if (dailyQuota <= 0) {
      return false
    }
    const dailyUsage = parseFloat(account.dailyUsage) || 0
    // 浮点累加 epsilon
    return dailyUsage + 1e-6 >= dailyQuota
  }

  _supportsModel(account, requestedModel) {
    const mapped = xaiHelper.mapModel(requestedModel)
    const supported = account.supportedModels
    if (!supported || (Array.isArray(supported) && supported.length === 0)) {
      return true
    }
    const list = Array.isArray(supported)
      ? supported
      : typeof supported === 'string'
        ? (() => {
            try {
              return JSON.parse(supported)
            } catch {
              return []
            }
          })()
        : []
    if (!list.length) {
      return true
    }
    return list.includes(requestedModel) || list.includes(mapped)
  }

  async _ensureTokenReady(account) {
    if (!account || account.authType === 'apikey') {
      return account
    }
    const expiresAt = account.expiresAt ? Date.parse(account.expiresAt) : 0
    const skewMs = 5 * 60 * 1000
    if (expiresAt && Date.now() + skewMs < expiresAt) {
      return account
    }
    if (!account.refreshToken) {
      // 过期且无 refreshToken → 死号
      if (expiresAt && Date.now() >= expiresAt) {
        return null
      }
      return account
    }
    try {
      return await grokAccountService.refreshAccountToken(account.id)
    } catch (error) {
      console.error(error)
      logger.warn(`[GrokScheduler] token refresh failed id=${account.id}: ${error.message}`)
      return null
    }
  }

  async _loadGroupAccounts(groupId, requestedModel, options = {}) {
    const group = await accountGroupService.getGroup(groupId)
    if (!group) {
      const error = new Error(`Grok group ${groupId} not found`)
      error.statusCode = 404
      throw error
    }
    if (group.platform && group.platform !== 'grok') {
      const error = new Error(`Group ${group.name} is not a Grok group`)
      error.statusCode = 400
      throw error
    }

    const holdTarget = options.holdTarget || null
    let groupCostHoldReleased = false
    const releaseGroupCostHoldOnce = async () => {
      if (groupCostHoldReleased) {
        return
      }
      groupCostHoldReleased = true
      if (holdTarget && holdTarget.groupCostHoldGroupId === groupId) {
        holdTarget.groupCostHoldGroupId = null
      }
      if (holdTarget && holdTarget.groupCostHoldMeta && holdTarget.groupCostHoldMeta.groupId === groupId) {
        holdTarget.groupCostHoldMeta = null
      }
      try {
        await groupPolicy.releaseGroupCostHolds(groupId)
      } catch (error) {
        console.error(error)
      }
    }

    try {
      await groupPolicy.assertGroupRequestAllowed(group, { requestedModel, holdTarget })

      const memberIds = await accountGroupService.getGroupMembers(groupId)
      if (!memberIds || memberIds.length === 0) {
        await releaseGroupCostHoldOnce()
        return []
      }
      const accounts = await Promise.all(
        memberIds.map(async (memberId) => {
          try {
            return await grokAccountService.getAccount(memberId, { decryptSecrets: true })
          } catch (error) {
            console.error(error)
            return null
          }
        }),
      )
      const result = []
      for (const account of accounts) {
        if (!(await this._isGrokAccountUsable(account, requestedModel, options))) {
          continue
        }
        const ready = await this._ensureTokenReady(account)
        if (ready) {
          result.push(ready)
        }
      }
      if (result.length === 0) {
        await releaseGroupCostHoldOnce()
      }
      return result
    } catch (error) {
      await releaseGroupCostHoldOnce()
      throw error
    }
  }

  async selectAccount(apiKeyData, requestedModel, sessionHash, options = {}) {
    let candidates = []
    let isDedicatedBinding = false
    const mediaGeneration = Boolean(options.mediaGeneration)
    const hasBinding = Boolean(apiKeyData?.grokAccountId)

    if (hasBinding) {
      const binding = apiKeyData.grokAccountId
      if (binding.startsWith('group:')) {
        const groupId = binding.substring('group:'.length)
        candidates = await this._loadGroupAccounts(groupId, requestedModel, {
          mediaGeneration,
          holdTarget: apiKeyData,
        })
        // 分组绑定：只在组内选，绝不退回共享池
        if (!candidates.length) {
          const error = new Error(`No available Grok accounts in bound group ${groupId} (respecting binding)`)
          error.statusCode = 403
          error.code = 'grok_binding_group_unavailable'
          error.type = 'binding_error'
          throw error
        }
      } else {
        // 专属绑定：只允许该号；不可用则直接失败，禁止静默退共享池
        const account = await grokAccountService.getAccount(binding, { decryptSecrets: true })
        if (account && (await this._isGrokAccountUsable(account, requestedModel, { mediaGeneration }))) {
          const ready = await this._ensureTokenReady(account)
          if (ready) {
            candidates = [ready]
            isDedicatedBinding = true
          }
        }
        if (!candidates.length) {
          const error = new Error(`Bound Grok account ${binding} is not available (respecting dedicated binding)`)
          error.statusCode = 403
          error.code = 'grok_binding_dedicated_unavailable'
          error.type = 'binding_error'
          throw error
        }
      }
    } else {
      // 共享池：仅 shared（兼容旧数据 accountType 空）；独占分组成员不进池
      const exclusiveMemberIds = await groupPolicy.collectExclusiveMemberIds(accountGroupService, 'grok')
      const all = await grokAccountService.getAllAccounts(false)
      const sharedListed = all.filter(
        (item) => item.accountType === 'shared' || !item.accountType || item.accountType === '',
      )
      const hydrated = await Promise.all(
        sharedListed.map((item) => grokAccountService.getAccount(item.id, { decryptSecrets: true })),
      )
      for (const account of hydrated) {
        if (!account) {
          continue
        }
        if (exclusiveMemberIds.has(account.id)) {
          continue
        }
        // 双重保险：解密后仍校验 shared
        if (account.accountType && account.accountType !== 'shared') {
          continue
        }
        if (!(await this._isGrokAccountUsable(account, requestedModel, { mediaGeneration }))) {
          continue
        }
        const ready = await this._ensureTokenReady(account)
        if (ready) {
          candidates.push(ready)
        }
      }
    }

    if (!candidates.length) {
      const error = new Error(`No available Grok accounts${hasBinding ? ' (respecting binding)' : ''}`)
      // 无绑定 = 池耗尽；有绑定不应走到这里（上面已 throw）
      error.statusCode = hasBinding ? 403 : 402
      error.code = hasBinding ? 'grok_binding_unavailable' : 'grok_pool_exhausted'
      error.type = hasBinding ? 'binding_error' : 'resource_exhausted'
      throw error
    }

    // 粘性会话（专属绑定不走粘性）
    const stickyKey = sessionHash ? RedisKeys.session.unifiedGrokMapping(sessionHash) : null
    if (stickyKey && !isDedicatedBinding) {
      try {
        const mappedAccountId = await redis.getSessionAccountMapping?.(stickyKey)
        if (mappedAccountId) {
          const mapped = candidates.find((account) => account.id === mappedAccountId)
          if (mapped && (await this._isGrokAccountUsable(mapped, requestedModel, { mediaGeneration }))) {
            await redis.extendSessionAccountMappingTTL?.(stickyKey)
            logger.info(`[GrokScheduler] sticky hit session=${sessionHash} account=${mapped.id}`)
            return mapped
          }
        }
      } catch (error) {
        console.error(error)
      }
    }

    const sorted = commonHelper.sortAccountsByPriority
      ? commonHelper.sortAccountsByPriority(candidates)
      : candidates.sort((left, right) => (parseInt(left.priority, 10) || 50) - (parseInt(right.priority, 10) || 50))
    const selected = sorted[0]

    if (stickyKey && selected && !isDedicatedBinding) {
      try {
        await redis.setSessionAccountMapping?.(stickyKey, selected.id)
        await redis.getClientSafe().sadd(RedisKeys.session.grokAccountSessions(selected.id), sessionHash)
      } catch (error) {
        console.error(error)
      }
    }

    logger.info(
      `[GrokScheduler] selected account=${selected.id} model=${requestedModel || '-'} candidates=${candidates.length} binding=${hasBinding}`,
    )
    return selected
  }
}

export const grokScheduler = new GrokScheduler()
