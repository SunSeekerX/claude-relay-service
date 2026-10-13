import { jest } from '@jest/globals'
import crypto from 'node:crypto'
import Redis from 'ioredis'
import { RedisKeys, TTL } from '../src/infra/redis_key.js'
import { RedisLua } from '../src/infra/redis_lua.js'
jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: new Proxy({}, { get: () => jest.fn() })
}))
const { attach } = await import('../src/infra/redis_cost_stats_store.js')
const suite = process.env.CRS_TEST_REDIS_SOCKET ? describe : describe.skip

suite('billing Lua on isolated Redis', () => {
  let client
  const createdKeys = new Set()
  const uniqueKey = (name) => {
    const key = `crs-test:${crypto.randomUUID()}:${name}`
    createdKeys.add(key)
    return key
  }
  beforeAll(async () => {
    client = new Redis({
      path: process.env.CRS_TEST_REDIS_SOCKET,
      lazyConnect: true,
      retryStrategy: null
    })
    await client.connect()
  })
  afterAll(async () => {
    if (client) {
      if (createdKeys.size) {
        await client.del([...createdKeys])
      }
      await client.quit()
    }
  })

  it('retries a lost reply without charging or counting the same business turn twice', async () => {
    const keyId = `fixture-${crypto.randomUUID()}`
    const dedupId = crypto.randomUUID()
    let loseReply = true
    const adapter = {
      client: {
        eval: async (...args) => {
          args.slice(2, 5).forEach((key) => createdKeys.add(key))
          const result = await client.eval(...args)
          if (loseReply) {
            loseReply = false
            throw new Error('simulated lost reply')
          }
          return result
        },
        incrbyfloat: (key, amount) => {
          createdKeys.add(key)
          return client.incrbyfloat(key, amount)
        },
        expire: (...args) => client.expire(...args)
      }
    }
    attach(adapter)
    expect(await adapter.incrementDailyCost(keyId, 2, 0, { dedupId })).toBe(true)
    expect(await adapter.incrementDailyCost(keyId, 2, 0, { dedupId })).toBe(false)
    expect(Number(await client.get(RedisKeys.usage.costTotal(keyId)))).toBe(2)
    expect(Number(await client.get(RedisKeys.usage.costRealTotal(keyId)))).toBe(0)
    const dailyKeys = [...createdKeys].filter((key) => key.startsWith('usage:cost:daily:'))
    expect(dailyKeys.length).toBe(1)
    expect(Number(await client.get(dailyKeys[0]))).toBe(2)
  })

  it('validates both cost counters before creating the dedup marker or changing either amount', async () => {
    const dedup = uniqueKey('dedup')
    const total = uniqueKey('total')
    const real = uniqueKey('real')
    await client.set(real, 'corrupt')
    await expect(
      client.eval(RedisLua.cost.incrementTotal, 3, dedup, total, real, '1', '2', 60, 'owner')
    ).rejects.toThrow()
    expect(await client.exists(dedup, total)).toBe(0)
    expect(await client.get(real)).toBe('corrupt')
  })

  it('grants one video settlement, recovers an expired owner and rejects the stale release', async () => {
    const task = uniqueKey('video')
    await client.hset(task, { requestId: 'task', settled: 'false' })
    const now = Date.now()
    const lease = TTL.grokVideoSettlementLease * 1000
    const results = await Promise.all(
      ['a', 'b', 'c'].map((owner) =>
        client.eval(RedisLua.grokVideo.claimSettlement, 1, task, now, owner, lease)
      )
    )
    expect(results.filter((result) => result === 1)).toHaveLength(1)
    const owner = await client.hget(task, 'settlementInProgress')
    expect(
      await client.eval(RedisLua.grokVideo.claimSettlement, 1, task, now + lease + 1, 'new', lease)
    ).toBe(1)
    expect(await client.eval(RedisLua.grokVideo.releaseSettlement, 1, task, owner)).toBe(0)
    expect(await client.hget(task, 'settlementInProgress')).toBe('new')
    expect(
      await client.eval(
        RedisLua.grokVideo.finishSettlement,
        1,
        task,
        owner,
        'completed',
        '3',
        '1',
        new Date().toISOString()
      )
    ).toBe(0)
    expect(await client.hget(task, 'settled')).toBe('false')
    expect(await client.eval(RedisLua.grokVideo.releaseSettlement, 1, task, 'new')).toBe(1)
    expect(
      await client.eval(
        RedisLua.grokVideo.claimSettlement,
        1,
        task,
        now + lease + 2,
        'final',
        lease
      )
    ).toBe(1)
    expect(
      await client.eval(
        RedisLua.grokVideo.finishSettlement,
        1,
        task,
        'final',
        'completed',
        '3',
        '1',
        new Date().toISOString()
      )
    ).toBe(1)
    expect(await client.hget(task, 'actualCost')).toBe('1')
    expect(await client.hget(task, 'settlementInProgress')).toBeNull()
    expect(
      await client.eval(
        RedisLua.grokVideo.claimSettlement,
        1,
        task,
        now + lease + 2,
        'later',
        lease
      )
    ).toBe(0)
  })
})
