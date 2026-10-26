import { afterEach, beforeEach, expect, jest, test } from '@jest/globals'

let lock
const tasks = new Map()
const cancelFlags = new Map()
let startedResolve
let started
const perform = jest.fn(async ({ signal }) => {
  startedResolve()
  await new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
  )
})
const client = {
  set: async (key, value, ...args) => {
    if (key === 'tokenizer:task_lock') {
      if (args.includes('NX') && lock) {
        return null
      }
      lock = value
    } else {
      cancelFlags.set(key, value)
    }
    return 'OK'
  },
  get: async (key) => (key === 'tokenizer:task_lock' ? lock : cancelFlags.get(key)),
  eval: async (_script, _count, _key, expected) => {
    if (lock !== expected) {
      return 0
    }
    lock = null
    return 1
  },
}
await jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: {
    getClientSafe: () => client,
    saveTokenizerTask: async (task) => tasks.set(task.id, JSON.parse(JSON.stringify(task))),
    getTokenizerTask: async (id) => tasks.get(id),
    getTokenizerTasks: async () => [...tasks.values()],
  },
}))
await jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: { error: jest.fn() } }))
await jest.unstable_mockModule('../src/modules/tokenizer/tokenizer_assets.js', () => ({
  loadTokenizerAssets: async () => ({ plan: { bundles: [{ id: 'fixture' }] } }),
  performTokenizerAssetTask: perform,
  readTokenizerJson: jest.fn(),
}))
const { startTokenizerTask, cancelTokenizerTask, stopTokenizerTasks, getTokenizerTasks } =
  await import('../src/modules/tokenizer/tokenizer_tasks.js')
beforeEach(() => {
  lock = null
  tasks.clear()
  cancelFlags.clear()
  perform.mockClear()
  started = new Promise((resolve) => {
    startedResolve = resolve
  })
})
afterEach(stopTokenizerTasks)

test('only one task owns execution; cancelling stops the actual runner and releases its lease', async () => {
  const task = await startTokenizerTask({ operation: 'verify', ids: ['fixture'] })
  await started
  await expect(startTokenizerTask({ operation: 'verify', ids: ['fixture'] })).rejects.toMatchObject({ statusCode: 409 })
  await cancelTokenizerTask(task.id)
  await stopTokenizerTasks()
  expect(tasks.get(task.id).state).toBe('cancelled')
  expect(lock).toBeNull()
  expect(perform).toHaveBeenCalledTimes(1)
})

test('expired execution ownership is reported as unconfirmed interruption and is never automatically restarted', async () => {
  tasks.set('old', { id: 'old', state: 'running', operation: 'download', ids: ['fixture'] })
  const result = await getTokenizerTasks()
  expect(result[0]).toMatchObject({ state: 'interrupted' })
  expect(result[0].message).toContain('未确认完成')
  expect(perform).not.toHaveBeenCalled()
})
