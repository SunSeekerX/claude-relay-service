import Redis from 'ioredis'
import crypto from 'node:crypto'
import { RedisLua } from '../src/infra/redis_lua.js'
import { attach } from '../src/infra/redis_gemini_interactions_store.js'
import { RedisKeys } from '../src/infra/redis_key.js'

const suite = process.env.CRS_TEST_REDIS_URL ? describe : describe.skip
suite('Interactions and authentication alerts on disposable local Redis', () => {
  let client
  let store
  beforeAll(async () => {
    const url = new URL(process.env.CRS_TEST_REDIS_URL)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error('This test only accepts disposable local Redis')
    }
    client = new Redis(url.toString(), { lazyConnect: true, retryStrategy: null })
    await client.connect()
    store = { getClientSafe: () => client }
    attach(store)
  })
  afterAll(async () => {
    if (client) {
      await client.quit()
    }
  })

  it('leases one settlement owner and rejects a stale unlock', async () => {
    const ownerId = crypto.randomUUID()
    const record = { ownerId, id: 'fixture', status: 'completed', billed: false }
    const key = await store.createGeminiInteraction(record)
    const leases = await Promise.all(Array.from({ length: 8 }, () => store.lockGeminiInteraction(key)))
    const winner = leases.find(Boolean)
    expect(leases.filter(Boolean)).toHaveLength(1)
    expect(await store.unlockGeminiInteraction(key, 'stale-owner')).toBe(0)
    expect(await store.lockGeminiInteraction(key)).toBeNull()
    expect(await store.unlockGeminiInteraction(key, winner)).toBe(1)
    expect(await store.lockGeminiInteraction(key)).toBeTruthy()
    expect(await store.getGeminiInteraction('another-owner', 'fixture')).toBeNull()
    const ttl = await client.ttl(key)
    await store.saveGeminiInteraction(key, { ...record, billed: true })
    expect(await client.ttl(key)).toBeLessThanOrEqual(ttl)
  })

  const createWindow = async (ownerId, start, tokens = 0, cost = 0) => {
    const keys = [
      RedisKeys.rateLimit.windowStart(ownerId),
      RedisKeys.rateLimit.tokens(ownerId),
      RedisKeys.rateLimit.cost(ownerId)
    ]
    await client
      .multi()
      .set(keys[0], start, 'PX', 15000)
      .set(keys[1], tokens, 'PX', 15000)
      .set(keys[2], cost, 'PX', 15000)
      .exec()
    return keys
  }

  it('atomically accounts final usage once across concurrent retries and retains window TTLs', async () => {
    const ownerId = crypto.randomUUID()
    const start = Date.now()
    const keys = await createWindow(ownerId, start)
    const key = await store.createGeminiInteraction({ ownerId, id: 'metered', billed: true, ratedCost: 0.25 })
    const before = await client.pttl(keys[1])
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.recordGeminiInteractionRateLimit(key, ownerId, 125, 0.25))
    )
    expect(results.map(Number).reduce((sum, result) => sum + result, 0)).toBe(1)
    expect(await client.mget(keys[1], keys[2])).toEqual(['125', '0.25'])
    expect(await client.pttl(keys[1])).toBeLessThanOrEqual(before)
    expect(await client.pttl(keys[1])).toBeGreaterThan(0)
    expect(await store.getGeminiInteraction(ownerId, 'metered')).toMatchObject({
      rateLimitRecorded: true,
      rateLimitWindowStart: start
    })
    expect(Number(await store.recordGeminiInteractionRateLimit(key, ownerId, 125, 0.25))).toBe(0)
    expect(await client.get(keys[1])).toBe('125')
  })

  it('uses the active settlement window after a background task crosses into a new window', async () => {
    const ownerId = crypto.randomUUID()
    const key = await store.createGeminiInteraction({ ownerId, id: 'background', billed: true })
    const previousStart = Date.now() - 60000
    await createWindow(ownerId, previousStart)
    const currentStart = Date.now()
    const keys = await createWindow(ownerId, currentStart, 7, 0.1)
    expect(Number(await store.recordGeminiInteractionRateLimit(key, ownerId, 125, 0.25))).toBe(1)
    expect(await client.get(keys[1])).toBe('132')
    expect(Number(await client.get(keys[2]))).toBeCloseTo(0.35)
    expect((await store.getGeminiInteraction(ownerId, 'background')).rateLimitWindowStart).toBe(currentStart)
  })

  it.each(['missing', 'expired'])('does not create or revive a %s settlement window', async (kind) => {
    const ownerId = crypto.randomUUID()
    const key = await store.createGeminiInteraction({ ownerId, id: 'late', billed: true })
    const window = RedisKeys.rateLimit.windowStart(ownerId)
    if (kind === 'expired') {
      await createWindow(ownerId, Date.now(), 7, 0.1)
      await client.pexpire(window, 0)
    }
    expect(Number(await store.recordGeminiInteractionRateLimit(key, ownerId, 125, 0.25))).toBe(0)
    expect(await client.exists(window)).toBe(0)
    expect(await client.get(RedisKeys.rateLimit.tokens(ownerId))).toBe(kind === 'expired' ? '7' : null)
    expect(await store.getGeminiInteraction(ownerId, 'late')).toMatchObject({
      rateLimitRecorded: true,
      rateLimitWindowStart: null
    })
  })

  it('increments tokens while preserving a legitimate zero rated cost', async () => {
    const ownerId = crypto.randomUUID()
    const keys = await createWindow(ownerId, Date.now())
    const key = await store.createGeminiInteraction({ ownerId, id: 'free', billed: true })
    await store.recordGeminiInteractionRateLimit(key, ownerId, 125, 0)
    expect(await client.mget(keys[1], keys[2])).toEqual(['125', '0'])
  })

  it('uses a bounded sliding window and one notification cooldown across concurrent failures', async () => {
    const id = crypto.randomUUID()
    const keys = [
      RedisKeys.upstream.authFailureWindow('openai', id),
      RedisKeys.upstream.authFailureCooldown('openai', id)
    ]
    const report = (time) =>
      client.eval(RedisLua.upstreamAuthAlert, 2, ...keys, time, 300000, crypto.randomUUID(), 5, 300, 900)
    for (let i = 0; i < 4; i++) {
      expect(Number(await report(1000 + i))).toBe(0)
    }
    const winners = await Promise.all(Array.from({ length: 20 }, () => report(2000)))
    expect(winners.map(Number).reduce((a, b) => a + b, 0)).toBe(1)
    expect(await client.zcard(keys[0])).toBe(5)
    expect(await client.ttl(keys[1])).toBeGreaterThan(895)
    expect(Number(await report(400000))).toBe(0)
    expect(await client.zcard(keys[0])).toBe(1)
  })
})
