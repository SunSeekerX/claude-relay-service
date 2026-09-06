import { redis } from '../../infra/redis.js'
import { RedisKeys, LIMITS } from '../../infra/redis_key.js'
import { RedisLua } from '../../infra/redis_lua.js'
// 预付费余额账本（出站端口的 Redis 实现）。
//
// 【方案A：余额是派生值，用量账本是真相源】
// 余额 = 净充值额度(credit − refunded) − prepaid 期间已用量(usage:cost:total − baseline)
// - credit  累计：充值履约入账（幂等 refId=订单id）
// - refunded 累计：退款回收（幂等 refId=订单id:refund）
// - baseline：首次转 prepaid 时刻的 usage:cost:total（只算此后的消费）
// - consumed：usage:cost:total（recordUsage 落账，倍率后口径，与 totalCostLimit 一致）
//
// 为何派生：消费【不再实时扣减余额】，余额按上式从用量真相源算。价值在于【单一账本】：
// 不再有"余额账本与用量账本漂移"。usage 落账失败时该笔确实未计（与 postpaid totalCost 限额
// 失真同源、同一 failure domain）——但只此一处、由 recordUsage catch 的含金额 ERROR 兜底对账
// 补账；不需要"待补扣"摊给不相关请求（大厂 metered-billing 的 usage-as-source 内核）。
// 并发窗口的小额透支（事后计费固有）仍可能，但余额会如实记为负、auth 据此拦截后续，不会丢钱。

const CREDIT = (keyId) => RedisKeys.payment.balanceCredit(keyId)
const REFUNDED = (keyId) => RedisKeys.payment.balanceRefunded(keyId)
const BASELINE = (keyId) => RedisKeys.payment.balanceBaseline(keyId)
const APPLIED = (keyId) => RedisKeys.payment.balanceApplied(keyId)
const REVERSED = (keyId) => RedisKeys.payment.balanceReversed(keyId)
const TX = (keyId) => RedisKeys.payment.balanceTx(keyId)
const TX_MAX = LIMITS.balanceTx

const round6 = (n) => Math.round(n * 1e6) / 1e6

class BalanceLedger {
  // 已消费额度（真相源：usage:cost:total，由 recordUsage 落账）
  async _consumed(keyId) {
    return parseFloat((await redis.client.get(RedisKeys.usage.costTotal(keyId))) || 0)
  }

  // 派生余额 =(充值累计 − 退款累计) − max(0, 已消费 − prepaid 基线)
  async get(keyId) {
    const [credit, refunded, baseline, consumed] = await Promise.all([
      redis.client.get(CREDIT(keyId)),
      redis.client.get(REFUNDED(keyId)),
      redis.client.get(BASELINE(keyId)),
      this._consumed(keyId),
    ])
    const net = parseFloat(credit || 0) - parseFloat(refunded || 0)
    const used = Math.max(0, consumed - parseFloat(baseline || 0))
    return round6(net - used)
  }

  // 转 prepaid 时记消费基线（首次，SET NX 幂等）：之后只算基线后的消费
  async setBaselineIfAbsent(keyId) {
    const consumed = await this._consumed(keyId)
    await redis.client.set(BASELINE(keyId), String(consumed), 'NX')
  }

  // 充值入账：累加 credit（幂等 refId=订单id）。返回入账后派生余额。
  async credit(keyId, amount, refId, meta = {}) {
    const tx = JSON.stringify({
      type: 'credit',
      amount,
      refId,
      at: new Date().toISOString(),
      ...meta,
    })
    await redis.client.eval(
      RedisLua.payment.addIdempotent,
      3,
      CREDIT(keyId),
      APPLIED(keyId),
      TX(keyId),
      String(amount),
      refId,
      tx,
      String(TX_MAX),
    )
    return this.get(keyId)
  }

  // 退款回收：执行时在 Lua 内按【当前】派生余额原子裁剪（防快照过时超退），幂等 refId=订单id:refund，
  // 实扣额原子记入回收 hash（getReversedQuota 可取）。
  // 返回实际回收额度（可能 < 请求额；0=执行时已无可退；-1=refId 已 applied，从回收 hash 取实扣额续退）。
  async reverse(keyId, amount, refId, meta = {}) {
    if (!(amount > 0)) {
      return 0
    }
    const tx = JSON.stringify({
      type: 'reverse',
      amount,
      refId,
      at: new Date().toISOString(),
      ...meta,
    })
    const actual = await redis.client.eval(
      RedisLua.payment.reverse,
      7,
      CREDIT(keyId),
      REFUNDED(keyId),
      BASELINE(keyId),
      RedisKeys.usage.costTotal(keyId),
      APPLIED(keyId),
      TX(keyId),
      REVERSED(keyId),
      String(amount),
      refId,
      tx,
      String(TX_MAX),
    )
    return parseFloat(actual)
  }

  // 某 refId 的实扣回收额（reverse Lua 原子记录；0=未扣或已回滚）
  async getReversedQuota(keyId, refId) {
    return parseFloat((await redis.client.hget(REVERSED(keyId), refId)) || 0)
  }

  // 回滚 reverse（渠道退款失败补偿）：按账本回收 hash 实扣额撤销 refunded、清幂等标记与记录。
  // 返回实际撤销额（0=未 applied 无需回滚；-1=applied 在而账本记录缺失，拒绝盲回滚需人工）。
  // amount 仅入流水供对账，不参与撤销金额计算（金额只信账本）。
  async unreverse(keyId, amount, refId, meta = {}) {
    const tx = JSON.stringify({
      type: 'unreverse',
      amount,
      refId,
      at: new Date().toISOString(),
      ...meta,
    })
    const rolled = await redis.client.eval(
      RedisLua.payment.unreverse,
      4,
      REFUNDED(keyId),
      APPLIED(keyId),
      TX(keyId),
      REVERSED(keyId),
      refId,
      tx,
      String(TX_MAX),
    )
    return parseFloat(rolled)
  }

  async getTransactions(keyId, limit = 50) {
    const items = await redis.client.lrange(TX(keyId), -limit, -1)
    return items
      .map((item) => {
        try {
          return JSON.parse(item)
        } catch (e) {
          return null
        }
      })
      .filter(Boolean)
  }
}

export const balanceLedger = new BalanceLedger()
