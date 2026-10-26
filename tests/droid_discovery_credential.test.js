import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals'

let account
const write = jest.fn(async (_id, value, settings = {}) => {
  const { modelCatalog: _catalog, supportedModels: _models, modelDiscoveryApiKey: _key, ...state } = value
  account = { ...account, ...state, ...settings }
})
await jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: {
    getDroidAccount: async () => ({ ...account }),
    getAllDroidAccounts: async () => [{ ...account }],
    setDroidAccount: write,
  },
}))
await jest.unstable_mockModule('../config/config.js', () => ({
  config: { security: { encryptionKey: 'local-credential-fixture-only' } },
}))
await jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: new Proxy({}, { get: () => jest.fn() }) }))
await jest.unstable_mockModule('../src/modules/relay/relay_upstream_error_helper.js', () => ({}))
await jest.unstable_mockModule('../src/modules/webhook/webhook_notifier.js', () => ({ webhookNotifier: {} }))
jest.useFakeTimers()
const { droidAccountService } = await import('../src/modules/account/account_droid_service.js')
afterAll(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
})
beforeEach(() => {
  account = {
    id: 'droid-account',
    name: 'fixture',
    authenticationMethod: 'oauth',
    isActive: 'true',
    schedulable: 'true',
    accessToken: '',
    refreshToken: '',
    apiKeys: '',
    endpointType: 'anthropic',
  }
  write.mockClear()
})

describe('Droid dedicated model discovery credentials', () => {
  test('shared-pool enumeration excludes dedicated and group accounts while retaining legacy shared accounts', async () => {
    account.status = 'active'
    account.accountType = 'dedicated'
    expect(await droidAccountService.getSchedulableAccounts('anthropic')).toEqual([])
    account.accountType = 'group'
    expect(await droidAccountService.getSchedulableAccounts('anthropic')).toEqual([])
    delete account.accountType
    expect((await droidAccountService.getSchedulableAccounts('anthropic')).map((value) => value.id)).toEqual([
      account.id,
    ])
  })
  test('dedicated sync key is AES encrypted and never changes OAuth invocation mode', async () => {
    const key = 'fk_fixture_discovery_secret'
    await droidAccountService.updateAccount(account.id, { modelDiscoveryApiKey: key })
    expect(account.modelDiscoveryApiKey).toMatch(/^[a-f0-9]{32}:[a-f0-9]+$/)
    expect(account.modelDiscoveryApiKey).not.toContain(key)
    expect(account.authenticationMethod).toBe('oauth')
    expect(account.apiKeys).toBe('')
    expect(await droidAccountService.getModelDiscoveryApiKey(account.id)).toBe(key)
    const view = await droidAccountService.getAccount(account.id)
    expect(view.hasModelDiscoveryApiKey).toBe(true)
    expect(view.modelDiscoveryApiKey).toBeUndefined()
    expect((await droidAccountService.getAllAccounts())[0].modelDiscoveryApiKey).toBeUndefined()
  })
  test('blank preserves the stored encrypted value; explicit null removes only the sync credential', async () => {
    await droidAccountService.updateAccount(account.id, { modelDiscoveryApiKey: 'fk_fixture_discovery_secret' })
    const encrypted = account.modelDiscoveryApiKey
    await droidAccountService.updateAccount(account.id, { modelDiscoveryApiKey: '' })
    expect(account.modelDiscoveryApiKey).toBe(encrypted)
    await droidAccountService.updateAccount(account.id, { modelDiscoveryApiKey: null })
    expect(account.modelDiscoveryApiKey).toBe('')
    expect(account.authenticationMethod).toBe('oauth')
    expect(await droidAccountService.getModelDiscoveryApiKey(account.id)).toBe('')
  })
  test('invalid credential inputs fail before account data is written', async () => {
    await expect(droidAccountService.updateAccount(account.id, { modelDiscoveryApiKey: false })).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(
      droidAccountService.updateAccount(account.id, { modelDiscoveryApiKey: 'x'.repeat(8193) }),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(write).not.toHaveBeenCalled()
  })
})
