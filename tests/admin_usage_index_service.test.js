import { beforeEach, expect, jest, test } from '@jest/globals'
const indices = new Map()
const scan = jest.fn()
const hget = jest.fn(async (keys) => keys.map((key) => ({ requests: '1', key })))
const client = {
  smembers: jest.fn(async (key) => indices.get(key) ?? []),
  get: jest.fn(async () => null),
  setex: jest.fn(),
  multi: () => {
    let key, ids
    const tx = {
      sadd: (name, ...values) => {
        key = name
        ids = values
        return tx
      },
      expire: () => tx,
      exec: async () => {
        indices.set(key, ids)
        return []
      }
    }
    return tx
  }
}
jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: { getClientSafe: () => client, scanKeys: scan, batchHgetallChunked: hget }
}))
const { getUsageDataByIndex } = await import('../src/modules/admin/admin_usage_index_service.js')
beforeEach(() => {
  indices.clear()
  jest.clearAllMocks()
})

test('multiple cold hourly panels share one namespace scan and preserve model names containing colons', async () => {
  scan.mockResolvedValue([
    'usage:model:hourly:provider:model:2026-10-26:10',
    'usage:hourly:key1:2026-10-26:10',
    'usage:model:hourly:other:2026-10-26:11'
  ])
  const args = [
    'usage:model:hourly:index:2026-10-26:10',
    'usage:model:hourly:{id}:2026-10-26:10',
    'usage:model:hourly:*:2026-10-26:10'
  ]
  const [first, second, other] = await Promise.all([
    getUsageDataByIndex(...args),
    getUsageDataByIndex(...args),
    getUsageDataByIndex(
      'usage:hourly:index:2026-10-26:10',
      'usage:hourly:{id}:2026-10-26:10',
      'usage:hourly:*:2026-10-26:10'
    )
  ])
  expect(scan).toHaveBeenCalledTimes(1)
  expect(scan).toHaveBeenCalledWith('usage:*')
  expect(first).toEqual(second)
  expect(other[0].key).toBe('usage:hourly:key1:2026-10-26:10')
  expect(indices.get(args[0])).toEqual(['provider:model'])
  const warm = await getUsageDataByIndex(...args)
  expect(warm).toEqual(first)
  expect(scan).toHaveBeenCalledTimes(1)
})
test('reconstructs account/key model compound IDs and keeps owner and model separate', async () => {
  scan.mockResolvedValue(['account_usage:model:daily:account1:provider:model:2026-10-26'])
  const args = [
    'account_usage:model:daily:index:2026-10-26',
    'account_usage:model:daily:{accountId}:{model}:2026-10-26',
    'account_usage:model:daily:*:*:2026-10-26'
  ]
  const first = await getUsageDataByIndex(...args)
  expect(indices.get(args[0])).toEqual(['account1:provider:model'])
  expect(await getUsageDataByIndex(...args)).toEqual(first)
})
test('failed in-flight scans are cleared and do not poison later reads', async () => {
  const args = ['usage:daily:index:day', 'usage:daily:{id}:day', 'usage:daily:*:day']
  scan.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])
  await expect(getUsageDataByIndex(...args)).rejects.toThrow('offline')
  expect(await getUsageDataByIndex(...args)).toEqual([])
  expect(scan).toHaveBeenCalledTimes(2)
  expect(client.setex).toHaveBeenCalledTimes(1)
})
