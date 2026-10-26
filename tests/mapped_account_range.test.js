import { beforeEach, describe, expect, jest, test } from '@jest/globals'
const hashes = new Map()
const client = {
  hgetall: jest.fn(async (key) => ({ ...hashes.get(key) })),
  hset: jest.fn(async (key, value) => { hashes.set(key, { ...hashes.get(key), ...value }); return 1 }),
  sadd: jest.fn(async () => 1),
  srem: jest.fn(async () => 1),
  hdel: jest.fn(async () => 1),
}
const redis = {
  getClientSafe: () => client,
  getDateStringInTimezone: () => '2026-10-26',
  addToIndex: jest.fn(async () => {}),
  getAllIdsByIndex: async (_index, _pattern, expression) => [...hashes.keys()].map((key) => key.match(expression)?.[1]).filter(Boolean),
  batchHgetallChunked: async (keys) => keys.map((key) => ({ ...hashes.get(key) })),
  getConsoleAccountConcurrency: async () => 0,
}
await jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis }))
await jest.unstable_mockModule('../config/config.js', () => ({ config: { security: { encryptionKey: 'isolated-model-range-fixture' }, system: { timezoneOffset: 8 } } }))
await jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: new Proxy({}, { get: () => jest.fn() }) }))
await jest.unstable_mockModule('../src/modules/webhook/webhook_notifier.js', () => ({ webhookNotifier: {} }))
await jest.unstable_mockModule('../src/modules/relay/relay_upstream_error_helper.js', () => ({}))
jest.useFakeTimers()
const { claudeConsoleAccountService } = await import('../src/modules/account/account_claude_console_service.js')
const { ccrAccountService } = await import('../src/modules/account/account_ccr_service.js')
jest.clearAllTimers()
jest.useRealTimers()
const { RedisKeys } = await import('../src/infra/redis_key.js')
const { readMappedAccountModelRange } = await import('../src/common/compat_account_models.js')
beforeEach(() => { hashes.clear(); jest.clearAllMocks() })

describe.each([
  ['Console', claudeConsoleAccountService, RedisKeys.accounts.claudeConsole],
  ['CCR', ccrAccountService, RedisKeys.accounts.ccr],
])('%s independent model range and mapping', (_name, service, keyOf) => {
  test('new accounts default to unrestricted while retaining actual mappings', async () => {
    const created = await service.createAccount({ name: 'fixture', apiUrl: 'https://example.invalid', apiKey: 'fixture-key', supportedModels: { alias: 'upstream-model' } })
    expect(created.allowedModels).toEqual([])
    expect(JSON.parse(hashes.get(keyOf(created.id)).allowedModels)).toEqual([])
    expect((await service.getAccount(created.id))).toMatchObject({ allowedModels: [], supportedModels: { alias: 'upstream-model' } })
  })
  test('legacy mapping keys remain restrictions until an explicit new range is saved', async () => {
    const created = await service.createAccount({ name: 'fixture', apiUrl: 'https://example.invalid', apiKey: 'fixture-key', supportedModels: { 'claude-*': 'target', alias: 'target' } })
    delete hashes.get(keyOf(created.id)).allowedModels
    const before = structuredClone(hashes.get(keyOf(created.id)))
    expect((await service.getAccount(created.id)).allowedModels).toEqual(['claude-*', 'alias'])
    expect((await service.getAllAccounts())[0].allowedModels).toEqual(['claude-*', 'alias'])
    expect(hashes.get(keyOf(created.id))).toEqual(before)
    await service.updateAccount(created.id, { allowedModels: [] })
    expect(await service.getAccount(created.id)).toMatchObject({ allowedModels: [], supportedModels: { 'claude-*': 'target', alias: 'target' } })
  })
  test('updating mappings never replaces an explicitly saved range', async () => {
    const created = await service.createAccount({ name: 'fixture', apiUrl: 'https://example.invalid', apiKey: 'fixture-key', allowedModels: ['client'], supportedModels: { client: 'target' } })
    await service.updateAccount(created.id, { supportedModels: { client: 'new-target', extra: 'other' } })
    expect(await service.getAccount(created.id)).toMatchObject({ allowedModels: ['client'], supportedModels: { client: 'new-target', extra: 'other' } })
    await expect(service.updateAccount(created.id, { allowedModels: { invalid: 'map' } })).rejects.toThrow()
    expect((await service.getAccount(created.id)).allowedModels).toEqual(['client'])
  })
})
test('legacy array ranges and explicit empty ranges remain distinct', () => {
  expect(readMappedAccountModelRange({ supportedModels: '["legacy"]' })).toEqual(['legacy'])
  expect(readMappedAccountModelRange({ allowedModels: '[]', supportedModels: '{"alias":"target"}' })).toEqual([])
})
