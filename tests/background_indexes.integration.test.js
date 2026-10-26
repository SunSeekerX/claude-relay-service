import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals'
import crypto from 'node:crypto'
import Redis from 'ioredis'
import { RedisKeys, TTL } from '../src/infra/redis_key.js'

jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: new Proxy({}, { get: () => jest.fn() })
}))
const { attach: attachProxy } = await import('../src/infra/redis_proxy_store.js')
const { attach: attachTest } = await import('../src/infra/redis_account_test_store.js')
const suite = process.env.CRS_TEST_REDIS_URL ? describe : describe.skip

suite('background indexes on isolated Redis', () => {
  let client
  let adapter
  const platform = `fixture-${crypto.randomUUID()}`
  const configIndex = RedisKeys.account.testConfigIndex(platform)

  beforeAll(async () => {
    client = new Redis(process.env.CRS_TEST_REDIS_URL, { retryStrategy: null })
    await client.ping()
    adapter = { client, getClientSafe: () => client }
    attachProxy(adapter)
    attachTest(adapter)
  })
  afterAll(async () => {
    await client?.quit()
  })

  it('discovers legacy test configurations once and keeps periodic reads off SCAN', async () => {
    const id = crypto.randomUUID()
    await client.hset(RedisKeys.account.testConfig(platform, id), {
      enabled: 'true',
      testHour: '7',
      model: 'gemini-test'
    })
    await client.expire(RedisKeys.account.testConfig(platform, id), TTL.accountTestConfig)
    await adapter.rebuildAccountTestConfigIndex(platform)
    const scan = jest.spyOn(client, 'scan')
    expect(await adapter.getEnabledTestAccounts(platform)).toContainEqual({
      accountId: id,
      cronExpression: '0 7 * * *',
      model: 'gemini-test'
    })
    expect(scan).not.toHaveBeenCalled()
    scan.mockRestore()
    await adapter.saveAccountTestConfig(id, platform, { enabled: false })
    expect(await client.zscore(configIndex, id)).toBeNull()
    expect(await adapter.getEnabledTestAccounts(platform)).toEqual([])
  })

  it('does not schedule expired test configurations and preserves empty model inheritance', async () => {
    const id = crypto.randomUUID()
    await adapter.saveAccountTestConfig(id, platform, {
      enabled: true,
      cronExpression: '0 9 * * *',
      model: ''
    })
    expect(await adapter.getEnabledTestAccounts(platform)).toContainEqual({
      accountId: id,
      cronExpression: '0 9 * * *',
      model: null
    })
    await client.pexpireat(RedisKeys.account.testConfig(platform, id), Date.now() - 1000)
    await client.zadd(configIndex, Date.now() - 1000, id)
    expect(await adapter.getEnabledTestAccounts(platform)).toEqual([])
  })

  it('surfaces failed indexed configuration writes', async () => {
    const id = crypto.randomUUID()
    const transaction = jest.spyOn(client, 'multi').mockReturnValueOnce({
      hset() {
        return this
      },
      expire() {
        return this
      },
      eval() {
        return this
      },
      exec: async () => [[new Error('fixture write failed'), null]]
    })
    await expect(adapter.saveAccountTestConfig(id, platform, { enabled: true })).rejects.toThrow(
      'fixture write failed'
    )
    transaction.mockRestore()
  })

  it('discovers other shards through the index and prunes expired contexts without SCAN', async () => {
    const proxyId = crypto.randomUUID()
    await adapter.saveProxyStats('worker-a', [{ proxyId, contextKey: 'gemini', value: 'a' }])
    await adapter.saveProxyStats('worker-b', [{ proxyId, contextKey: 'gemini', value: 'b' }])
    const scan = jest.spyOn(client, 'scan')
    const values = []
    for await (const entry of adapter.iterateProxyStats()) {
      values.push(entry)
    }
    const key = RedisKeys.proxy.stats(proxyId, 'gemini')
    expect(values).toContainEqual({ key, value: { 'worker-a': 'a', 'worker-b': 'b' } })
    expect(scan).not.toHaveBeenCalled()
    expect(await client.ttl(key)).toBeGreaterThan(0)
    await client.zadd(RedisKeys.proxy.statsIndex, Date.now() - 1000, key)
    const remaining = []
    for await (const entry of adapter.iterateProxyStats()) {
      remaining.push(entry)
    }
    expect(remaining.some((entry) => entry.key === key)).toBe(false)
    scan.mockRestore()
  })

  it('restores legacy stats with their remaining TTL and excludes probe locks', async () => {
    const proxyId = crypto.randomUUID()
    const key = RedisKeys.proxy.stats(proxyId, 'claude')
    const lock = RedisKeys.proxy.probeLock(proxyId, 'claude')
    await client.hset(key, 'old-worker', 'old-state')
    await client.expire(key, 60)
    await client.set(lock, 'locked', 'EX', 30)
    await adapter.rebuildProxyStatsIndex()
    expect(Number(await client.zscore(RedisKeys.proxy.statsIndex, key))).toBeGreaterThan(Date.now())
    expect(await client.zscore(RedisKeys.proxy.statsIndex, lock)).toBeNull()
  })
})
