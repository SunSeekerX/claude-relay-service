import { jest } from '@jest/globals'
import crypto from 'node:crypto'
import Redis from 'ioredis'
import { RedisKeys, TTL } from '../src/infra/redis_key.js'
import { getDateStringInTimezone } from '../src/common/timezone.js'

jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: new Proxy({}, { get: () => jest.fn() })
}))
const { attach: attachStats } = await import('../src/infra/redis_system_stats_store.js')
const { attach: attachScan } = await import('../src/infra/redis_scan_batch_store.js')
const { attach: attachUsage } = await import('../src/infra/redis_usage_stats_store.js')
const { attach: attachKeys } = await import('../src/infra/redis_api_key_store.js')
const { attach: attachGlobal } = await import('../src/infra/redis_global_stats_store.js')
const suite = process.env.CRS_TEST_REDIS_SOCKET ? describe : describe.skip

suite('typed Redis read paths on an isolated fixture', () => {
  let client
  const cleanup = new Set()
  const id = () => crypto.randomUUID()
  const remember = (key) => {
    cleanup.add(key)
    return key
  }
  const adapter = () => ({ client, getClientSafe: () => client })
  beforeAll(async () => {
    client = new Redis({ path: process.env.CRS_TEST_REDIS_SOCKET, retryStrategy: null })
    await client.ping()
  })
  afterEach(async () => {
    if (cleanup.size) {
      await client.del([...cleanup])
      cleanup.clear()
    }
  })
  afterAll(async () => {
    await client.quit()
  })

  it('reads only API Key hashes for today and average stats while indexes are missing', async () => {
    const keyId = id()
    const today = getDateStringInTimezone()
    await client.hset(remember(RedisKeys.apiKey.byId(keyId)), {
      createdAt: new Date().toISOString(),
      name: 'fixture'
    })
    await client.sadd(remember(`apikey:fixture_set:${keyId}`), keyId)
    await client.hset(remember(RedisKeys.usage.daily(keyId, today)), {
      requests: 2,
      tokens: 100,
      inputTokens: 80,
      outputTokens: 20
    })
    await client.hset(remember(RedisKeys.usage.total(keyId)), {
      totalRequests: 2,
      totalTokens: 100,
      totalInputTokens: 80,
      totalOutputTokens: 20
    })
    const store = adapter()
    attachScan(store)
    attachStats(store)
    store.scanApiKeyIds = jest.fn().mockResolvedValue([keyId])
    const scan = jest.spyOn(store, 'scanKeys')
    const before = await client.info('errorstats')
    expect(await store.getTodayStats()).toMatchObject({
      requestsToday: 2,
      tokensToday: 100,
      apiKeysCreatedToday: 1
    })
    expect(await store.getSystemAverages()).toMatchObject({
      totalTokens: 100,
      totalInputTokens: 80
    })
    expect(await client.info('errorstats')).toBe(before)
    expect(scan).not.toHaveBeenCalled()
  })

  it('filters index and empty-marker identifiers in both existing and rebuilt indexes', async () => {
    const prefix = remember(`fixture:${id()}`)
    const index = remember(`${prefix}:index`)
    const empty = remember(`${index}:empty`)
    const valid = remember(`${prefix}:valid`)
    const extract = new RegExp(`^${prefix}:(.+)$`)
    await client.set(empty, '0')
    await client.hset(valid, 'name', 'valid')
    await client.sadd(index, 'index', 'index:empty', 'valid')
    const store = adapter()
    attachScan(store)
    expect(await store.getAllIdsByIndex(index, `${prefix}:*`, extract)).toEqual(['valid'])
    await client.del(index)
    expect(await store.getAllIdsByIndex(index, `${prefix}:*`, extract)).toEqual(['valid'])
    expect(await client.smembers(index)).toEqual(['valid'])
  })

  it('loads names and retained usage in bounded batches, including records for removed keys', async () => {
    const keyIds = Array.from({ length: 53 }, id)
    for (const keyId of keyIds) {
      await client.hset(remember(RedisKeys.apiKey.byId(keyId)), 'name', keyId)
      await client.lpush(
        remember(RedisKeys.usage.records(keyId)),
        JSON.stringify({
          timestamp: '2026-10-13T12:00:00.000Z',
          accountId: 'target',
          cost: 0,
          realCost: 1e-10
        })
      )
    }
    await client.del(RedisKeys.apiKey.byId(keyIds[52]))
    const store = adapter()
    attachUsage(store)
    const batches = []
    for await (const batch of store.iterateUsageRecordBatches(keyIds)) {
      batches.push(batch)
    }
    expect(batches.map((batch) => batch.length)).toEqual([50, 3])
    expect(batches[1][2]).toMatchObject({
      keyId: keyIds[52],
      name: keyIds[52],
      records: [{ realCost: 1e-10 }]
    })
  })

  it('keeps valid records when another record is invalid JSON or null', async () => {
    const keyId = id()
    await client.lpush(remember(RedisKeys.usage.records(keyId)), 'broken', 'null', '{"cost":0}')
    const store = adapter()
    attachUsage(store)
    const batches = []
    for await (const batch of store.iterateUsageRecordBatches([keyId])) {
      batches.push(...batch)
    }
    expect(batches[0].records).toEqual([{ cost: 0 }])
  })

  it('generic API Key listing uses the primary IDs instead of HGETALL on namespace sets', async () => {
    const keyId = id()
    await client.hset(remember(RedisKeys.apiKey.byId(keyId)), 'name', 'valid')
    const store = adapter()
    attachScan(store)
    attachKeys(store)
    store.scanApiKeyIds = jest.fn().mockResolvedValue([keyId])
    expect(await store.getAllApiKeys()).toEqual([{ id: keyId, name: 'valid' }])
  })

  it.each(['daily', 'monthly'])('reads %s model data from its index without scanning metadata', async (period) => {
    const daily = period === 'daily'
    const date = daily ? '2069-01-02' : '2069-01'
    const index = remember(daily
      ? RedisKeys.usage.modelDailyIndex(date) : RedisKeys.usage.modelMonthlyIndex(date))
    const model = `claude:alias:${id()}`
    const key = remember(daily
      ? RedisKeys.usage.modelDaily(model, date) : RedisKeys.usage.modelMonthly(model, date))
    await client.hset(key, { requests: 2, inputTokens: 20, outputTokens: 9, ratedCostMicro: 5 })
    await client.sadd(index, model, 'index')
    const store = adapter()
    attachScan(store)
    attachUsage(store)
    const scan = jest.spyOn(store, 'scanKeys')
    const before = await client.info('errorstats')
    expect(await store.getGlobalModelUsage(period, date)).toEqual([{
      key, data: { requests: '2', inputTokens: '20', outputTokens: '9', ratedCostMicro: '5' }
    }])
    expect(scan).not.toHaveBeenCalled()
    expect(await client.info('errorstats')).toBe(before)
  })

  it.each(['daily', 'monthly'])('rebuilds a missing %s model index with TTL and preserves colon names', async (period) => {
    const daily = period === 'daily'
    const date = daily ? '2069-02-03' : '2069-02'
    const index = remember(daily
      ? RedisKeys.usage.modelDailyIndex(date) : RedisKeys.usage.modelMonthlyIndex(date))
    remember(RedisKeys.emptyMarker(index))
    const model = `claude:legacy:${id()}`
    const key = remember(daily
      ? RedisKeys.usage.modelDaily(model, date) : RedisKeys.usage.modelMonthly(model, date))
    await client.hset(key, { requests: 1, outputTokens: 9 })
    const store = adapter()
    attachScan(store)
    attachUsage(store)
    const scan = jest.spyOn(store, 'scanKeys')
    expect(await store.getGlobalModelUsage(period, date)).toEqual([{
      key, data: { requests: '1', outputTokens: '9' }
    }])
    expect(await client.smembers(index)).toEqual([model])
    const ttl = await client.ttl(index)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(daily ? TTL.usageDaily : TTL.usageMonthly)
    await store.getGlobalModelUsage(period, date)
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('caches an empty model period and never HGETALLs its empty marker', async () => {
    const date = '2069-03-04'
    const index = remember(RedisKeys.usage.modelDailyIndex(date))
    remember(RedisKeys.emptyMarker(index))
    const store = adapter()
    attachScan(store)
    attachUsage(store)
    const scan = jest.spyOn(store, 'scanKeys')
    const before = await client.info('errorstats')
    expect(await store.getGlobalModelUsage('daily', date)).toEqual([])
    expect(await store.getGlobalModelUsage('daily', date)).toEqual([])
    expect(scan).toHaveBeenCalledTimes(1)
    expect(await client.info('errorstats')).toBe(before)
  })

  it.each(['migrateGlobalStats', 'ensureMonthlyMonthsIndex'])('%s uses SCAN and keeps month-index semantics', async (method) => {
    const keyId = id()
    await client.hset(remember(RedisKeys.usage.total(keyId)), {
      totalRequests: 2, totalInputTokens: 10, totalOutputTokens: 9, totalAllTokens: 19
    })
    await client.hset(remember(RedisKeys.usage.modelMonthly(`fixture:${keyId}`, '2069-04')), 'requests', 2)
    await client.sadd(remember(RedisKeys.usage.modelMonthlyIndex('2069-04')), `fixture:${keyId}`)
    remember(RedisKeys.usage.modelMonthlyMonths)
    remember(RedisKeys.usage.globalTotal)
    const store = adapter()
    attachScan(store)
    attachGlobal(store)
    store.scanApiKeyIds = jest.fn().mockResolvedValue([keyId])
    const keys = jest.spyOn(client, 'keys').mockImplementation(() => {
      throw new Error('Blocking KEYS is forbidden in this fixture')
    })
    const scan = jest.spyOn(store, 'scanKeys')
    try {
      await store[method]()
      expect(await client.smembers(RedisKeys.usage.modelMonthlyMonths)).toEqual(['2069-04'])
      expect(scan).toHaveBeenCalledWith(RedisKeys.usage.modelMonthlyPattern)
      expect(keys).not.toHaveBeenCalled()
      if (method === 'migrateGlobalStats') {
        expect(await client.hgetall(RedisKeys.usage.globalTotal)).toMatchObject({
          requests: '2', inputTokens: '10', outputTokens: '9', allTokens: '19'
        })
      }
    } finally {
      keys.mockRestore()
    }
  })
})
