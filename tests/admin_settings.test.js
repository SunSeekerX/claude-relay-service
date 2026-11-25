import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const settings = new Map()
const sessions = new Map()
const client = {
  get: jest.fn(async (key) => settings.get(key) ?? null),
  set: jest.fn(async (key, value) => {
    settings.set(key, value)
    return 'OK'
  }),
}
const redis = {
  getClientSafe: () => client,
  getSession: jest.fn(async (id) => ({ ...sessions.get(id) })),
  setSession: jest.fn(async (id, value) => {
    sessions.set(id, Object.fromEntries(Object.entries(value).map(([key, field]) => [key, String(field)])))
  }),
  deleteSession: jest.fn(async (id) => sessions.delete(id)),
}
const logger = new Proxy({}, { get: () => jest.fn() })
jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis }))
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger }))
jest.unstable_mockModule('../src/modules/admin/admin_login_policy.js', () => ({
  assertAdminLoginAllowed: jest.fn(),
  clearAdminLoginAttempts: jest.fn(),
}))
jest.unstable_mockModule('bcryptjs', () => ({ default: { compare: async () => true } }))
jest.unstable_mockModule('../src/modules/apikey/apikey_service.js', () => ({ apiKeyService: {} }))
jest.unstable_mockModule('../src/modules/user/user_service.js', () => ({ userService: {} }))
jest.unstable_mockModule('../src/modules/account/account_group_service.js', () => ({ accountGroupService: {} }))
jest.unstable_mockModule('../src/modules/account/account_group_policy.js', () => ({
  collectExclusiveMemberIds: async () => new Set(),
  getGroupSchedulingSnapshot: async () => null,
  releaseGroupCostHolds: jest.fn(),
}))
jest.unstable_mockModule('../src/modules/payment/payment_balance_ledger.js', () => ({ balanceLedger: {} }))

const { config } = await import('../config/config.js')
const { RedisKeys, TTL } = await import('../src/infra/redis_key.js')
const { adminLoginSettingsService } = await import('../src/modules/admin/admin_login_settings_service.js')
const { apiKeyQuickAdjustSettingsService } =
  await import('../src/modules/apikey/apikey_quick_adjust_settings_service.js')
const { router: settingsRouter } = await import('../src/modules/admin/admin_settings_routes.js')
const { router: webRouter } = await import('../src/modules/admin/admin_web_routes.js')
const { authenticateAdmin, authenticateUserOrAdmin } = await import('../src/infra/middleware_auth.js')
const { attach: attachApiKeyStore } = await import('../src/infra/redis_api_key_store.js')
const { attach: attachSystemStatsStore } = await import('../src/infra/redis_system_stats_store.js')
const app = express().use(express.json()).use('/admin', settingsRouter).use('/web', webRouter)
app.get('/admin/protected', authenticateAdmin, (req, res) => res.json({ username: req.admin.username }))
app.get('/users/protected', authenticateUserOrAdmin, (req, res) => res.json({ username: req.admin.username }))
const token = 'fixture-admin-token-with-at-least-32-characters'
const auth = (req, value = token) => req.set('Authorization', `Bearer ${value}`)
const session = (overrides = {}) => ({
  username: 'fixture-admin',
  loginTime: new Date().toISOString(),
  lastActivity: new Date().toISOString(),
  ...overrides,
})
const login = async () => {
  const response = await request(app)
    .post('/web/auth/login')
    .send({ username: 'fixture-admin', password: 'fixture-password' })
    .expect(200)
  return response.body.data
}

beforeEach(() => {
  jest.clearAllMocks()
  settings.clear()
  sessions.clear()
  sessions.set('admin_credentials', { username: 'fixture-admin', passwordHash: 'fixture-hash' })
  sessions.set(token, session())
})

describe('admin settings persistence and authorization', () => {
  it('keeps configuration keys out of API Key index rebuilds and system counts', async () => {
    const scanClient = {
      scan: jest
        .fn()
        .mockResolvedValueOnce(['0', [RedisKeys.apiKey.byId('fixture'), RedisKeys.apiKey.quickAdjustSettings]])
        .mockResolvedValueOnce([
          '0',
          [RedisKeys.apiKey.byId('fixture'), RedisKeys.apiKey.quickAdjustSettings, RedisKeys.adminLogin.settings],
        ]),
    }
    const store = { client: scanClient, getClientSafe: () => scanClient }
    attachApiKeyStore(store)
    attachSystemStatsStore(store)
    expect(await store.scanApiKeyIdsFromHashes()).toEqual(['fixture'])
    expect((await store.getSystemStats()).totalApiKeys).toBe(1)
  })

  it('returns defaults without writing settings or changing the default login duration', async () => {
    expect(await adminLoginSettingsService.getSettings()).toEqual({ sessionTimeoutHours: null })
    expect(await apiKeyQuickAdjustSettingsService.getSettings()).toEqual({
      costPresets: [10, 50, 100, 200, 300, 500, 1000],
      extendPresets: [7, 30, 90, 180, 365],
    })
    expect(client.set).not.toHaveBeenCalled()
    const result = await login()
    expect(result.expiresIn).toBe(config.security.adminSessionTimeout)
    expect(sessions.get(result.token).sessionTimeoutSeconds).toBeUndefined()
    expect(redis.setSession).toHaveBeenLastCalledWith(
      result.token,
      expect.any(Object),
      config.security.adminSessionTimeout,
    )
    await auth(request(app).get('/admin/protected'), result.token).expect(200)
    expect(redis.setSession).toHaveBeenLastCalledWith(result.token, expect.any(Object), TTL.adminSession)
    await auth(request(app).post('/web/auth/refresh'), result.token).expect(200)
    expect(redis.setSession).toHaveBeenLastCalledWith(
      result.token,
      expect.any(Object),
      config.security.adminSessionTimeout,
    )
  })

  it('requires authentication for both reads and writes', async () => {
    for (const path of ['/admin/login-settings', '/admin/api-key-quick-adjust-settings']) {
      await request(app).get(path).expect(401)
      await request(app).put(path).send({}).expect(401)
    }
    expect(client.set).not.toHaveBeenCalled()
  })

  it('saves custom order, decimal amounts and empty lists without restoring defaults', async () => {
    for (const value of [
      { costPresets: [1000, 12.34, 300], extendPresets: [365, 7] },
      { costPresets: [], extendPresets: [] },
    ]) {
      const saved = await auth(request(app).put('/admin/api-key-quick-adjust-settings')).send(value).expect(200)
      expect(saved.body.data).toEqual(value)
      const read = await auth(request(app).get('/admin/api-key-quick-adjust-settings')).expect(200)
      expect(read.body.data).toEqual(value)
    }
    expect(settings.has(RedisKeys.adminLogin.settings)).toBe(false)
  })

  it('rejects invalid numbers, duplicate values and oversized lists without writing', async () => {
    for (const hours of [0, -1, 1.5, 8761, '24', true]) {
      await auth(request(app).put('/admin/login-settings')).send({ sessionTimeoutHours: hours }).expect(400)
    }
    for (const costs of [[0], [-1], [1.001], [100, 100], ['100'], Array.from({ length: 21 }, (_, i) => i + 1)]) {
      await auth(request(app).put('/admin/api-key-quick-adjust-settings'))
        .send({ costPresets: costs, extendPresets: [1] })
        .expect(400)
    }
    for (const days of [[0], [1.5], [36501], [7, 7]]) {
      await auth(request(app).put('/admin/api-key-quick-adjust-settings'))
        .send({ costPresets: [100], extendPresets: days })
        .expect(400)
    }
    expect(client.set).not.toHaveBeenCalled()
  })

  it('surfaces persistence failures and corrupt settings instead of claiming saved defaults', async () => {
    client.set.mockRejectedValueOnce(new Error('fixture save failed'))
    await auth(request(app).put('/admin/login-settings')).send({ sessionTimeoutHours: 168 }).expect(500)
    expect(settings.has(RedisKeys.adminLogin.settings)).toBe(false)
    client.get.mockRejectedValueOnce(new Error('fixture read failed'))
    await auth(request(app).get('/admin/api-key-quick-adjust-settings')).expect(500)
    settings.set(RedisKeys.apiKey.quickAdjustSettings, 'not json')
    await expect(apiKeyQuickAdjustSettingsService.getSettings()).rejects.toThrow()
    settings.set(RedisKeys.adminLogin.settings, '{"sessionTimeoutHours":0}')
    await expect(adminLoginSettingsService.getSettings()).rejects.toThrow()
  })
})

describe('configured admin session lifetime', () => {
  it('rejects missing or incomplete sessions consistently across admin entrypoints', async () => {
    for (const value of [{}, { username: 'fixture' }, { loginTime: new Date().toISOString() }]) {
      for (const path of ['/admin/protected', '/users/protected', '/web/auth/user']) {
        sessions.set(token, value)
        await auth(request(app).get(path)).expect(401)
      }
    }
    expect(redis.setSession).not.toHaveBeenCalled()
  })

  it('uses seconds for storage and milliseconds in the existing login response', async () => {
    await auth(request(app).put('/admin/login-settings')).send({ sessionTimeoutHours: 168 }).expect(200)
    const result = await login()
    expect(result.expiresIn).toBe(7 * 86400000)
    expect(sessions.get(result.token).sessionTimeoutSeconds).toBe(String(7 * 86400))
    expect(redis.setSession).toHaveBeenLastCalledWith(result.token, expect.any(Object), 7 * 86400)
    sessions.get(result.token).lastActivity = new Date(Date.now() - 2 * 86400000).toISOString()
    await auth(request(app).get('/admin/protected'), result.token).expect(200)
    expect(redis.setSession).toHaveBeenLastCalledWith(result.token, expect.any(Object), 7 * 86400)
    const refresh = await auth(request(app).post('/web/auth/refresh'), result.token).expect(200)
    expect(refresh.body.data.expiresIn).toBe(7 * 86400000)
    expect(redis.setSession).toHaveBeenLastCalledWith(result.token, expect.any(Object), 7 * 86400)
    await auth(request(app).get('/users/protected'), result.token).expect(200)
    expect(redis.setSession).toHaveBeenLastCalledWith(result.token, expect.any(Object), 7 * 86400)
  })

  it.each([
    ['get', '/admin/protected'],
    ['get', '/users/protected'],
    ['get', '/web/auth/user'],
    ['post', '/web/auth/refresh'],
    ['post', '/web/auth/change-password'],
  ])('rejects expired custom sessions at %s %s before renewing or changing credentials', async (method, path) => {
    sessions.set(
      token,
      session({ sessionTimeoutSeconds: '3600', lastActivity: new Date(Date.now() - 3601000).toISOString() }),
    )
    await auth(request(app)[method](path))
      .send({ currentPassword: 'fixture-password', newPassword: 'fixture-new-password' })
      .expect(401)
    expect(redis.deleteSession).toHaveBeenCalledWith(token)
    expect(redis.setSession).not.toHaveBeenCalled()
  })

  it('preserves existing session policy when settings change or are reset to defaults', async () => {
    await adminLoginSettingsService.saveSettings({ sessionTimeoutHours: 168 }, 'fixture')
    const previous = await login()
    await adminLoginSettingsService.saveSettings({ sessionTimeoutHours: 1 }, 'fixture')
    const current = await login()
    expect(sessions.get(current.token).sessionTimeoutSeconds).toBe('3600')
    await auth(request(app).post('/web/auth/refresh'), previous.token).expect(200)
    expect(redis.setSession).toHaveBeenLastCalledWith(previous.token, expect.any(Object), 7 * 86400)
    await adminLoginSettingsService.saveSettings({ sessionTimeoutHours: null }, 'fixture')
    expect((await login()).expiresIn).toBe(config.security.adminSessionTimeout)
    await auth(request(app).get('/admin/protected'), current.token).expect(200)
    expect(redis.setSession).toHaveBeenLastCalledWith(current.token, expect.any(Object), 3600)
  })

  it('keeps the original 24-hour inactivity check for default sessions', async () => {
    sessions.set(token, session({ lastActivity: new Date(Date.now() - 25 * 3600000).toISOString() }))
    await auth(request(app).get('/admin/protected')).expect(401)
  })

  it.each(['0', 'NaN', '31536001', null])('rejects malformed stored custom lifetime %s', async (seconds) => {
    sessions.set(token, session({ sessionTimeoutSeconds: seconds }))
    await auth(request(app).post('/web/auth/refresh')).expect(401)
    expect(redis.setSession).not.toHaveBeenCalled()
  })
})
