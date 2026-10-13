import { jest } from '@jest/globals'
import Redis from 'ioredis'
import crypto from 'node:crypto'
import { RedisKeys } from '../src/infra/redis_key.js'
import { getDateStringInTimezone } from '../src/common/timezone.js'

const store = {}
const logger = Object.fromEntries(
  ['info', 'debug', 'warn', 'error', 'success'].map((key) => [key, jest.fn()])
)
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger }))
jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis: store }))
jest.unstable_mockModule('../src/modules/relay/relay_upstream_error_helper.js', () => ({}))
jest.unstable_mockModule('../src/modules/webhook/webhook_notifier.js', () => ({
  webhookNotifier: {}
}))
const { attach: attachAccountUsage } = await import('../src/infra/redis_account_usage_store.js')
const { attach: attachCosts } = await import('../src/infra/redis_cost_stats_store.js')
const { costRankService } = await import('../src/modules/pricing/pricing_cost_rank_service.js')
const { apiKeyIndexService } = await import('../src/modules/apikey/apikey_index_service.js')
const interval = jest.spyOn(global, 'setInterval').mockReturnValue(0)
const { openaiResponsesAccountService } =
  await import('../src/modules/account/account_openai_responses_service.js')
interval.mockRestore()
const suite = process.env.CRS_TEST_REDIS_SOCKET ? describe : describe.skip

suite('account usage and rank on isolated Redis', () => {
  let client
  const cleanup = new Set()
  const remember = (key) => {
    cleanup.add(key)
    return key
  }
  const accountKey = () => remember(RedisKeys.accounts.openaiResponses(crypto.randomUUID()))
  beforeAll(async () => {
    client = new Redis({ path: process.env.CRS_TEST_REDIS_SOCKET, retryStrategy: null })
    await client.ping()
    Object.assign(store, {
      client,
      getClient: () => client,
      getClientSafe: () => client,
      getDateStringInTimezone,
      getDateInTimezone: () => new Date()
    })
    attachAccountUsage(store)
    attachCosts(store)
    apiKeyIndexService.init(store)
  })
  beforeEach(() => jest.clearAllMocks())
  afterEach(async () => {
    jest.restoreAllMocks()
    if (cleanup.size) {
      await client.del([...cleanup])
      cleanup.clear()
    }
  })
  afterAll(async () => {
    await client.quit()
  })

  it('keeps every concurrent token increment and avoids full account reads or admin update logs', async () => {
    const key = accountKey()
    const id = key.split(':').at(-1)
    await client.hset(key, { id, totalUsedTokens: '100', name: 'fixture' })
    const read = jest.spyOn(openaiResponsesAccountService, 'getAccount').mockImplementation(() => {
      throw new Error('full reads forbidden')
    })
    await Promise.all(
      Array.from({ length: 100 }, () => openaiResponsesAccountService.updateAccountUsage(id, 7))
    )
    expect(await client.hget(key, 'totalUsedTokens')).toBe('800')
    expect(await client.hget(key, 'lastUsedAt')).toMatch(/^\d{4}-/)
    expect(read).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledTimes(100)
  })

  it('resets a stale day once and atomically counts concurrent quota with protection disabled', async () => {
    const key = accountKey()
    const id = key.split(':').at(-1)
    await client.hset(key, {
      id,
      name: 'fixture',
      dailyQuota: '0.25',
      dailyUsage: '99',
      lastResetDate: '2000-01-01',
      disableAutoProtection: 'true',
      schedulable: 'true'
    })
    await Promise.all(
      Array.from({ length: 30 }, () => openaiResponsesAccountService.updateUsageQuota(id, 0.01))
    )
    expect(await client.hmget(key, 'dailyUsage', 'lastResetDate', 'status', 'schedulable')).toEqual(
      ['0.3', getDateStringInTimezone(), 'quotaExceeded', 'true']
    )
    expect(await client.hget(key, 'quotaStoppedAt')).toMatch(/^\d{4}-/)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('marks quota exceeded even on the first settlement of a new day', async () => {
    const key = accountKey()
    const id = key.split(':').at(-1)
    await client.hset(key, { id, dailyQuota: '1', dailyUsage: '99', lastResetDate: '2000-01-01' })
    await openaiResponsesAccountService.updateUsageQuota(id, 2)
    expect(await client.hmget(key, 'dailyUsage', 'status')).toEqual(['2', 'quotaExceeded'])
  })

  it('does not recreate deleted accounts and does not reset a usage counter for last-used updates', async () => {
    const key = accountKey()
    const id = key.split(':').at(-1)
    await openaiResponsesAccountService.updateAccountUsage(id, 7)
    await openaiResponsesAccountService.updateUsageQuota(id, 1)
    expect(await client.exists(key)).toBe(0)
    await client.hset(key, { id, totalUsedTokens: '50' })
    await openaiResponsesAccountService.recordUsage(id, 0)
    expect(await client.hget(key, 'totalUsedTokens')).toBe('50')
  })

  it('counts tokens and quota once when the Redis driver resends after a lost reply', async () => {
    const key = accountKey()
    const id = key.split(':').at(-1)
    await client.hset(key, {
      id,
      name: 'fixture',
      totalUsedTokens: '0',
      dailyUsage: '0',
      dailyQuota: '0.2',
      lastResetDate: getDateStringInTimezone()
    })
    const evaluate = client.eval.bind(client)
    const resend = jest.spyOn(client, 'eval').mockImplementation(async (...args) => {
      args.slice(2, 2 + args[1]).forEach(remember)
      // First response is lost; ioredis resends the exact command and operation key.
      await evaluate(...args)
      return evaluate(...args)
    })
    await openaiResponsesAccountService.updateAccountUsage(id, 10)
    await openaiResponsesAccountService.updateUsageQuota(id, 0.25)
    expect(await client.hmget(key, 'totalUsedTokens', 'dailyUsage')).toEqual(['10', '0.25'])
    expect(logger.warn).toHaveBeenCalledTimes(1)
    for (const call of resend.mock.calls) {
      expect(await client.ttl(call[3])).toBeGreaterThan(0)
    }
  })

  const rankFixture = async () => {
    const id = crypto.randomUUID()
    remember(RedisKeys.apiKey.idx.all)
    remember(RedisKeys.apiKey.set.deleted)
    remember(RedisKeys.costRank.sourceRevision)
    for (const range of ['today', 'all']) {
      remember(RedisKeys.costRank.rank(range))
      remember(RedisKeys.costRank.meta(range))
      remember(RedisKeys.costRank.lock(range))
    }
    await client.sadd(RedisKeys.apiKey.idx.all, id)
    jest.spyOn(apiKeyIndexService, 'isIndexReady').mockResolvedValue(true)
    return id
  }

  const charge = async (id, amount, dedupId = crypto.randomUUID()) => {
    const today = getDateStringInTimezone()
    const month = today.slice(0, 7)
    for (const key of [
      RedisKeys.usage.costDedup(dedupId),
      RedisKeys.usage.costTotal(id),
      RedisKeys.usage.costRealTotal(id),
      RedisKeys.usage.costDaily(id, today),
      RedisKeys.usage.costMonthly(id, month),
      RedisKeys.usage.costRealDaily(id, today)
    ]) {
      remember(key)
    }
    // The writer uses its existing hour key; collect it through its eval key list.
    const evaluate = client.eval.bind(client)
    const evalSpy = jest.spyOn(client, 'eval').mockImplementation(async (...args) => {
      args.slice(2, 2 + args[1]).forEach(remember)
      return evaluate(...args)
    })
    try {
      return await store.incrementDailyCost(id, amount, amount, { dedupId })
    } finally {
      evalSpy.mockRestore()
    }
  }

  it('skips unchanged ranks, observes a real cost change and preserves forced refresh', async () => {
    const id = await rankFixture()
    await charge(id, 1)
    await costRankService.updateRank('today')
    const calculate = jest.spyOn(costRankService, '_calculateCostsInBatches')
    await costRankService.updateRank('today', { skipUnchanged: true })
    expect(calculate).not.toHaveBeenCalled()
    await charge(id, 2)
    await costRankService.updateRank('today', { skipUnchanged: true })
    expect(calculate).toHaveBeenCalledTimes(1)
    expect(await client.zscore(RedisKeys.costRank.rank('today'), id)).toBe('3')
    await costRankService.forceRefresh('today')
    expect(calculate).toHaveBeenCalledTimes(2)
  })

  it('rebuilds a lost rank cache even if the stored source revision has not changed', async () => {
    const id = await rankFixture()
    await charge(id, 1)
    await costRankService.updateRank('today')
    await client.del(RedisKeys.costRank.rank('today'))
    const calculate = jest.spyOn(costRankService, '_calculateCostsInBatches')
    await costRankService.updateRank('today', { skipUnchanged: true })
    expect(calculate).toHaveBeenCalledTimes(1)
    expect(await client.zscore(RedisKeys.costRank.rank('today'), id)).toBe('1')
  })

  it('keeps total and periodic costs exact when both Lua command replies are resent', async () => {
    const id = await rankFixture()
    const evaluate = client.eval.bind(client)
    const adapter = {
      client: {
        eval: async (...args) => {
          args.slice(2, 2 + args[1]).forEach(remember)
          await evaluate(...args)
          return evaluate(...args)
        }
      }
    }
    attachCosts(adapter)
    await adapter.incrementDailyCost(id, 2, 1)
    expect(await client.get(RedisKeys.usage.costTotal(id))).toBe('2')
    expect(await client.get(RedisKeys.usage.costRealTotal(id))).toBe('1')
    expect(await client.get(RedisKeys.usage.costDaily(id, getDateStringInTimezone()))).toBe('2')
    expect(await client.get(RedisKeys.usage.costRealDaily(id, getDateStringInTimezone()))).toBe('1')
  })

  it('does not dirty ranking again for duplicate billing or a zero customer cost', async () => {
    const id = await rankFixture()
    const dedup = crypto.randomUUID()
    await charge(id, 1, dedup)
    const revision = await client.get(RedisKeys.costRank.sourceRevision)
    expect(await charge(id, 1, dedup)).toBe(false)
    expect(await client.get(RedisKeys.costRank.sourceRevision)).toBe(revision)
    await charge(id, 0)
    expect(await client.get(RedisKeys.costRank.sourceRevision)).toBe(revision)
  })

  it('invalidates even total ranks at a business-day change without new consumption', async () => {
    const id = await rankFixture()
    await charge(id, 1)
    await costRankService.updateRank('all')
    const calculate = jest.spyOn(costRankService, '_calculateCostsInBatches')
    jest.spyOn(store, 'getDateStringInTimezone').mockReturnValue('2099-01-01')
    await costRankService.updateRank('all', { skipUnchanged: true })
    expect(calculate).toHaveBeenCalledTimes(1)
  })

  it('does not mark a concurrent source change as included in an older rank snapshot', async () => {
    const id = await rankFixture()
    await charge(id, 1)
    const calculate = jest.spyOn(costRankService, '_calculateCostsInBatches')
    const original = (...args) =>
      Object.getPrototypeOf(costRankService)._calculateCostsInBatches.call(costRankService, ...args)
    calculate.mockImplementationOnce(async (...args) => {
      const costs = await original(...args)
      await client.incr(RedisKeys.costRank.sourceRevision)
      return costs
    })
    await costRankService.updateRank('all')
    await costRankService.updateRank('all', { skipUnchanged: true })
    expect(calculate).toHaveBeenCalledTimes(2)
  })

  it('keeps billing committed when statistics have a wrong type and still invalidates rankings', async () => {
    const id = await rankFixture()
    await client.sadd(
      remember(RedisKeys.usage.costDaily(id, getDateStringInTimezone())),
      'wrong-type'
    )
    expect(await charge(id, 1)).toBe(true)
    expect(await client.get(RedisKeys.usage.costTotal(id))).toBe('1')
    expect(Number(await client.get(RedisKeys.costRank.sourceRevision))).toBeGreaterThan(0)
    expect(logger.error).toHaveBeenCalled()
  })

  it('contributes membership invalidation to the caller transaction, without submitting it', async () => {
    const id = await rankFixture()
    const multi = client.multi()
    await apiKeyIndexService.updateIndex(id, { isDeleted: true }, { isDeleted: false }, multi)
    expect(await client.get(RedisKeys.costRank.sourceRevision)).toBeNull()
    await multi.exec()
    expect(await client.get(RedisKeys.costRank.sourceRevision)).toBe('1')
    expect(await client.sismember(RedisKeys.apiKey.set.deleted, id)).toBe(1)
  })
})
