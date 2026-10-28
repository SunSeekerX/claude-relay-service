import { beforeEach, expect, jest, test } from '@jest/globals'

const accounts = new Map()
const session = new Map()
const apiKey = { id: 'key' }
const accountService = {
  getAllAccounts: jest.fn(async () => [...accounts.values()]),
  getAccount: jest.fn(async (id) => accounts.get(id)),
}
const groupService = {
  getGroup: jest.fn(async () => ({ id: 'group', name: 'Grok group', platform: 'grok' })),
  getGroupMembers: jest.fn(async () => [...accounts.keys()]),
}
const assertGroupRequestAllowed = jest.fn(async () => {})
const assertModelAccess = jest.fn()
const redis = {
  getSessionAccountMapping: jest.fn(async (key) => session.get(key)),
  setSessionAccountMapping: jest.fn(async (key, id) => session.set(key, id)),
  extendSessionAccountMappingTTL: jest.fn(),
  getClientSafe: () => ({ sadd: jest.fn() }),
  getAccountDailyCost: jest.fn(async () => 20),
}
const mocks = {
  '../src/modules/account/account_grok_service.js': { grokAccountService: accountService },
  '../src/modules/account/account_group_service.js': { accountGroupService: groupService },
  '../src/modules/account/account_group_policy.js': {
    collectExclusiveMemberIds: async () => new Set(),
    assertGroupRequestAllowed,
    releaseGroupCostHolds: async () => {},
  },
  '../src/modules/relay/relay_model_access.js': { assertModelAccess },
  '../src/infra/redis.js': { redis },
  '../src/infra/redis_key.js': {
    RedisKeys: { session: { unifiedGrokMapping: (id) => id, grokAccountSessions: (id) => `sessions:${id}` } },
  },
  '../src/common/logger.js': { logger: Object.fromEntries(['info', 'warn', 'error'].map((name) => [name, jest.fn()])) },
  '../src/common/xai_helper.js': { mapModel: (model) => model },
  '../src/common/common_helper.js': {
    isTruthy: (value) => value === true || value === 'true',
    isAutoProtectionDisabled: (account) => account.disableAutoProtection === true,
    isAccountHealthy: (account) => account.status === 'active',
    sortAccountsByPriority: (items) => [...items].sort((a, b) => a.priority - b.priority),
  },
  '../src/modules/relay/relay_upstream_error_helper.js': { isTempUnavailable: async () => false },
}
for (const [name, value] of Object.entries(mocks)) {
  jest.unstable_mockModule(name, () => value)
}
const { grokScheduler } = await import('../src/modules/relay/relay_grok_scheduler.js')

beforeEach(() => {
  jest.clearAllMocks()
  accounts.clear()
  session.clear()
  for (const [index, id] of ['first', 'second', 'third'].entries()) {
    accounts.set(id, {
      id,
      isActive: true,
      schedulable: true,
      disableAutoProtection: true,
      authType: 'apikey',
      apiKey: 'fixture',
      accountType: 'shared',
      supportedModels: ['grok-test'],
      priority: index + 1,
    })
  }
})

test.each([null, 'group:group'])(
  'excludes attempted accounts before sticky and priority selection with binding %s',
  async (binding) => {
    const key = { ...apiKey, grokAccountId: binding }
    session.set('sticky', 'first')
    const excludedAccountIds = new Set(['first'])
    const second = await grokScheduler.selectAccount(key, 'grok-test', 'sticky', {
      excludedAccountIds,
      deferGroupAdmission: true,
    })
    expect(second.id).toBe('second')
    excludedAccountIds.add('second')
    expect((await grokScheduler.selectAccount(key, 'grok-test', 'sticky', { excludedAccountIds })).id).toBe('third')
    excludedAccountIds.add('third')
    await expect(grokScheduler.selectAccount(key, 'grok-test', 'sticky', { excludedAccountIds })).rejects.toThrow(
      'No available Grok',
    )
    expect(assertModelAccess).toHaveBeenCalledWith(key, 'grok-test')
    if (binding) {
      expect(assertGroupRequestAllowed.mock.calls[0][1]).toMatchObject({ deferAdmission: true })
    }
  },
)

test.each([{ isActive: false }, { schedulable: false }, { supportedModels: ['other-model'] }, { dailyQuota: 10 }])(
  'preserves hard gates when automatic protection is disabled: %j',
  async (patch) => {
    Object.assign(accounts.get('second'), patch)
    const selected = await grokScheduler.selectAccount(apiKey, 'grok-test', null, {
      excludedAccountIds: new Set(['first']),
    })
    expect(selected.id).toBe('third')
  },
)

test('does not escape a dedicated binding when its only account was already attempted', async () => {
  await expect(
    grokScheduler.selectAccount({ ...apiKey, grokAccountId: 'first' }, 'grok-test', null, {
      excludedAccountIds: new Set(['first']),
    }),
  ).rejects.toMatchObject({ code: 'grok_binding_unavailable' })
})
