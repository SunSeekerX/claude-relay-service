import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { logger } from '../common/logger.js'
import { RedisKeys, TTL } from './redis_key.js'
import * as timezone from '../common/timezone.js'

// 懒加载 CostCalculator，打断 ESM 环：redis → cost_stats_store → CostCalculator → pricing_service → redis
const require = createRequire(import.meta.url)
let _CostCalculator = null
const getCostCalculator = () => {
  if (!_CostCalculator) {
    _CostCalculator = require('../modules/pricing/pricing_cost_calculator.js').CostCalculator
  }
  return _CostCalculator
}

// ===
// 成本统计（每日/周 Opus/账户级；从 src/models/redis.js 按域抽出）
// 经 attach(redisClient) 挂到同一个 RedisClient 单例上，this 绑定与原文件一致。
// 含计费关键写幂等 Lua（COST_TOTAL_LUA，逐字保留）。
// ===
// 计费关键写幂等 Lua（见 incrementDailyCost）：去重标记 + 双累加在单脚本内原子执行，
// 重试遇「脚本已执行但响应丢失」时去重标记命中、不会重复累加。
// KEYS: dedupKey, costTotal, costRealTotal；ARGV: ratedAmount, realAmount, dedupTtl
const COST_TOTAL_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], '1', 'EX', tonumber(ARGV[3]))
redis.call('INCRBYFLOAT', KEYS[2], ARGV[1])
redis.call('INCRBYFLOAT', KEYS[3], ARGV[2])
return 1
`

export const attach = function attach(redisClient) {
  // 💰 获取当日费用
  redisClient.getDailyCost = async function (keyId) {
    const today = timezone.getDateStringInTimezone()
    const costKey = RedisKeys.usage.costDaily(keyId, today)
    const cost = await this.client.get(costKey)
    const result = parseFloat(cost || 0)
    logger.debug(
      `💰 Getting daily cost for ${keyId}, date: ${today}, key: ${costKey}, value: ${cost}, result: ${result}`,
    )
    return result
  }

  // 💰 增加当日费用（支持倍率成本和真实成本分开记录）
  // amount: 倍率后的成本（用于限额校验）
  // realAmount: 真实成本（用于对账），如果不传则等于 amount
  // [人工决策-2026-06-04 10:38:30] 计费关键写（usage:cost:total / costRealTotal——prepaid 派生余额
  // 与 postpaid 限额的真相源）幂等化（去重 Lua）+ 有限重试，消灭瞬时故障的免费消费窗口；持续故障
  // 重试耗尽后抛出，由上层 recordUsage catch 的含金额 ERROR 兜底对账。统计写失败不再连带计费失败。
  redisClient.incrementDailyCost = async function (keyId, amount, realAmount = null) {
    const today = timezone.getDateStringInTimezone()
    const tzDate = timezone.getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
    const currentHour = `${today}:${String(timezone.getHourInTimezone(new Date())).padStart(2, '0')}`

    const dailyKey = RedisKeys.usage.costDaily(keyId, today)
    const monthlyKey = RedisKeys.usage.costMonthly(keyId, currentMonth)
    const hourlyKey = RedisKeys.usage.costHourly(keyId, currentHour)
    const totalKey = RedisKeys.usage.costTotal(keyId) // 总费用键 - 永不过期，持续累加

    // 真实成本键（用于对账）
    const realTotalKey = RedisKeys.usage.costRealTotal(keyId)
    const realDailyKey = RedisKeys.usage.costRealDaily(keyId, today)
    const actualRealAmount = realAmount !== null ? realAmount : amount

    logger.debug(`💰 Incrementing cost for ${keyId}, rated: $${amount}, real: $${actualRealAmount}, date: ${today}`)

    // ① 计费关键写：幂等 Lua + 最多 3 次重试。dedupId 本次调用内生成——跨调用每笔用量本就各自累加，
    // 幂等只需保护重试环内「脚本已执行但响应丢失」不重复累加
    const dedupId = crypto.randomUUID()
    let lastError = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.client.eval(
          COST_TOTAL_LUA,
          3,
          RedisKeys.usage.costDedup(dedupId),
          totalKey,
          realTotalKey,
          String(amount),
          String(actualRealAmount),
          String(TTL.costDedup),
        )
        lastError = null
        break
      } catch (error) {
        lastError = error
        logger.warn(`⚠️ Billing-critical cost write attempt ${attempt}/3 failed for ${keyId}:`, error)
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 200))
        }
      }
    }
    if (lastError) {
      throw lastError
    }

    // ② 统计写（日/月/时 + 真实日）：计费真相已落，失败只记日志不抛——否则上层会把已计费误报为未计费
    try {
      await Promise.all([
        this.client.incrbyfloat(dailyKey, amount),
        this.client.incrbyfloat(monthlyKey, amount),
        this.client.incrbyfloat(hourlyKey, amount),
        this.client.incrbyfloat(realDailyKey, actualRealAmount), // 真实每日费用
        // 设置过期时间（注意：totalKey 和 realTotalKey 不设置过期时间，保持永久累计）
        // 费用 TTL 必须 ≥ 原始用量 TTL（用量日 32 天 / 月 365 天，见 incrementTokenUsage），
        // 否则用量还在、费用先过期，启动对账会误判"缺费用"而反复全量重算
        this.client.expire(dailyKey, TTL.costDaily), // 33天（> 用量日 32 天）
        this.client.expire(monthlyKey, TTL.costMonthly), // 366天（≥ 用量月 365 天）
        this.client.expire(hourlyKey, TTL.costHourly), // 7天（与用量小时一致）
        this.client.expire(realDailyKey, TTL.costDaily), // 33天（> 用量日 32 天）
      ])
    } catch (error) {
      logger.error(`❌ Cost stats write failed for ${keyId} (billing already recorded):`, error)
    }
  }

  // 💰 获取费用统计（包含倍率成本和真实成本）
  redisClient.getCostStats = async function (keyId) {
    const today = timezone.getDateStringInTimezone()
    const tzDate = timezone.getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
    const currentHour = `${today}:${String(timezone.getHourInTimezone(new Date())).padStart(2, '0')}`

    const [daily, monthly, hourly, total, realTotal, realDaily] = await Promise.all([
      this.client.get(RedisKeys.usage.costDaily(keyId, today)),
      this.client.get(RedisKeys.usage.costMonthly(keyId, currentMonth)),
      this.client.get(RedisKeys.usage.costHourly(keyId, currentHour)),
      this.client.get(RedisKeys.usage.costTotal(keyId)),
      this.client.get(RedisKeys.usage.costRealTotal(keyId)),
      this.client.get(RedisKeys.usage.costRealDaily(keyId, today)),
    ])

    return {
      daily: parseFloat(daily || 0),
      monthly: parseFloat(monthly || 0),
      hourly: parseFloat(hourly || 0),
      total: parseFloat(total || 0),
      realTotal: parseFloat(realTotal || 0),
      realDaily: parseFloat(realDaily || 0),
    }
  }

  // 💰 获取本周 Opus 费用（支持自定义重置周期）
  redisClient.getWeeklyOpusCost = async function (keyId, resetDay = 1, resetHour = 0) {
    const periodStr = timezone.getPeriodString(resetDay, resetHour)
    const costKey = RedisKeys.usage.opusWeekly(keyId, periodStr)
    const cost = await this.client.get(costKey)
    const result = parseFloat(cost || 0)
    logger.debug(
      `💰 Getting weekly Opus cost for ${keyId}, period: ${periodStr}, key: ${costKey}, value: ${cost}, result: ${result}`,
    )
    return result
  }

  // 💰 增加本周 Opus 费用（支持倍率成本和真实成本，支持自定义重置周期）
  // amount: 倍率后的成本（用于限额校验）
  // realAmount: 真实成本（用于对账），如果不传则等于 amount
  redisClient.incrementWeeklyOpusCost = async function (keyId, amount, realAmount = null, resetDay = 1, resetHour = 0) {
    const periodStr = timezone.getPeriodString(resetDay, resetHour)
    const weeklyKey = RedisKeys.usage.opusWeekly(keyId, periodStr)
    const totalKey = RedisKeys.usage.opusTotal(keyId)
    const realWeeklyKey = RedisKeys.usage.opusRealWeekly(keyId, periodStr)
    const realTotalKey = RedisKeys.usage.opusRealTotal(keyId)
    const actualRealAmount = realAmount !== null ? realAmount : amount

    logger.debug(
      `💰 Incrementing weekly Opus cost for ${keyId}, period: ${periodStr}, rated: $${amount}, real: $${actualRealAmount}`,
    )

    // 使用 pipeline 批量执行，提高性能
    const pipeline = this.client.pipeline()
    pipeline.incrbyfloat(weeklyKey, amount)
    pipeline.incrbyfloat(totalKey, amount)
    pipeline.incrbyfloat(realWeeklyKey, actualRealAmount)
    pipeline.incrbyfloat(realTotalKey, actualRealAmount)
    // 设置周费用键的过期时间为 2 周
    pipeline.expire(weeklyKey, TTL.opusWeekly)
    pipeline.expire(realWeeklyKey, TTL.opusWeekly)

    const results = await pipeline.exec()
    logger.debug(`💰 Opus cost incremented successfully, new weekly total: $${results[0][1]}`)
  }

  // 💰 覆盖设置本周 Opus 费用（用于启动回填/迁移，支持自定义周期标识）
  redisClient.setWeeklyOpusCost = async function (keyId, amount, periodString = null, resetDay = 1, resetHour = 0) {
    const currentPeriod = periodString || timezone.getPeriodString(resetDay, resetHour)
    const weeklyKey = RedisKeys.usage.opusWeekly(keyId, currentPeriod)

    await this.client.set(weeklyKey, String(amount || 0))
    // 保留 2 周，足够覆盖"当前周期 + 上周期"查看/回填
    await this.client.expire(weeklyKey, TTL.opusWeekly)
  }

  // 💰 从「账户+模型」的统计 hash 求本条成本。三个读取入口
  // (getAccountDailyCost / batchGetAccountDailyCost / getAccountDailyCostFallback) 共用，
  // 免得回落口径写三份、改一处漏两处。
  //
  // [人工决策-2026-08-24 11:33:43] 精确成本(cost) + 未被 cost 覆盖的 token 反推，两部分相加。
  //
  // 为什么不能「有 cost 就只读 cost」：升级发布当天，同一个 account:model:daily hash 里会混有
  // 升级前的请求(只累加了 token、没有 cost)与升级后的请求(两者都有)。只读 cost 会漏掉升级前
  // 那一段的全部成本；只按总 token 反推又会把已经精确计过的部分再按基础价算一遍。
  // 所以写入侧同时累加 costedXxxTokens(已被 cost 覆盖的 token 量)，这里用
  // 总 token − 已覆盖 token 得到「仅升级前」的残量，单独反推后与 cost 相加。
  //
  // 反推本身的固有缺陷(所以要尽量少用它)：单价随 service_tier(fast/flex/ultrafast) 与
  // 长上下文档变化，聚合 token 已丢失「哪些 token 属于哪个档」「单次请求是否超阈值」，
  // 于是 Fast/ultrafast 必然低估、Flex 必然高估。残量部分只能这样算(那些请求发生在升级前，
  // 当时没记金额)，但它随当日/当月 key 过期自然消失，之后全部走精确值。
  redisClient._resolveAccountModelCost = function (modelUsage, model) {
    if (!modelUsage) {
      return 0
    }

    const toInt = (value) => {
      const parsed = parseInt(value || 0)
      return Number.isFinite(parsed) ? parsed : 0
    }

    // 写入侧已精确计费的金额。零价模型的请求没有 cost 字段但有 costed*（金额 0 也是权威结果），
    // 此时 storedCost 保持 0、残量也为 0，结果正确等于 0 —— 不会被按读取时的价格追溯计费
    let storedCost = 0
    if (modelUsage.cost !== undefined && modelUsage.cost !== null && modelUsage.cost !== '') {
      const parsed = parseFloat(modelUsage.cost)
      if (Number.isFinite(parsed) && parsed > 0) {
        storedCost = parsed
      }
    }

    // 未被 cost 覆盖的 token 残量（负值说明数据异常，按 0 处理，绝不倒扣）
    const remaining = (totalField, costedField) =>
      Math.max(0, toInt(modelUsage[totalField]) - toInt(modelUsage[costedField]))

    const inputTokens = remaining('inputTokens', 'costedInputTokens')
    const outputTokens = remaining('outputTokens', 'costedOutputTokens')
    const cacheCreateTokens = remaining('cacheCreateTokens', 'costedCacheCreateTokens')
    const cacheReadTokens = remaining('cacheReadTokens', 'costedCacheReadTokens')
    const eph5m = remaining('ephemeral5mTokens', 'costedEphemeral5mTokens')
    const eph1h = remaining('ephemeral1hTokens', 'costedEphemeral1hTokens')

    // 残量为 0（常态：全部请求都精确计过费）直接返回，省掉一次定价计算
    if (!inputTokens && !outputTokens && !cacheCreateTokens && !cacheReadTokens) {
      return storedCost
    }

    const usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreateTokens,
      cache_read_input_tokens: cacheReadTokens,
    }

    // 添加 cache_creation 子对象以支持精确 ephemeral 定价
    if (eph5m > 0 || eph1h > 0) {
      usage.cache_creation = {
        ephemeral_5m_input_tokens: eph5m,
        ephemeral_1h_input_tokens: eph1h,
      }
    }

    return storedCost + getCostCalculator().calculateCost(usage, model).costs.total
  }

  // 💰 计算账户的每日费用（基于模型使用，使用索引集合替代 KEYS）
  redisClient.getAccountDailyCost = async function (accountId) {
    const today = timezone.getDateStringInTimezone()

    // 使用索引集合替代 KEYS 命令
    const indexKey = RedisKeys.accountUsage.modelDailyIndex(today)
    const allEntries = await this.client.smembers(indexKey)

    // 过滤出当前账户的条目（格式：accountId:model）
    const accountPrefix = `${accountId}:`
    const accountModels = allEntries
      .filter((entry) => entry.startsWith(accountPrefix))
      .map((entry) => entry.substring(accountPrefix.length))

    if (accountModels.length === 0) {
      return 0
    }

    // Pipeline 批量获取所有模型数据
    const pipeline = this.client.pipeline()
    for (const model of accountModels) {
      pipeline.hgetall(RedisKeys.accountUsage.modelDaily(accountId, model, today))
    }
    const results = await pipeline.exec()

    let totalCost = 0
    for (let i = 0; i < accountModels.length; i++) {
      const model = accountModels[i]
      const [err, modelUsage] = results[i]

      if (!err && modelUsage) {
        const modelCost = this._resolveAccountModelCost(modelUsage, model)
        totalCost += modelCost

        if (modelCost > 0) {
          logger.debug(`💰 Account ${accountId} daily cost for model ${model}: $${modelCost}`)
        }
      }
    }

    logger.debug(`💰 Account ${accountId} total daily cost: $${totalCost}`)
    return totalCost
  }

  // 💰 批量计算多个账户的每日费用
  redisClient.batchGetAccountDailyCost = async function (accountIds) {
    if (!accountIds || accountIds.length === 0) {
      return new Map()
    }

    const today = timezone.getDateStringInTimezone()

    // 一次获取索引
    const indexKey = RedisKeys.accountUsage.modelDailyIndex(today)
    const allEntries = await this.client.smembers(indexKey)

    // 按 accountId 分组
    const accountIdSet = new Set(accountIds)
    const entriesByAccount = new Map()
    for (const entry of allEntries) {
      const colonIndex = entry.indexOf(':')
      if (colonIndex === -1) {
        continue
      }
      const accountId = entry.substring(0, colonIndex)
      const model = entry.substring(colonIndex + 1)
      if (accountIdSet.has(accountId)) {
        if (!entriesByAccount.has(accountId)) {
          entriesByAccount.set(accountId, [])
        }
        entriesByAccount.get(accountId).push(model)
      }
    }

    const costMap = new Map(accountIds.map((id) => [id, 0]))

    // 如果索引为空，回退到 KEYS 命令（兼容旧数据）
    if (allEntries.length === 0) {
      logger.debug('💰 Daily cost index empty, falling back to KEYS for batch cost calculation')
      for (const accountId of accountIds) {
        try {
          const cost = await this.getAccountDailyCostFallback(accountId, today)
          costMap.set(accountId, cost)
        } catch {
          // 忽略单个账户的错误
        }
      }
      return costMap
    }

    // Pipeline 批量获取所有模型数据
    const pipeline = this.client.pipeline()
    const queryOrder = []
    for (const [accountId, models] of entriesByAccount) {
      for (const model of models) {
        pipeline.hgetall(RedisKeys.accountUsage.modelDaily(accountId, model, today))
        queryOrder.push({ accountId, model })
      }
    }

    if (queryOrder.length === 0) {
      return costMap
    }

    const results = await pipeline.exec()

    for (let i = 0; i < queryOrder.length; i++) {
      const { accountId, model } = queryOrder[i]
      const [err, modelUsage] = results[i]

      if (!err && modelUsage) {
        const modelCost = this._resolveAccountModelCost(modelUsage, model)
        costMap.set(accountId, costMap.get(accountId) + modelCost)
      }
    }

    return costMap
  }

  // 💰 回退方法：计算单个账户的每日费用（使用 scanKeys 替代 keys）
  redisClient.getAccountDailyCostFallback = async function (accountId, today) {
    const pattern = RedisKeys.accountUsage.modelDailyAnyPattern(accountId, today)
    const modelKeys = await this.scanKeys(pattern)

    if (!modelKeys || modelKeys.length === 0) {
      return 0
    }

    let totalCost = 0
    const pipeline = this.client.pipeline()
    for (const key of modelKeys) {
      pipeline.hgetall(key)
    }
    const results = await pipeline.exec()

    for (let i = 0; i < modelKeys.length; i++) {
      const key = modelKeys[i]
      const [err, modelUsage] = results[i]
      if (err || !modelUsage) {
        continue
      }

      const parts = key.split(':')
      const model = parts[4]

      totalCost += this._resolveAccountModelCost(modelUsage, model)
    }

    return totalCost
  }
}
