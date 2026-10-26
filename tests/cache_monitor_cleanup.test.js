import { afterAll, beforeAll, expect, jest, test } from '@jest/globals'
jest.useFakeTimers()
const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: log }))
const { cacheMonitor } = await import('../src/common/cache_monitor.js')
const cache = {
  cache: new Map(),
  cleanup: jest.fn(),
  clear: jest.fn(),
  getStats: () => ({ size: 0, hits: 0, misses: 0, evictions: 0 })
}
beforeAll(() => {
  cacheMonitor.monitors.clear()
  cacheMonitor.registerCache('fixture', cache)
})
afterAll(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
})
test('old cache registration cannot trigger extra full clears or recurring warnings', () => {
  jest.advanceTimersByTime(60 * 60 * 1000)
  expect(cache.cleanup).toHaveBeenCalledTimes(6)
  expect(cache.clear).toHaveBeenCalledTimes(2)
  expect(log.warn).not.toHaveBeenCalled()
  expect(log.debug).toHaveBeenCalledTimes(2)
})
