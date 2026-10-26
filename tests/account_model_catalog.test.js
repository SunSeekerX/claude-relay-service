import { beforeEach, describe, expect, jest, test } from '@jest/globals'

const accounts = new Map()
const request = jest.fn()
const refresh = jest.fn(async (type, id) => {
  accounts.get(`${type}:${id}`).expiresAt = '2099-01-01T00:00:00Z'
})
const expired = (account) => Date.parse(account.expiresAt) <= Date.now()
const post = jest.fn()
const sdkModels = jest.fn()
const sdkConnect = jest.fn()
const sdkClose = jest.fn()
const factoryKeys = jest.fn(async () => [{ id: 'key-fixture', key: 'factory-fixture-key', status: 'active' }])
const bedrockSend = jest.fn()
const bedrockDestroy = jest.fn()
const antigravityModels = jest.fn()
const observation = jest.fn(async () => ({ temporary: false, overloaded: false, concurrency: 0 }))
const record = jest.fn(async (type, id, incoming) => {
  const account = accounts.get(`${type}:${id}`)
  if (!account) {
    return null
  }
  const current = JSON.parse(account.modelCatalog ?? '{}')
  if (current.attemptedAt > incoming.attemptedAt) {
    return current
  }
  const next = { ...current, attemptedAt: incoming.attemptedAt, error: incoming.error }
  if (incoming.models) {
    Object.assign(next, {
      models: incoming.models,
      signature: incoming.signature,
      succeededAt: incoming.attemptedAt,
      complete: incoming.complete,
    })
  }
  account.modelCatalog = JSON.stringify(next)
  return next
})
const readState = jest.fn(async (type, id) => accounts.get(`${type}:${id}`) ?? null)
await jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: {
    getAccountModelState: readState,
    recordAccountModelCatalog: record,
    getAccountModelObservation: observation,
    getDateStringInTimezone: () => '2026-10-25',
    getAccountDailyCost: async () => 10,
  },
}))
await jest.unstable_mockModule('axios', () => ({ default: { get: request, post } }))
await jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))
const resolveAgent = jest.fn(() => ({ agent: null, proxyId: null, contextKey: 'fixture' }))
await jest.unstable_mockModule('../src/modules/proxy/proxy_resolver.js', () => ({
  proxyResolver: {
    resolveAgent,
    report: jest.fn(),
    resolveProxyConfigForAccount: () => undefined,
  },
}))
const getDecrypted = (type) => async (id) => ({
  ...accounts.get(`${type}:${id}`),
  apiKey: 'plain-fixture-key',
  accessToken: 'plain-oauth-token',
  proxy: null,
})
for (const [file, name, type] of [
  ['account_openai_responses_service.js', 'openaiResponsesAccountService', 'openai-responses'],
  ['account_claude_console_service.js', 'claudeConsoleAccountService', 'claude-console'],
  ['account_ccr_service.js', 'ccrAccountService', 'ccr'],
  ['account_gemini_api_service.js', 'geminiApiAccountService', 'gemini-api'],
  ['account_grok_service.js', 'grokAccountService', 'grok'],
]) {
  await jest.unstable_mockModule(`../src/modules/account/${file}`, () => ({
    [name]: { getAccount: getDecrypted(type), getDecryptedAccessToken: async () => 'grok-oauth-token' },
  }))
}
await jest.unstable_mockModule('../src/modules/account/account_claude_service.js', () => ({
  claudeAccountService: {
    getAccount: getDecrypted('claude-official'),
    _decryptSensitiveData: () => 'claude-oauth-token',
    refreshAccountToken: (id) => refresh('claude-official', id),
  },
}))
await jest.unstable_mockModule('../src/modules/account/account_openai_service.js', () => ({
  getAccount: getDecrypted('openai'),
  decrypt: () => 'codex-oauth-token',
  isTokenExpired: expired,
  refreshAccountToken: (id) => refresh('openai', id),
}))
await jest.unstable_mockModule('../src/modules/account/account_gemini_service.js', () => ({
  getAccount: getDecrypted('gemini'),
  isTokenExpired: expired,
  refreshAccountToken: (id) => refresh('gemini', id),
}))
await jest.unstable_mockModule('../src/modules/relay/relay_antigravity_client.js', () => ({
  fetchAvailableModels: antigravityModels,
}))
await jest.unstable_mockModule('../src/modules/relay/relay_gemini_handlers_routes.js', () => ({
  buildGeminiApiUrl: (base) => `${base}/v1beta/models?key=plain-fixture-key`,
}))
await jest.unstable_mockModule('../src/modules/account/account_droid_service.js', () => ({
  droidAccountService: {
    getModelDiscoveryApiKey: async () => accounts.get('droid:a')?.dedicatedFixtureKey ?? '',
    getAccount: getDecrypted('droid'),
    getDecryptedApiKeyEntries: factoryKeys,
  },
}))
await jest.unstable_mockModule('@factory/droid-sdk/node', () => ({
  ProcessTransport: class {
    constructor(options) {
      this.options = options
    }
    connect() {
      return sdkConnect(this.options)
    }
    close() {
      return sdkClose()
    }
  },
  listModels: sdkModels,
}))
await jest.unstable_mockModule('../src/modules/account/account_bedrock_service.js', () => ({
  bedrockAccountService: {
    getAccount: async (id) => ({
      data: { ...accounts.get(`bedrock:${id}`), awsCredentials: { accessKeyId: 'fake', secretAccessKey: 'fake' } },
    }),
  },
}))
await jest.unstable_mockModule('@aws-sdk/client-bedrock', () => ({
  BedrockClient: class {
    middlewareStack = { add: jest.fn() }
    send(command) {
      return bedrockSend(command)
    }
    destroy() {
      bedrockDestroy()
    }
  },
  ListFoundationModelsCommand: class {
    constructor(input) {
      this.kind = 'foundation'
      this.input = input
    }
  },
  ListInferenceProfilesCommand: class {
    constructor(input) {
      this.kind = 'profiles'
      this.input = input
    }
  },
}))

const { syncAccountModelCatalog, getAccountModelCatalog, accountModelReadiness, modelCatalogSignature } =
  await import('../src/modules/account/account_model_catalog_service.js')
const { normalizeAccountModelRange, isAccountModelInRange } =
  await import('../src/modules/account/account_model_policy.js')

const addAccount = (type, extra = {}) => {
  const account = {
    id: 'a',
    isActive: 'true',
    schedulable: 'true',
    accountType: 'shared',
    baseApi: 'https://upstream.invalid/gateway/v1',
    baseUrl: 'https://upstream.invalid',
    apiUrl: 'https://upstream.invalid/v1',
    apiKey: 'encrypted-key',
    accessToken: 'encrypted-oauth',
    expiresAt: '2099-01-01T00:00:00Z',
    ...extra,
  }
  accounts.set(`${type}:a`, account)
  return account
}
beforeEach(() => {
  accounts.clear()
  jest.clearAllMocks()
  request.mockReset().mockResolvedValue({ data: { data: [{ id: 'gpt-fixture' }] } })
  post.mockReset()
  sdkModels.mockReset().mockResolvedValue([{ id: 'factory-model' }])
  sdkConnect.mockReset().mockResolvedValue()
  sdkClose.mockReset().mockResolvedValue()
  factoryKeys.mockReset().mockResolvedValue([{ id: 'key-fixture', key: 'factory-fixture-key', status: 'active' }])
  bedrockSend.mockReset()
  observation.mockReset().mockResolvedValue({ temporary: false, overloaded: false, concurrency: 0 })
  antigravityModels.mockReset()
})

describe('manual account model synchronization', () => {
  test('sync only records discovery and leaves whitelist and mapping byte-for-byte unchanged', async () => {
    const account = addAccount('openai-responses', {
      allowedModels: '["gpt-old"]',
      supportedModels: '{"fast":"gpt-old"}',
    })
    request.mockResolvedValue({ data: { data: [{ id: 'gpt-new' }, { id: 'gpt-new' }, { id: 'custom-model' }] } })
    const result = await syncAccountModelCatalog('openai-responses', 'a')
    expect(result.models).toEqual(['gpt-new', 'custom-model'])
    expect(result.succeededAt).toBeTruthy()
    expect(result.error).toBe('')
    expect(account.allowedModels).toBe('["gpt-old"]')
    expect(account.supportedModels).toBe('{"fast":"gpt-old"}')
    expect(request.mock.calls[0][0]).toBe('https://upstream.invalid/gateway/v1/models')
    expect(request.mock.calls[0][1]).toMatchObject({
      proxy: false,
      timeout: 15000,
      maxRedirects: 0,
      headers: { Authorization: 'Bearer plain-fixture-key' },
    })
  })
  test('failed refresh preserves successful models and records sanitized failure, with no fallback success', async () => {
    addAccount('openai-responses')
    const first = await syncAccountModelCatalog('openai-responses', 'a')
    request.mockRejectedValue({ response: { status: 403 }, message: 'secret echoed upstream' })
    await expect(syncAccountModelCatalog('openai-responses', 'a')).rejects.toMatchObject({ statusCode: 502 })
    const result = await getAccountModelCatalog('openai-responses', 'a')
    expect(result.models).toEqual(first.models)
    expect(result.succeededAt).toBe(first.succeededAt)
    expect(result.error).toBe('上游返回 HTTP 403')
    expect(JSON.stringify(result)).not.toMatch(/secret echoed|encrypted-key|plain-fixture-key/)
  })
  test('successful empty directory is retained as empty, not restored to global defaults', async () => {
    addAccount('openai-responses')
    request.mockResolvedValue({ data: { data: [] } })
    expect((await syncAccountModelCatalog('openai-responses', 'a')).models).toEqual([])
  })
  test('source configuration changed during sync never publishes results under new credentials', async () => {
    const account = addAccount('openai-responses')
    request.mockImplementation(async () => {
      account.apiKey = 'rotated-key'
      return { data: { data: [{ id: 'old-account-model' }] } }
    })
    await expect(syncAccountModelCatalog('openai-responses', 'a')).rejects.toMatchObject({ statusCode: 409 })
    expect((await getAccountModelCatalog('openai-responses', 'a')).models).toEqual([])
  })
  test('account lookup rejects unknown type and registry pseudo-id before Redis access', async () => {
    await expect(getAccountModelCatalog('__proto__', 'a')).rejects.toMatchObject({ statusCode: 400 })
    await expect(getAccountModelCatalog('openai', 'index')).rejects.toMatchObject({ statusCode: 400 })
    expect(readState).not.toHaveBeenCalled()
  })
  test('Droid usage counters do not invalidate a model catalog signature', () => {
    const base = addAccount('droid', { apiKeys: JSON.stringify([{ id: 'k', hash: 'same-credential', usageCount: 0 }]) })
    const updated = {
      ...base,
      apiKeys: JSON.stringify([
        { id: 'k', hash: 'same-credential', usageCount: 99, lastUsedAt: '2026-10-25T23:00:00Z' },
      ]),
    }
    expect(modelCatalogSignature(updated)).toBe(modelCatalogSignature(base))
    expect(
      modelCatalogSignature({ ...updated, apiKeys: JSON.stringify([{ id: 'k', hash: 'new-credential' }]) }),
    ).not.toBe(modelCatalogSignature(base))
  })
  test.each(['claude-console', 'ccr', 'claude-official'])(
    '%s uses Anthropic model-list authentication and pagination',
    async (type) => {
      addAccount(type)
      request
        .mockResolvedValueOnce({ data: { data: [{ id: 'claude-one' }], has_more: true, last_id: 'claude-one' } })
        .mockResolvedValueOnce({ data: { data: [{ id: 'claude-two' }], has_more: false } })
      const result = await syncAccountModelCatalog(type, 'a')
      expect(result.models).toEqual(['claude-one', 'claude-two'])
      expect(request.mock.calls[1][0]).toContain('after_id=claude-one')
      expect(request.mock.calls[0][1].headers['anthropic-version']).toBe('2023-06-01')
    },
  )
  test('OpenAI OAuth uses Codex native models and keeps hidden models out of discovery', async () => {
    addAccount('openai', { accountId: 'chatgpt-account' })
    request.mockResolvedValue({
      data: {
        models: [
          { slug: 'gpt-visible', visibility: 'list' },
          { slug: 'gpt-hidden', visibility: 'hide' },
        ],
      },
    })
    expect((await syncAccountModelCatalog('openai', 'a')).models).toEqual(['gpt-visible'])
    expect(request.mock.calls[0][0]).toMatch(/^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=/)
    expect(request.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer codex-oauth-token',
      'ChatGPT-Account-Id': 'chatgpt-account',
    })
  })
  test.each(['gemini-api'])(
    '%s paginates native lists, normalizes IDs, and excludes embedding-only models',
    async (type) => {
      addAccount(type)
      request
        .mockResolvedValueOnce({
          data: {
            models: [
              { name: 'models/gemini-one', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/embed-only', supportedGenerationMethods: ['embedContent'] },
            ],
            nextPageToken: 'next-page',
          },
        })
        .mockResolvedValueOnce({
          data: { models: [{ name: 'models/gemini-two', supportedGenerationMethods: ['generateContent'] }] },
        })
      expect((await syncAccountModelCatalog(type, 'a')).models).toEqual(['gemini-one', 'gemini-two'])
      expect(request.mock.calls[1][0]).toContain('pageToken=next-page')
    },
  )
  test('Gemini CLI uses native quota model discovery and explicitly marks the result as partial', async () => {
    addAccount('gemini', { projectId: 'quota-project' })
    post.mockResolvedValue({
      data: {
        buckets: [
          { modelId: 'gemini-one', remainingFraction: 0 },
          { modelId: 'gemini-two', remainingFraction: 1 },
        ],
      },
    })
    const result = await syncAccountModelCatalog('gemini', 'a')
    expect(result.models).toEqual(['gemini-one', 'gemini-two'])
    expect(result.complete).toBe(false)
    expect(post.mock.calls[0][0]).toBe('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota')
    expect(post.mock.calls[0][1]).toEqual({ project: 'quota-project' })
    expect(request).not.toHaveBeenCalled()
  })
  test('Gemini CLI project resolution does not onboard users or overwrite stored project configuration', async () => {
    const account = addAccount('gemini')
    post
      .mockResolvedValueOnce({ data: { cloudaicompanionProject: 'managed-project' } })
      .mockResolvedValueOnce({ data: { buckets: [] } })
    expect((await syncAccountModelCatalog('gemini', 'a')).complete).toBe(false)
    expect(post.mock.calls[0][0]).toContain(':loadCodeAssist')
    expect(post.mock.calls[0][1].mode).toBe('HEALTH_CHECK')
    expect(post.mock.calls[1][1]).toEqual({ project: 'managed-project' })
    expect(account.projectId).toBeUndefined()
    expect(post.mock.calls.some(([url]) => url.includes('onboardUser'))).toBe(false)
  })
  test('Antigravity failures are failures rather than fabricated default model success', async () => {
    addAccount('gemini', { oauthProvider: 'antigravity' })
    antigravityModels.mockRejectedValue(new Error('upstream unavailable'))
    await expect(syncAccountModelCatalog('gemini', 'a')).rejects.toMatchObject({ statusCode: 502 })
    expect((await getAccountModelCatalog('gemini', 'a')).succeededAt).toBeNull()
  })
  test('Droid SDK uses an isolated process environment and always closes transport', async () => {
    addAccount('droid')
    expect((await syncAccountModelCatalog('droid', 'a')).models).toEqual(['factory-model'])
    expect(sdkConnect.mock.calls[0][0].env).toMatchObject({ FACTORY_API_KEY: 'factory-fixture-key' })
    expect(sdkConnect.mock.calls[0][0].cwd).toBe(sdkConnect.mock.calls[0][0].env.FACTORY_HOME_OVERRIDE)
    expect(sdkClose).toHaveBeenCalled()
    sdkModels.mockRejectedValue(new Error('sdk failed'))
    await expect(syncAccountModelCatalog('droid', 'a')).rejects.toMatchObject({ statusCode: 502 })
    expect(sdkClose).toHaveBeenCalledTimes(2)
  })
  test('Droid dedicated discovery credential is used without altering OAuth mode or returning credentials', async () => {
    const account = addAccount('droid', {
      authenticationMethod: 'oauth',
      modelDiscoveryApiKey: 'aes:encrypted-fixture',
      dedicatedFixtureKey: 'fk-dedicated-fixture',
    })
    const result = await syncAccountModelCatalog('droid', 'a')
    expect(sdkConnect.mock.calls[0][0].env.FACTORY_API_KEY).toBe('fk-dedicated-fixture')
    expect(account.authenticationMethod).toBe('oauth')
    expect(result.hasDiscoveryKey).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/fk-dedicated-fixture|aes:encrypted-fixture/)
  })
  test('Droid OAuth without either model credential reports an actionable error instead of disabling sync', async () => {
    addAccount('droid', { authenticationMethod: 'oauth' })
    factoryKeys.mockResolvedValue([])
    await expect(syncAccountModelCatalog('droid', 'a')).rejects.toMatchObject({ statusCode: 400 })
    const result = await getAccountModelCatalog('droid', 'a')
    expect(result.canSync).toBe(true)
    expect(result.error).toContain('模型同步专用 Factory Key')
    expect(result.succeededAt).toBeNull()
    expect(sdkModels).not.toHaveBeenCalled()
  })
  test('Bedrock merges native foundation and inference profile models and destroys its client', async () => {
    addAccount('bedrock', { region: 'us-east-1' })
    bedrockSend.mockImplementation(async (command) =>
      command.kind === 'foundation'
        ? { modelSummaries: [{ modelId: 'anthropic.claude-one' }] }
        : {
            inferenceProfileSummaries: [
              {
                inferenceProfileId: 'us.anthropic.claude-one',
                models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-one' }],
              },
            ],
          },
    )
    expect((await syncAccountModelCatalog('bedrock', 'a')).models).toEqual([
      'anthropic.claude-one',
      'us.anthropic.claude-one',
    ])
    expect(bedrockDestroy).toHaveBeenCalled()
  })
  test('Grok API key and OAuth use the account endpoint and correct credential form', async () => {
    addAccount('grok', { authType: 'apikey', baseUrl: 'https://xai.invalid/v1' })
    await syncAccountModelCatalog('grok', 'a')
    expect(request.mock.calls[0][0]).toBe('https://xai.invalid/v1/models')
    accounts.get('grok:a').authType = 'oauth'
    await syncAccountModelCatalog('grok', 'a')
    expect(request.mock.calls[1][1].headers.Authorization).toBe('Bearer grok-oauth-token')
  })
})

describe('read-only account scheduling observations', () => {
  test('manual disable and budgets remain hard gates with auto protection disabled', async () => {
    expect(
      (
        await accountModelReadiness(
          'openai-responses',
          addAccount('openai-responses', { schedulable: false, disableAutoProtection: true }),
        )
      ).state,
    ).toBe('blocked')
    expect(
      (
        await accountModelReadiness(
          'openai-responses',
          addAccount('openai-responses', {
            dailyQuota: 2,
            dailyUsage: 2,
            lastResetDate: '2026-10-25',
            disableAutoProtection: true,
          }),
        )
      ).reason,
    ).toBe('账号额度不足')
    expect(request).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })
  test('rate limits and concurrency are visible but no token refresh or clearing is performed', async () => {
    const account = addAccount('openai', { rateLimitStatus: 'limited', rateLimitResetAt: '2099-01-01T00:00:00Z' })
    expect((await accountModelReadiness('openai', account)).state).toBe('blocked')
    account.disableAutoProtection = true
    expect((await accountModelReadiness('openai', account)).state).toBe('ready')
    observation.mockResolvedValue({ temporary: false, concurrency: 1 })
    expect((await accountModelReadiness('openai-responses', { ...account, maxConcurrentTasks: 1 })).reason).toBe(
      '账号并发已满',
    )
    expect(request).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })
  test('expired OAuth is unknown until a real request, and Grok live daily budget is observed read-only', async () => {
    expect(
      (await accountModelReadiness('gemini', addAccount('gemini', { expiresAt: '2000-01-01T00:00:00Z' }))).state,
    ).toBe('unknown')
    expect((await accountModelReadiness('grok', addAccount('grok', { dailyQuota: 5, authType: 'apikey' }))).state).toBe(
      'blocked',
    )
    expect(request).not.toHaveBeenCalled()
  })
})

describe('supported model range policy', () => {
  test('ordinary account edits cannot overwrite discovered state and explicit empty model ranges remain editable', async () => {
    const { stripReadonlyAccountFields } = await import('../src/common/common_helper.js')
    expect(
      stripReadonlyAccountFields({ modelCatalog: 'stale-client-copy', supportedModels: [], allowedModels: [] }),
    ).toEqual({ supportedModels: [], allowedModels: [] })
  })
  test('explicit empty range remains unrestricted; malformed ranges are rejected before storage', () => {
    expect(normalizeAccountModelRange([])).toEqual([])
    expect(normalizeAccountModelRange('["m-one","m-one"]')).toEqual(['m-one'])
    expect(() => normalizeAccountModelRange(false)).toThrow()
    expect(() => normalizeAccountModelRange([' '])).toThrow()
    expect(() => normalizeAccountModelRange(Array(2001).fill('m'))).toThrow()
    expect(isAccountModelInRange('["claude-*", "custom"]', 'claude-one')).toBe(true)
    expect(isAccountModelInRange('["custom"]', 'other')).toBe(false)
    expect(isAccountModelInRange('[]', 'other')).toBe(true)
  })
})

const { markAccountModelIdentityUpdate } = await import('../src/modules/account/account_model_identity.js')
const { parseStoredAccountModels } = await import('../src/common/compat_account_models.js')
test.each(['claude-console', 'ccr'])('%s model sync accepts a saved full Messages endpoint', async (type) => {
  addAccount(type, { apiUrl: 'https://upstream.invalid/proxy/v1/messages/' })
  await syncAccountModelCatalog(type, 'a')
  expect(request.mock.calls[0][0]).toBe('https://upstream.invalid/proxy/v1/models')
})
test.each(['claude-official', 'openai', 'gemini'])('%s sync refreshes expired authorization before discovery', async (type) => {
  addAccount(type, { expiresAt: '2020-01-01T00:00:00Z', refreshToken: 'refresh', projectId: 'project' })
  request.mockResolvedValue({ data: { data: [{ id: 'claude-model' }], models: [{ slug: 'gpt-visible', visibility: 'list' }] } })
  post.mockResolvedValue({ data: { buckets: [] } })
  await syncAccountModelCatalog(type, 'a')
  expect(refresh).toHaveBeenCalledWith(type, 'a')
  expect(refresh.mock.invocationCallOrder[0]).toBeLessThan((type === 'gemini' ? post : request).mock.invocationCallOrder[0])
})
test.each(['claude-official', 'gemini'])('%s replacing OAuth authorization invalidates old discovery', async (type) => {
  const account = addAccount(type)
  const signature = modelCatalogSignature(account)
  account.modelCatalog = JSON.stringify({ signature, models: ['old-model'], succeededAt: new Date().toISOString() })
  expect((await getAccountModelCatalog(type, 'a')).models).toEqual(['old-model'])
  const refreshOnly = { ...account, accessToken: 'rotated-token' }
  expect(modelCatalogSignature(refreshOnly)).toBe(signature)
  Object.assign(account, markAccountModelIdentityUpdate({ accessToken: 'new-identity' }))
  expect((await getAccountModelCatalog(type, 'a'))).toMatchObject({ models: [], stale: true })
})
test('legacy Gemini comma-separated model ranges preserve every allowed model', () => {
  expect(parseStoredAccountModels('gemini-a,gemini-b')).toEqual(['gemini-a', 'gemini-b'])
  expect(parseStoredAccountModels('')).toEqual([])
  expect(parseStoredAccountModels('["gemini-a"]')).toEqual(['gemini-a'])
  expect(() => parseStoredAccountModels('[invalid')).toThrow()
})
