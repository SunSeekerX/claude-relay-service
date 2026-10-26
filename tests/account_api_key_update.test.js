import { beforeEach, describe, expect, jest, test } from '@jest/globals'
const hashes = new Map()
const client = {
  hgetall: jest.fn(async (key) => ({ ...hashes.get(key) })),
  hset: jest.fn(async (key, value) => { if (!Object.keys(value).length) throw new Error('Redis HSET requires fields'); hashes.set(key, { ...hashes.get(key), ...value }); return 1 }),
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
await jest.unstable_mockModule('../src/modules/account/account_group_service.js', () => ({accountGroupService: {}}))
await jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: new Proxy({}, { get: () => jest.fn() }) }))
await jest.unstable_mockModule('../src/modules/webhook/webhook_notifier.js', () => ({ webhookNotifier: {} }))
await jest.unstable_mockModule('../src/modules/relay/relay_upstream_error_helper.js', () => ({}))
jest.useFakeTimers()
const { claudeConsoleAccountService } = await import('../src/modules/account/account_claude_console_service.js')
const { ccrAccountService } = await import('../src/modules/account/account_ccr_service.js')
const { openaiResponsesAccountService } = await import('../src/modules/account/account_openai_responses_service.js')
const { geminiApiAccountService } = await import('../src/modules/account/account_gemini_api_service.js')
const azureOpenaiAccountService = await import('../src/modules/account/account_azure_openai_service.js')
jest.clearAllTimers()
jest.useRealTimers()
const { RedisKeys } = await import('../src/infra/redis_key.js')
const { readMappedAccountModelRange } = await import('../src/common/compat_account_models.js')
beforeEach(() => { hashes.clear(); jest.clearAllMocks() })


const services = [
 ['Console', claudeConsoleAccountService, RedisKeys.accounts.claudeConsole],
 ['CCR', ccrAccountService, RedisKeys.accounts.ccr],
 ['OpenAI Responses', openaiResponsesAccountService, RedisKeys.accounts.openaiResponses],
 ['Gemini API', geminiApiAccountService, RedisKeys.accounts.geminiApi],
 ['Azure', azureOpenaiAccountService, RedisKeys.accounts.azureOpenai]
]
describe.each(services)('%s API Key update protection', (_type, service, keyOf) => {
  const create = () => service.createAccount({ name: 'fixture', apiUrl: 'https://example.invalid', baseApi: 'https://example.invalid', azureEndpoint: 'https://example.invalid', deploymentName: 'fixture', apiKey: 'fixture-original-secret' })
  test('ordinary edits and empty credentials preserve the exact encrypted value', async () => {
    const account = await create()
    const original = hashes.get(keyOf(account.id)).apiKey
    for (const updates of [{ description: 'new' }, { apiKey: '' }, { apiKey: '  ' }, { apiKey: null }, { apiKey: undefined }]) {
      await service.updateAccount(account.id, { ...updates })
      expect(hashes.get(keyOf(account.id)).apiKey).toBe(original)
      expect((await service.getAccount(account.id)).apiKey).toBe('fixture-original-secret')
    }
  })
  test.each(['***','abcd***efgh','••••••',42,{}])('rejects placeholder or malformed credential %j before writing', async (apiKey) => {
    const account = await create()
    const before = {...hashes.get(keyOf(account.id))}
    client.hset.mockClear()
    await expect(service.updateAccount(account.id, { apiKey, name: 'must-not-change' })).rejects.toMatchObject({statusCode: 400})
    expect(client.hset).not.toHaveBeenCalled()
    expect(hashes.get(keyOf(account.id))).toEqual(before)
  })
  test('explicit valid replacement retains the existing encryption and API contract', async () => {
    const account = await create()
    const before = hashes.get(keyOf(account.id)).apiKey
    await service.updateAccount(account.id, { apiKey: '  fixture-new-secret  ' })
    expect(hashes.get(keyOf(account.id)).apiKey).not.toBe(before)
    expect(hashes.get(keyOf(account.id)).apiKey).not.toContain('fixture-new-secret')
    expect((await service.getAccount(account.id)).apiKey).toBe('fixture-new-secret')
  })
})
