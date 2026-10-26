import { jest, beforeEach, afterEach, expect, test } from '@jest/globals'
await jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: {} }))
const { attach } = await import('../src/infra/redis_system_stats_store.js')
const { TTL } = await import('../src/infra/redis_key.js')

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(Date.parse('2026-10-26T10:00:00Z'))
})
afterEach(() => {
  jest.useRealTimers()
})

test('concurrent metrics requests share one keyspace traversal, deduplicate SCAN repeats and expose snapshot age', async () => {
  const scan = jest
    .fn()
    .mockResolvedValueOnce([
      '1',
      ['apikey:one', 'apikey:hash_map', 'apikey:idx:name', 'claude:account:one', 'usage:one', 'other:key'],
    ])
    .mockResolvedValueOnce(['0', ['usage:one', 'usage:two']])
  const store = { getClientSafe: () => ({ scan }) }
  attach(store)
  const results = await Promise.all([store.getSystemStats(), store.getSystemStats(), store.getSystemStats()])
  expect(scan).toHaveBeenCalledTimes(2)
  expect(results[0]).toEqual({
    totalApiKeys: 1,
    totalClaudeAccounts: 1,
    totalUsageRecords: 2,
    collectedAt: '2026-10-26T10:00:00.000Z',
    cacheAgeMs: 0,
  })
  jest.advanceTimersByTime(5000)
  expect((await store.getSystemStats()).cacheAgeMs).toBe(5000)
  expect(scan).toHaveBeenCalledTimes(2)
  scan.mockResolvedValue(['0', ['usage:new']])
  jest.advanceTimersByTime(TTL.systemStatsSnapshot * 1000)
  expect((await store.getSystemStats()).totalUsageRecords).toBe(1)
  expect(scan).toHaveBeenCalledTimes(3)
})

test('failed refresh propagates the error and can be retried without returning a stale success', async () => {
  const scan = jest.fn().mockRejectedValueOnce(new Error('Redis unavailable')).mockResolvedValue(['0', []])
  const store = { getClientSafe: () => ({ scan }) }
  attach(store)
  await expect(store.getSystemStats()).rejects.toThrow('Redis unavailable')
  expect((await store.getSystemStats()).totalUsageRecords).toBe(0)
  expect(scan).toHaveBeenCalledTimes(2)
})
