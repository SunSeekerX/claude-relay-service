import { jest } from '@jest/globals'
const commands = []
const removed = []
const keys = Array.from({ length: 405 }, (_, index) => `temp_unavailable:openai-responses:${index}`)
const scanKeys = jest.fn().mockResolvedValue(keys)
const client = {
  keys: jest.fn(() => {
    throw new Error('blocking KEYS is forbidden')
  }),
  pipeline: () => {
    const pending = []
    const pipeline = {
      get: (key) => {
        pending.push(['get', key])
        return pipeline
      },
      ttl: (key) => {
        pending.push(['ttl', key])
        return pipeline
      },
      del: (key) => {
        removed.push(key)
        return pipeline
      },
      exec: async () => {
        if (pending.length) {
          commands.push(pending.length)
        }
        return pending.map(([kind, key]) => [
          null,
          kind === 'get'
            ? JSON.stringify({ statusCode: 503, cooldownSeconds: 60 })
            : key.endsWith(':0')
              ? -1
              : 30
        ])
      }
    }
    return pipeline
  }
}
const redis = { getClientSafe: () => client, scanKeys }
jest.unstable_mockModule('node:module', () => ({
  createRequire: () => (name) => (name.includes('redis') ? { redis } : { config: {} })
}))
jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: new Proxy({}, { get: () => jest.fn() })
}))
const { getAllTempUnavailable } =
  await import('../src/modules/relay/relay_upstream_error_helper.js')

it('uses SCAN and bounded pipelines while retaining TTL status and cleanup', async () => {
  const result = await getAllTempUnavailable()
  expect(client.keys).not.toHaveBeenCalled()
  expect(scanKeys).toHaveBeenCalledWith('temp_unavailable:*')
  expect(commands).toEqual([400, 400, 10])
  expect(removed).toEqual(['temp_unavailable:openai-responses:0'])
  expect(Object.keys(result)).toHaveLength(404)
  expect(result['openai-responses:1']).toMatchObject({
    statusCode: 503,
    ttl: 30,
    cooldownSeconds: 60
  })
})
