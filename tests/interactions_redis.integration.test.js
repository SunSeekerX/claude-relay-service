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
