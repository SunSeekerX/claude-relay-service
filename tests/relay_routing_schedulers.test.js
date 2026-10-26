import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'

const bedrockAccounts = new Map()
const ccrAccounts = new Map()
const oauthAccounts = new Map()
const apiAccounts = new Map()
const droidAccounts = new Map()
const droidShared = jest.fn(async () => [...droidAccounts.values()])
const markOauth = jest.fn(async () => {})
const markApi = jest.fn(async () => {})
const group = { id: 'group1', name: 'Gemini 组', platform: 'gemini' }
const groupService = {
  getGroup: async () => group,
  getGroupMembers: async () => group.members ?? ['api-member', 'oauth-member', 'anti-member']
}
const routeAccount = jest.fn(async (provider) => ({
  accountId: 'bound',
  accountType: { claude: 'claude-official', openai: 'openai', gemini: 'gemini' }[provider],
  account: { id: 'bound', oauthProvider: 'gemini-cli', supportedModels: [] }
}))
await jest.unstable_mockModule('../src/modules/relay/relay_routing_service.js', () => ({
  getRouteAccount: routeAccount
}))
await jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis: { getClaudeAccount: async () => ({}) } }))
await jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: Object.fromEntries(['debug', 'info', 'warn', 'error', 'success'].map((name) => [name, jest.fn()]))
}))
await jest.unstable_mockModule('../src/modules/account/account_group_service.js', () => ({
  accountGroupService: groupService
}))
await jest.unstable_mockModule('../src/modules/account/account_group_policy.js', () => ({
  assertGroupRequestAllowed: async () => {},
  releaseGroupCostHolds: async () => {}
}))
await jest.unstable_mockModule('../src/modules/relay/relay_upstream_error_helper.js', () => ({
  isTempUnavailable: async () => false
}))
await jest.unstable_mockModule('../src/modules/account/account_droid_service.js', () => ({
  droidAccountService: {
    isSubscriptionExpired: () => false,
    getAccount: async (id) => droidAccounts.get(id),
    getSchedulableAccounts: droidShared,
    touchLastUsedAt: async () => {}
  }
}))
for (const [file, name] of [
  ['account_claude_service.js', 'claudeAccountService'],
  ['account_claude_console_service.js', 'claudeConsoleAccountService'],
  ['account_bedrock_service.js', 'bedrockAccountService'],
  ['account_ccr_service.js', 'ccrAccountService'],
  ['account_openai_responses_service.js', 'openaiResponsesAccountService']
]) {
  await jest.unstable_mockModule(`../src/modules/account/${file}`, () => ({
    [name]: {
      getAccount: async (id) =>
        name === 'bedrockAccountService'
          ? { success: bedrockAccounts.has(id), data: bedrockAccounts.get(id) }
          : name === 'ccrAccountService'
            ? ccrAccounts.get(id)
            : null
    }
  }))
}
await jest.unstable_mockModule('../src/modules/account/account_openai_service.js', () => ({}))
await jest.unstable_mockModule('../src/modules/account/account_gemini_service.js', () => ({
  getAccount: async (id) => oauthAccounts.get(id),
  markAccountUsed: markOauth
}))
await jest.unstable_mockModule('../src/modules/account/account_gemini_api_service.js', () => ({
  geminiApiAccountService: { getAccount: async (id) => apiAccounts.get(id), markAccountUsed: markApi }
}))
const { unifiedClaudeScheduler } = await import('../src/modules/relay/relay_unified_claude_scheduler.js')
const { unifiedOpenAIScheduler } = await import('../src/modules/relay/relay_unified_openai_scheduler.js')
const { unifiedGeminiScheduler } = await import('../src/modules/relay/relay_unified_gemini_scheduler.js')
const { droidScheduler } = await import('../src/modules/relay/relay_droid_scheduler.js')
const schedulers = [
  ['claude', unifiedClaudeScheduler, 'claude-official'],
  ['openai', unifiedOpenAIScheduler, 'openai'],
  ['gemini', unifiedGeminiScheduler, 'gemini']
]
beforeEach(() => {
  bedrockAccounts.clear()
  ccrAccounts.clear()
  delete group.members
  oauthAccounts.clear()
  apiAccounts.clear()
  droidAccounts.clear()
  droidShared.mockClear()
  group.platform = 'gemini'
  markOauth.mockClear()
  markApi.mockClear()
})
afterEach(() => jest.restoreAllMocks())

test('Interactions prefers API accounts inside a mixed pool without changing other callers priority order', async () => {
  const candidates = [
    { accountId: 'oauth', accountType: 'gemini', name: 'OAuth', priority: 1, lastUsedAt: '0' },
    { accountId: 'api', accountType: 'gemini-api', name: 'API', priority: 100, lastUsedAt: '0' }
  ]
  jest.spyOn(unifiedGeminiScheduler, '_getAllAvailableAccounts').mockResolvedValue(candidates)
  const key = { id: 'key1' }
  expect(
    await unifiedGeminiScheduler.selectAccountForApiKey(key, null, 'model', {
      allowApiAccounts: true,
      preferApiAccounts: true
    })
  ).toMatchObject({ accountId: 'api', accountType: 'gemini-api' })
  expect(
    await unifiedGeminiScheduler.selectAccountForApiKey(key, null, 'model', { allowApiAccounts: true })
  ).toMatchObject({ accountId: 'oauth', accountType: 'gemini' })
})

describe.each(schedulers)('%s named target selection', (provider, scheduler, accountType) => {
  test('unavailable target never falls through to legacy pools or sticky accounts', async () => {
    const available = jest.spyOn(scheduler, '_isAccountAvailable').mockResolvedValue(false)
    const pool = jest.spyOn(scheduler, '_getAllAvailableAccounts').mockResolvedValue([{ accountId: 'outside' }])
    const key = {
      id: 'key1',
      claudeAccountId: 'legacy',
      openaiAccountId: 'legacy',
      geminiAccountId: 'legacy',
      _relayRoute: { code: 'entry', provider, binding: 'bound' }
    }
    await expect(scheduler.selectAccountForApiKey(key, 'sticky', 'requested-model')).rejects.toMatchObject({
      statusCode: 503
    })
    expect(available).toHaveBeenCalledWith('bound', accountType, ...(provider === 'gemini' ? [] : ['requested-model']))
    expect(pool).not.toHaveBeenCalled()
  })

  test('group entry delegates to the bound group before an unrelated forced session can apply', async () => {
    const select = jest
      .spyOn(scheduler, 'selectAccountFromGroup')
      .mockResolvedValue({ accountId: 'member', accountType })
    const key = { id: 'key1', _relayRoute: { code: 'entry', provider, binding: 'group:group1' } }
    const result = await scheduler.selectAccountForApiKey(key, 'sticky', 'requested-model', {
      accountId: 'outside',
      accountType: 'claude-official'
    })
    expect(result.accountId).toBe('member')
    expect(select.mock.calls[0].slice(0, 3)).toEqual(['group1', 'sticky', 'requested-model'])
  })
})

test('Gemini Messages group excludes API and foreign-provider accounts, including an old API sticky binding', async () => {
  apiAccounts.set('api-member', { id: 'api-member', supportedModels: [] })
  oauthAccounts.set('oauth-member', {
    id: 'oauth-member',
    name: 'OAuth',
    oauthProvider: 'gemini-cli',
    supportedModels: ['gemini-fixture'],
    priority: 1
  })
  oauthAccounts.set('anti-member', {
    id: 'anti-member',
    oauthProvider: 'antigravity',
    supportedModels: ['gemini-fixture'],
    priority: 0
  })
  const available = jest.spyOn(unifiedGeminiScheduler, '_isAccountAvailable').mockResolvedValue(true)
  jest
    .spyOn(unifiedGeminiScheduler, '_getSessionMapping')
    .mockResolvedValue({ accountId: 'api-member', accountType: 'gemini-api' })
  const remove = jest.spyOn(unifiedGeminiScheduler, '_deleteSessionMapping').mockResolvedValue()
  jest.spyOn(unifiedGeminiScheduler, '_setSessionMapping').mockResolvedValue()
  const key = { id: 'key1', _relayRoute: { code: 'entry', provider: 'gemini', binding: 'group:group1' } }
  const result = await unifiedGeminiScheduler.selectAccountForApiKey(key, 'sticky', 'gemini-fixture', {
    oauthProvider: 'gemini-cli'
  })
  expect(result).toMatchObject({ accountId: 'oauth-member', accountType: 'gemini' })
  expect(available.mock.calls).toEqual([['oauth-member', 'gemini']])
  expect(remove).toHaveBeenCalled()
  expect(markApi).not.toHaveBeenCalled()
})

test('Claude OAuth and Bedrock model restrictions remain hard gates with auto protection disabled', () => {
  expect(
    unifiedClaudeScheduler._isModelSupportedByAccount(
      { supportedModels: '["claude-b"]', disableAutoProtection: true },
      'claude-official',
      'claude-a'
    )
  ).toBe(false)
  expect(
    unifiedClaudeScheduler._isModelSupportedByAccount(
      { supportedModels: '["claude-b"]' },
      'claude-official',
      'claude-b'
    )
  ).toBe(true)
  expect(
    unifiedClaudeScheduler._isModelSupportedByAccount(
      { supportedModels: ['profile-b'], disableAutoProtection: true },
      'bedrock',
      'profile-a'
    )
  ).toBe(false)
  expect(unifiedClaudeScheduler._isModelSupportedByAccount({ supportedModels: [] }, 'bedrock', 'profile-a')).toBe(true)
})

test('OpenAI and Gemini model filtering preserve explicitly empty unrestricted ranges', () => {
  expect(unifiedOpenAIScheduler._isOpenAIModelSupported({ supportedModels: '["gpt-b"]' }, 'openai', 'gpt-a')).toBe(
    false
  )
  expect(unifiedOpenAIScheduler._isOpenAIModelSupported({ supportedModels: '[]' }, 'openai', 'gpt-a')).toBe(true)
  expect(unifiedGeminiScheduler._isGeminiModelSupported({ supportedModels: ['gemini-b'] }, 'models/gemini-b')).toBe(
    true
  )
  expect(unifiedGeminiScheduler._isGeminiModelSupported({ supportedModels: ['gemini-b'] }, 'gemini-a')).toBe(false)
})

test('Droid group selection uses the requested model and cannot fall back to an unrelated shared account', async () => {
  group.platform = 'droid'
  const common = {
    isActive: true,
    schedulable: true,
    status: 'active',
    endpointType: 'anthropic',
    disableAutoProtection: true
  }
  droidAccounts.set('api-member', { ...common, id: 'api-member', supportedModels: '["m-a"]', priority: 1 })
  droidAccounts.set('oauth-member', { ...common, id: 'oauth-member', supportedModels: '["m-b"]', priority: 100 })
  const key = { id: 'key1', droidAccountId: 'group:group1' }
  expect((await droidScheduler.selectAccount(key, 'anthropic', null, 'm-b')).id).toBe('oauth-member')
  await expect(droidScheduler.selectAccount(key, 'anthropic', null, 'outside')).rejects.toThrow(
    'No available Droid accounts in bound group'
  )
  expect(droidShared).not.toHaveBeenCalled()
})

test.each(['bedrock', 'ccr'])('Claude groups unwrap Bedrock results and still discover %s members', async (type) => {
  group.platform = 'claude'
  group.members = ['member']
  const account = {
    id: 'member',
    name: 'Member',
    isActive: true,
    schedulable: true,
    supportedModels: ['claude-a'],
    disableAutoProtection: true
  }
  ;(type === 'bedrock' ? bedrockAccounts : ccrAccounts).set('member', account)
  const available = jest.spyOn(unifiedClaudeScheduler, '_isAccountAvailable').mockResolvedValue(true)
  const result = await unifiedClaudeScheduler.selectAccountFromGroup('group1', null, 'claude-a', { allowCcr: true })
  expect(result).toEqual({ accountId: 'member', accountType: type })
  expect(available).toHaveBeenCalledWith('member', type, 'claude-a')
})

test('legacy dedicated Bedrock selection sends the requested model through the availability hard gate', async () => {
  bedrockAccounts.set('bedrock-member', { id: 'bedrock-member', name: 'Bedrock', isActive: true, schedulable: true })
  const available = jest.spyOn(unifiedClaudeScheduler, '_isAccountAvailable').mockResolvedValue(true)
  const result = await unifiedClaudeScheduler.selectAccountForApiKey(
    { id: 'key', bedrockAccountId: 'bedrock-member' },
    null,
    'claude-requested'
  )
  expect(result).toEqual({ accountId: 'bedrock-member', accountType: 'bedrock' })
  expect(available).toHaveBeenCalledWith('bedrock-member', 'bedrock', 'claude-requested')
})

test.each(['claude-console', 'ccr'])(
  '%s separates explicit ranges from mappings while retaining legacy restrictions',
  (type) => {
    const mapping = { alias: 'upstream' }
    expect(unifiedClaudeScheduler._isModelSupportedByAccount({ supportedModels: mapping }, type, 'outside')).toBe(false)
    expect(
      unifiedClaudeScheduler._isModelSupportedByAccount(
        { supportedModels: mapping, allowedModels: [] },
        type,
        'outside'
      )
    ).toBe(true)
    expect(
      unifiedClaudeScheduler._isModelSupportedByAccount(
        { supportedModels: mapping, allowedModels: ['other-*'] },
        type,
        'alias'
      )
    ).toBe(false)
    expect(
      unifiedClaudeScheduler._isModelSupportedByAccount(
        { supportedModels: mapping, allowedModels: ['other-*'] },
        type,
        'other-model'
      )
    ).toBe(true)
  }
)
