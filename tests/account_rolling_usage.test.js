import { expect, jest, test } from '@jest/globals'
import { attach } from '../src/infra/redis_account_usage_store.js'
import { RedisKeys } from '../src/infra/redis_key.js'

const setup = (hashes = new Map(), entries = []) => {
  const client = {
    sscan: jest.fn(async (key) => ['0', entries.filter((entry) => entry.index === key).map((entry) => entry.value)]),
  }
  const store = {
    getClientSafe: () => client,
    batchHgetallChunked: jest.fn(async (keys) => keys.map((key) => hashes.get(key) ?? {})),
    _resolveAccountModelCost: (hash) => Number(hash.cost ?? 0),
  }
  attach(store)
  return { client, store }
}
const now = new Date('2026-11-14T04:30:00Z')
test('sums exact cost snapshots and token/request windows without duplicate account reads', async () => {
  const hashes = new Map()
  const hour = '2026-11-14:12'
  const day = '2026-11-14'
  hashes.set(RedisKeys.accountUsage.hourly('a', hour), {
    requests: '2',
    allTokens: '6',
    'model:deployment:fixture:requests': '2',
  })
  hashes.set(RedisKeys.accountUsage.modelHourly('a', 'deployment:fixture', hour), {
    cost: '0.125',
    inputTokens: '6',
    costedInputTokens: '6',
  })
  hashes.set(RedisKeys.accountUsage.daily('a', day), { requests: '2', allTokens: '6' })
  hashes.set(RedisKeys.accountUsage.modelDaily('a', 'deployment:fixture', day), {
    cost: '0.125',
    inputTokens: '6',
    costedInputTokens: '6',
  })
  const { store, client } = setup(hashes, [
    { index: RedisKeys.accountUsage.modelDailyIndex(day), value: 'a:deployment:fixture' },
  ])
  const result = (await store.batchGetAccountRollingUsage(['a', 'a'], { now, includeDaily: true })).get('a')
  expect(result.fiveHour).toMatchObject({ requests: 2, tokens: 6, cost: 0.125 })
  expect(result.thirtyDay).toMatchObject({ requests: 2, tokens: 6, cost: 0.125 })
  expect(result.dailyHistory[day].cost).toBe(0.125)
  expect(client.sscan).toHaveBeenCalledTimes(30)
  expect(store.batchHgetallChunked.mock.calls[0][0]).toHaveLength(54)
})
test('does not turn Redis read failures into an empty financial report', async () => {
  const { store } = setup()
  store.batchHgetallChunked.mockResolvedValueOnce([null])
  await expect(store.getAccountRollingUsage('a', { now })).rejects.toThrow('Failed to read account usage')
})
test('returns an empty result without Redis calls for no accounts', async () => {
  const { store, client } = setup()
  expect((await store.batchGetAccountRollingUsage([])).size).toBe(0)
  expect(client.sscan).not.toHaveBeenCalled()
})
