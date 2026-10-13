import { jest } from '@jest/globals'
import crypto from 'node:crypto'
import Redis from 'ioredis'
import { RedisKeys } from '../src/infra/redis_key.js'
import { getDateStringInTimezone } from '../src/common/timezone.js'

jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: new Proxy({}, { get: () => jest.fn() })
}))
const { attach: attachStats } = await import('../src/infra/redis_system_stats_store.js')
const { attach: attachScan } = await import('../src/infra/redis_scan_batch_store.js')
const { attach: attachUsage } = await import('../src/infra/redis_usage_stats_store.js')
const { attach: attachKeys } = await import('../src/infra/redis_api_key_store.js')
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
})
