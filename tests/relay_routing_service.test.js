import { beforeEach, describe, expect, jest, test } from '@jest/globals'

const routes = new Map()
const accounts = new Map()
const groups = new Map()
let groupBlocked = false
const readonlyClient = { get: jest.fn(async () => (groupBlocked ? '100' : null)) }
const fakeRedis = {
  getClientSafe: () => readonlyClient,
  getDateStringInTimezone: () => '2026-10-25',
  getAccountModelState: jest.fn(async (type, id) => {
    const account = accounts.get(id)
    return account && (account.testType ?? 'claude-official') === type ? account : null
  }),
  getAccountModelStates: jest.fn(async (type) =>
    [...accounts.values()].filter((account) => (account.testType ?? 'claude-official') === type),
  ),
  getAccountModelObservation: jest.fn(async () => ({ temporary: false, overloaded: false, concurrency: 0 })),
  getRelayRoute: jest.fn(async (code) => routes.get(code) ?? null),
  saveRelayRoute: jest.fn(async (route, mode) => {
    if (mode === 'create' && routes.has(route.code)) {
      return 'exists'
    }
    if (mode === 'update' && !routes.has(route.code)) {
      return 'missing'
    }
    routes.set(route.code, route)
    return 'ok'
  }),
}
await jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis: fakeRedis }))
await jest.unstable_mockModule('../src/modules/account/account_group_service.js', () => ({
  accountGroupService: {
    getGroup: async (id) => groups.get(id),
    getGroupMembers: async (id) => groups.get(id)?.members ?? [],
    getAllGroups: async () => [...groups.values()],
  },
}))
await jest.unstable_mockModule('../src/modules/account/account_claude_service.js', () => ({
  claudeAccountService: {
    getAccount: async (id) => accounts.get(id),
    getAllAccounts: async () => [...accounts.values()],
  },
}))
await jest.unstable_mockModule('../src/modules/account/account_claude_console_service.js', () => ({
  claudeConsoleAccountService: { getAccount: async (id) => accounts.get(id) },
}))
await jest.unstable_mockModule('../src/modules/pricing/pricing_model_service.js', () => ({
  modelService: { getAllModels: () => ['claude-a', 'claude-b', 'gpt-a'].map((id) => ({ id })) },
}))
await jest.unstable_mockModule('../src/modules/relay/relay_unified_claude_scheduler.js', () => ({
  unifiedClaudeScheduler: {
    _isModelSupportedByAccount: (account, type, model) =>
      ['claude-console', 'ccr'].includes(type) && Array.isArray(account.allowedModels)
        ? !account.allowedModels.length || account.allowedModels.includes(model)
        : Array.isArray(account.supportedModels)
        ? account.supportedModels.length === 0 || account.supportedModels.includes(model)
        : Object.hasOwn(account.supportedModels ?? {}, model),
  },
}))
await jest.unstable_mockModule('../src/modules/proxy/proxy_resolver.js', () => ({ proxyResolver: {} }))
await jest.unstable_mockModule('../src/modules/relay/relay_unified_gemini_scheduler.js', () => ({
  unifiedGeminiScheduler: { _isGeminiModelSupported: (account, model) => !account.supportedModels?.length || account.supportedModels.includes(model) }
}))
await jest.unstable_mockModule('../src/modules/relay/relay_unified_openai_scheduler.js', () => ({
  unifiedOpenAIScheduler: {
    _isOpenAIModelSupported: (account, _type, model) =>
      !account.allowedModels?.length || account.allowedModels.includes(model),
  },
}))

const {
  saveRoute,
  resolveRequestRoute,
  applyRouteBinding,
  getPublicKeyRouting,
  validateKeyRouting,
  getRouteModels,
  resolveKeyModelTestTarget,
} = await import('../src/modules/relay/relay_routing_service.js')
const { invalidateExclusiveMemberCache } = await import('../src/modules/account/account_group_policy.js')
const { modelCatalogSignature } = await import('../src/modules/account/account_model_catalog_service.js')

beforeEach(() => {
  routes.clear()
  groups.clear()
  accounts.clear()
  fakeRedis.getRelayRoute.mockClear()
  invalidateExclusiveMemberCache()
  groupBlocked = false
  accounts.set('account1', {
    id: 'account1',
    email: 'private@example.com',
    accessToken: 'secret-token',
    expiresAt: '2099-01-01T00:00:00Z',
    isActive: true,
    schedulable: true,
    accountType: 'dedicated',
    supportedModels: ['claude-a'],
  })
  groups.set('group1', {
    id: 'group1',
    name: '公开 A 组',
    platform: 'claude',
    members: ['account1'],
    modelWhitelist: ['claude-*'],
  })
})

const routeInput = (extra = {}) => ({
  code: 'a',
  name: '日常入口',
  provider: 'claude',
  binding: 'group:group1',
  formats: ['claude-messages', 'openai-chat'],
  isActive: true,
  ...extra,
})
const keyData = (extra = {}) => ({
  id: 'key1',
  permissions: ['claude'],
  relayRouting: { allowedRoutes: ['a'], defaults: { 'claude-messages': 'a' } },
  ...extra,
})

describe('shared route registry and per-key authorization', () => {
  test('inherited models include explicitly configured custom Console model names outside the built-in catalog', async () => {
    accounts.get('account1').testType = 'claude-console'
    accounts.get('account1').supportedModels = ['glm-custom-deployment']
    await saveRoute(routeInput({ binding: 'console:account1', targetName: '公开实例' }))
    const view = await getPublicKeyRouting(keyData())
    expect(view.routes[0].models).toEqual(['glm-custom-deployment'])
    expect(view.routes[0].targetName).toBe('公开实例')
  })
  test('an existing route resolves identically by explicit URL and protocol default', async () => {
    await saveRoute(routeInput())
    expect((await resolveRequestRoute(keyData(), 'claude-messages')).code).toBe('a')
    expect((await resolveRequestRoute(keyData(), 'claude-messages', 'a')).code).toBe('a')
    expect(await resolveRequestRoute({ permissions: ['claude'] }, 'claude-messages')).toBeNull()
  })

  test('ungranted, disabled, missing and incompatible defaults fail closed', async () => {
    await saveRoute(routeInput())
    await expect(
      resolveRequestRoute(keyData({ relayRouting: { allowedRoutes: [], defaults: {} } }), 'claude-messages', 'a'),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(resolveRequestRoute(keyData(), 'gemini-generate', 'a')).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      resolveRequestRoute(keyData({ permissions: ['openai'] }), 'claude-messages', 'a'),
    ).rejects.toMatchObject({ statusCode: 403 })
    routes.get('a').isActive = false
    await expect(resolveRequestRoute(keyData(), 'claude-messages')).rejects.toMatchObject({ statusCode: 503 })
    routes.delete('a')
    await expect(resolveRequestRoute(keyData(), 'claude-messages')).rejects.toMatchObject({ statusCode: 503 })
  })

  test('binding overrides are request-local and preserve original identity and limits', async () => {
    const route = await saveRoute(routeInput())
    const original = { id: 'key1', openaiAccountId: 'other', claudeAccountId: 'legacy', concurrencyLimit: 3 }
    const effective = applyRouteBinding(original, route)
    expect(effective).toMatchObject({
      id: 'key1',
      concurrencyLimit: 3,
      claudeAccountId: 'group:group1',
      openaiAccountId: '',
    })
    expect(original).toEqual({ id: 'key1', openaiAccountId: 'other', claudeAccountId: 'legacy', concurrencyLimit: 3 })
  })

  test('public data includes group name and valid aliases, never account credentials or mapped target table', async () => {
    await saveRoute(
      routeInput({ modelMapping: { fast: 'claude-a', unavailable: 'claude-b' }, modelMode: 'mapped-only' }),
    )
    const view = await getPublicKeyRouting(keyData())
    expect(view.routes[0]).toMatchObject({ targetName: '公开 A 组', models: ['fast'], basePath: '/r/a' })
    expect(view.routes[0]).not.toHaveProperty('binding')
    expect(view.routes[0]).not.toHaveProperty('modelMapping')
    expect(JSON.stringify(view)).not.toMatch(/secret-token|private@example.com/)
  })

  test('key model restrictions cannot be bypassed by a mapped alias in discovery', async () => {
    await saveRoute(routeInput({ modelMapping: { fast: 'claude-a' } }))
    const view = await getPublicKeyRouting(keyData({ enableModelRestriction: true, restrictedModels: ['claude-a'] }))
    expect(view.routes[0].models).not.toContain('fast')
    expect(view.routes[0].models).not.toContain('claude-a')
  })

  test('deleted route remains visible as unavailable until administrator removes authorization', async () => {
    const view = await getPublicKeyRouting(keyData())
    expect(view.routes[0]).toMatchObject({ code: 'a', status: 'deleted' })
    expect(view.defaults['claude-messages']).toBe('a')
  })

  test('invalid model settings and incompatible default formats reject administrative writes', async () => {
    await expect(saveRoute(routeInput({ provider: '__proto__' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(saveRoute(routeInput({ modelMode: 'other' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(saveRoute(routeInput({ binding: 'account1' }))).rejects.toMatchObject({ statusCode: 400 })
    await saveRoute(routeInput())
    await expect(
      validateKeyRouting({ allowedRoutes: ['a'], defaults: { 'openai-responses': 'a' } }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  test('group models are a union; a paused member keeps its models with blocked readiness', async () => {
    accounts.set('account2', {
      ...accounts.get('account1'),
      id: 'account2',
      supportedModels: ['claude-b'],
      isActive: false,
    })
    groups.get('group1').members.push('account2')
    await saveRoute(routeInput())
    const view = await getPublicKeyRouting(keyData())
    expect(view.routes[0].models).toEqual(['claude-a', 'claude-b'])
    expect(view.routes[0].modelDetailsByFormat['claude-messages']).toEqual([
      expect.objectContaining({ id: 'claude-a', availability: 'ready', source: 'configured' }),
      expect.objectContaining({ id: 'claude-b', availability: 'blocked', source: 'configured' }),
    ])
  })

  test('original group binding and named route use the same discovery result and never add global unsupported models', async () => {
    await saveRoute(routeInput())
    const view = await getPublicKeyRouting(
      keyData({ claudeAccountId: 'group:group1', relayRouting: { allowedRoutes: ['a'], defaults: {} } }),
    )
    expect(view.legacyTargets[0].modelsByFormat['claude-messages']).toEqual(
      view.routes[0].modelsByFormat['claude-messages'],
    )
    expect(view.defaultModelDetailsByFormat['claude-messages'].map((model) => model.id)).toEqual(['claude-a'])
    expect(view.defaultBasePathsByFormat).toEqual({
      'claude-messages': '/api',
      'openai-chat': '/openai/native',
      'openai-responses': '/openai',
      'gemini-generate': '/gemini',
    })
    expect(view.defaultModelDetailsByFormat['claude-messages'].map((model) => model.id)).not.toContain('claude-b')
    expect((await getRouteModels(routes.get('a'), keyData())).map((model) => model.id)).toEqual(['claude-a'])
    expect(await getRouteModels(routes.get('a'), keyData())).toEqual([
      { id: 'claude-a', object: 'model', owned_by: 'claude' },
    ])
  })

  test('shared pools exclude dedicated accounts and exclusive group members', async () => {
    accounts.get('account1').accountType = 'shared'
    groups.get('group1').isExclusive = true
    accounts.set('account2', { ...accounts.get('account1'), id: 'account2', supportedModels: ['claude-b'] })
    accounts.set('account3', { ...accounts.get('account1'), id: 'account3', accountType: 'dedicated' })
    const view = await getPublicKeyRouting(keyData({ relayRouting: { allowedRoutes: [], defaults: {} } }))
    expect(view.defaultModelDetailsByFormat['claude-messages'].map((model) => model.id)).toEqual(['claude-b'])
    expect(view.legacyTargets[0]).toMatchObject({ targetKind: 'shared', targetName: '共享账号池' })
  })
  test('a missing original binding stays unavailable and does not fall back to a shared pool', async () => {
    accounts.get('account1').accountType = 'shared'
    const view = await getPublicKeyRouting(
      keyData({ claudeAccountId: 'missing-account', relayRouting: { allowedRoutes: [], defaults: {} } }),
    )
    expect(view.legacyTargets[0].status).toBe('target-missing')
    expect(view.defaultModelDetailsByFormat['claude-messages']).toEqual([])
  })

  test('successful complete catalogs remove unconfirmed fallback; partial catalogs keep it labeled', async () => {
    const account = accounts.get('account1')
    account.supportedModels = []
    account.modelCatalog = JSON.stringify({
      models: ['claude-a'],
      succeededAt: '2026-10-25T00:00:00Z',
      signature: modelCatalogSignature(account),
      complete: false,
    })
    await saveRoute(routeInput())
    let view = await getPublicKeyRouting(keyData())
    expect(view.routes[0].modelDetailsByFormat['claude-messages']).toEqual([
      expect.objectContaining({ id: 'claude-a', source: 'upstream' }),
      expect.objectContaining({ id: 'claude-b', source: 'unconfirmed' }),
    ])
    account.modelCatalog = JSON.stringify({ ...JSON.parse(account.modelCatalog), complete: true })
    view = await getPublicKeyRouting(keyData())
    expect(view.routes[0].models).toEqual(['claude-a'])
  })
  test('an OpenAI Responses mapping alone does not become a whitelist or suppress unconfirmed system candidates', async () => {
    Object.assign(accounts.get('account1'), {
      testType: 'openai-responses',
      allowedModels: [],
      supportedModels: { fast: 'gpt-a' },
    })
    routes.set(
      'o',
      routeInput({
        code: 'o',
        provider: 'openai',
        binding: 'responses:account1',
        targetName: '公开 OpenAI',
        formats: ['openai-responses'],
        modelMapping: {},
      }),
    )
    const view = await getPublicKeyRouting(
      keyData({
        permissions: ['openai'],
        relayRouting: { allowedRoutes: ['o'], defaults: { 'openai-responses': 'o' } },
      }),
    )
    expect(view.routes[0].models).toEqual(['gpt-a', 'fast'])
    expect(view.routes[0].modelDetailsByFormat['openai-responses'].find((model) => model.id === 'gpt-a')).toMatchObject(
      { source: 'unconfirmed', availability: 'unknown' },
    )
  })

  test('a ready member whose synchronized catalog lacks a model cannot make another member model look ready', async () => {
    const first = accounts.get('account1')
    first.supportedModels = []
    first.modelCatalog = JSON.stringify({
      models: ['claude-a'],
      succeededAt: '2026-10-25T00:00:00Z',
      signature: modelCatalogSignature(first),
    })
    accounts.set('account2', {
      ...first,
      id: 'account2',
      supportedModels: ['claude-b'],
      modelCatalog: undefined,
      isActive: false,
    })
    groups.get('group1').members.push('account2')
    await saveRoute(routeInput())
    const details = (await getPublicKeyRouting(keyData())).routes[0].modelDetailsByFormat['claude-messages']
    expect(details.find((model) => model.id === 'claude-b').availability).toBe('blocked')
  })

  test('account-level alias mapping also respects the Key target-model blacklist', async () => {
    Object.assign(accounts.get('account1'), { testType: 'claude-console', supportedModels: { fast: 'claude-a' } })
    await saveRoute(routeInput({ binding: 'console:account1', targetName: '公开名称' }))
    const view = await getPublicKeyRouting(keyData({ enableModelRestriction: true, restrictedModels: ['claude-a'] }))
    expect(view.routes[0].models).not.toContain('fast')
  })

  test('group admission limits annotate models without removing them', async () => {
    groups.get('group1').rpmLimit = 1
    groupBlocked = true
    await saveRoute(routeInput())
    const view = await getPublicKeyRouting(keyData())
    expect(view.routes[0].models).toEqual(['claude-a'])
    expect(view.routes[0].modelDetailsByFormat['claude-messages'][0]).toMatchObject({
      availability: 'blocked',
      availabilityReason: '分组请求频率已满',
    })
  })

  test('test targets stay in the authorized named or original provider scope', async () => {
    await saveRoute(routeInput())
    await expect(
      resolveKeyModelTestTarget(keyData(), 'claude-messages', { apiId: 'another-key', routeCode: 'a' }, 'claude-a'),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect((await resolveKeyModelTestTarget(keyData(), 'claude-messages', { routeCode: 'a' }, 'claude-a')).path).toBe(
      '/r/a/v1/messages',
    )
    await expect(
      resolveKeyModelTestTarget(keyData(), 'claude-messages', { legacyProvider: 'claude' }, 'claude-a'),
    ).rejects.toMatchObject({ statusCode: 403 })
    const original = keyData({ relayRouting: { allowedRoutes: [], defaults: {} } })
    expect(
      (await resolveKeyModelTestTarget(original, 'openai-chat', { legacyProvider: 'claude' }, 'claude-a')).path,
    ).toBe('/openai/claude/v1/chat/completions')
    await expect(
      resolveKeyModelTestTarget(original, 'openai-chat', { legacyProvider: 'grok' }, 'grok'),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      resolveKeyModelTestTarget(original, 'claude-messages', { routeCode: 'a', legacyProvider: 'claude' }, 'claude-a'),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

const { getRouteModelDetails, resolveDefaultModelRoutes } = await import('../src/modules/relay/relay_routing_service.js')
test('discovery excludes incompatible models, retains unknown capability models, and keeps legacy shared accounts', async () => {
  const account = accounts.get('account1')
  account.testType = 'openai-responses'
  account.accountType = 'shared'
  account.allowedModels = ['gpt-a', 'text-embedding-3-small', 'whisper-1', 'fast-custom', 'gpt-custom']
  account.supportedModels = {}
  const details = await getRouteModelDetails({ provider: 'openai', formats: ['openai-chat'], modelMapping: {} }, { permissions: 'all' }, { kind: 'account', account, accountType: 'openai-responses', accountId: account.id }, new Map(), 'openai-chat')
  expect(details.map((item) => item.id)).toEqual(['gpt-a', 'fast-custom', 'gpt-custom'])
  expect(details.find((item) => item.id === 'fast-custom').interfaceSupport).toBe('unknown')
  expect(details.find((item) => item.id === 'gpt-custom').interfaceSupport).toBe('unknown')
  expect(details.find((item) => item.id === 'gpt-a').interfaceSupport).toBe('supported')
  account.testType = 'openai'
  delete account.accountType
  groups.clear()
  const view = await getPublicKeyRouting({ permissions: ['openai'], relayRouting: { allowedRoutes: [], defaults: {} } })
  expect(view.legacyTargets.find((item) => item.provider === 'openai').modelsByFormat['openai-chat']).toContain('gpt-a')
})
test('model discovery chooses Chat for OpenAI Gemini paths and includes legacy scope when only one OpenAI default is set', async () => {
  await saveRoute(routeInput())
  const key = keyData({ relayRouting: { allowedRoutes: ['a'], defaults: { 'openai-chat': 'a' } } })
  const req = { method: 'GET', path: '/v1/models', originalUrl: '/openai/gemini/v1/models', headers: {} }
  expect((await resolveDefaultModelRoutes(key, req)).map((entry) => [entry.code, entry.discoveryFormat])).toEqual([['a', 'openai-chat']])
  req.originalUrl = '/openai/v1/models'
  const scopes = await resolveDefaultModelRoutes(key, req)
  expect(scopes.map((entry) => entry.discoveryFormat)).toEqual(['openai-chat', 'openai-responses'])
  expect(scopes[1].legacyProvider).toBe('openai')
  expect(await getRouteModels({ ...routes.get('a'), formats: ['openai-chat'] }, key, null, new Map(), 'claude-messages')).toEqual([])
})

test('a mixed Gemini group advertises API-only models for Chat but excludes them from Claude Messages', async () => {
  const common = { isActive: true, schedulable: true, accessToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' }
  accounts.set('oauth', { ...common, id: 'oauth', testType: 'gemini', supportedModels: ['gemini-oauth'], oauthProvider: 'gemini-cli' })
  accounts.set('api', { ...common, id: 'api', testType: 'gemini-api', supportedModels: ['gemini-api-only'] })
  const group = { id: 'gemini-group', platform: 'gemini', members: ['oauth', 'api'] }
  groups.set(group.id, group)
  const route = { provider: 'gemini', binding: 'group:gemini-group', formats: ['claude-messages', 'openai-chat'], modelMapping: {} }
  const key = { permissions: ['gemini'] }
  const models = async (format) => (await getRouteModels(route, key, { kind: 'group', group }, new Map(), format)).map((item) => item.id)
  expect(await models('claude-messages')).toEqual(['gemini-oauth'])
  expect(await models('openai-chat')).toEqual(['gemini-oauth', 'gemini-api-only'])
})

test('an unrestricted Console mapping does not narrow public models, while an explicit range does', async () => {
  const original = accounts.get('account1')
  accounts.set('console-all', { ...original, id: 'console-all', testType: 'claude-console', allowedModels: [], supportedModels: { alias: 'claude-a' } })
  await saveRoute(routeInput({ binding: 'console:console-all', targetName: '公开模型账号' }))
  const models = async () => (await getRouteModels(routes.get('a'), keyData())).map((item) => item.id)
  expect(await models()).toEqual(expect.arrayContaining(['claude-a', 'claude-b', 'alias']))
  accounts.get('console-all').allowedModels = ['alias']
  expect(await models()).toEqual(['alias'])
})
