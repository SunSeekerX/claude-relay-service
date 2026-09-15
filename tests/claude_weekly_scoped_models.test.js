import { jest } from '@jest/globals'

const mockStore = new Map()

jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: {
    getClaudeAccount: jest.fn(async (id) => mockStore.get(id) || {}),
    setClaudeAccount: jest.fn(async (id, data) => {
      mockStore.set(id, { ...data })
    }),
    client: { hdel: jest.fn(async () => 1) },
    getClientSafe: jest.fn(() => ({ hdel: jest.fn(async () => 1) })),
  },
}))

jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
}))

jest.unstable_mockModule('../src/modules/account/account_token_refresh_service.js', () => ({
  tokenRefreshService: {
    acquireRefreshLock: jest.fn(async () => true),
    releaseRefreshLock: jest.fn(async () => true),
  },
}))

jest.unstable_mockModule('../src/common/token_refresh_logger.js', () => ({
  logRefreshSkipped: jest.fn(),
  logRefreshStart: jest.fn(),
  logRefreshSuccess: jest.fn(),
  logRefreshError: jest.fn(),
  logTokenUsage: jest.fn(),
}))

jest.unstable_mockModule('../src/modules/webhook/webhook_notifier.js', () => ({
  webhookNotifier: {
    sendAccountAnomalyNotification: jest.fn(async () => undefined),
  },
}))

jest.unstable_mockModule('../src/modules/relay/relay_upstream_error_helper.js', () => ({
  recordErrorHistory: jest.fn(() => ({ catch: jest.fn() })),
  markTempUnavailable: jest.fn(() => ({ catch: jest.fn() })),
  parseRetryAfter: jest.fn(() => null),
}))

jest.unstable_mockModule('../src/modules/proxy/proxy_helper.js', () => ({
  ProxyHelper: class ProxyHelper {},
}))

jest.unstable_mockModule('../src/modules/account/account_group_service.js', () => ({
  accountGroupService: {
    getAccountGroup: jest.fn(),
    getGroupMembers: jest.fn(async () => []),
  },
}))

jest.unstable_mockModule('axios', () => ({ default: {} }))

const _realSetInterval = global.setInterval
global.setInterval = (fn, ms, ...args) => {
  const timer = _realSetInterval(fn, ms, ...args)
  if (timer && typeof timer.unref === 'function') {
    timer.unref()
  }
  return timer
}

const { claudeAccountService } = await import('../src/modules/account/account_claude_service.js')
const { redis } = await import('../src/infra/redis.js')
global.setInterval = _realSetInterval

const LIMITS = [
  {
    kind: 'session',
    percent: 0,
    severity: 'normal',
    resets_at: '2026-09-05T10:40:00.509692+00:00',
    scope: null,
    is_active: false,
  },
  {
    kind: 'weekly_scoped',
    percent: 9,
    severity: 'normal',
    resets_at: '2026-09-09T07:00:00.509898+00:00',
    scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    is_active: true,
  },
]

describe('_extractWeeklyScopedModels', () => {
  it('pulls the per-model weekly cap out of limits[]', () => {
    const scoped = claudeAccountService._extractWeeklyScopedModels(LIMITS)
    expect(scoped).toEqual([
      {
        modelName: 'Fable',
        utilization: 9,
        resetsAt: '2026-09-09T07:00:00.509898+00:00',
        severity: 'normal',
        isActive: true,
      },
    ])
  })

  it('tolerates a missing or malformed limits array', () => {
    expect(claudeAccountService._extractWeeklyScopedModels(undefined)).toEqual([])
    expect(claudeAccountService._extractWeeklyScopedModels(null)).toEqual([])
    expect(claudeAccountService._extractWeeklyScopedModels({})).toEqual([])
  })
})

describe('buildClaudeUsageSnapshot', () => {
  it('exposes scoped models with a computed remainingSeconds', () => {
    const resetsAt = new Date(Date.now() + 3600 * 1000).toISOString()
    const snapshot = claudeAccountService.buildClaudeUsageSnapshot({
      claudeUsageUpdatedAt: '2026-09-05T05:00:00.000Z',
      claudeWeeklyScopedModels: JSON.stringify([
        { modelName: 'Fable', utilization: 9, resetsAt, severity: 'normal', isActive: true },
      ]),
    })

    expect(snapshot.sevenDayScopedModels).toHaveLength(1)
    expect(snapshot.sevenDayScopedModels[0]).toMatchObject({
      modelName: 'Fable',
      utilization: 9,
      isActive: true,
    })
    expect(snapshot.sevenDayScopedModels[0].remainingSeconds).toBeGreaterThan(3500)
  })

  it('does not throw when the stored array holds null or primitive entries', () => {
    const snapshot = claudeAccountService.buildClaudeUsageSnapshot({
      claudeUsageUpdatedAt: '2026-09-05T05:00:00.000Z',
      claudeWeeklyScopedModels: JSON.stringify([null, 'Fable', 42, { modelName: 'Fable' }]),
    })

    expect(snapshot.sevenDayScopedModels).toHaveLength(1)
    expect(snapshot.sevenDayScopedModels[0].modelName).toBe('Fable')
  })
})

describe('updateClaudeUsageSnapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStore.clear()
    redis.getClaudeAccount.mockResolvedValue({ id: 'acc-1', name: 'test' })
  })

  const savedAccount = () => redis.setClaudeAccount.mock.calls[0][1]

  it('persists the scoped models parsed out of limits[]', async () => {
    await claudeAccountService.updateClaudeUsageSnapshot('acc-1', {
      five_hour: { utilization: 12, resets_at: '2026-09-05T10:00:00Z' },
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 49,
          resets_at: '2026-09-09T07:00:00Z',
          scope: { model: { display_name: 'Fable' } },
          is_active: true,
        },
      ],
    })

    const scoped = JSON.parse(savedAccount().claudeWeeklyScopedModels)
    expect(scoped).toHaveLength(1)
    expect(scoped[0]).toMatchObject({ modelName: 'Fable', utilization: 49 })
  })

  it('clears a previously stored snapshot once the upstream stops returning it', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      id: 'acc-1',
      claudeWeeklyScopedModels: JSON.stringify([{ modelName: 'Fable', utilization: 49 }]),
    })

    await claudeAccountService.updateClaudeUsageSnapshot('acc-1', {
      five_hour: { utilization: 12, resets_at: '2026-09-05T10:00:00Z' },
      limits: [{ kind: 'weekly_all', percent: 3 }],
    })

    expect(JSON.parse(savedAccount().claudeWeeklyScopedModels)).toEqual([])
  })

  it('keeps previous scoped snapshot when response omits limits entirely', async () => {
    const previousScoped = JSON.stringify([{ modelName: 'Fable', utilization: 49 }])
    redis.getClaudeAccount.mockResolvedValue({
      id: 'acc-1',
      claudeWeeklyScopedModels: previousScoped,
    })

    await claudeAccountService.updateClaudeUsageSnapshot('acc-1', {
      five_hour: { utilization: 12, resets_at: '2026-09-05T10:00:00Z' },
    })

    // Object.assign 合并后写回完整 accountData，旧快照必须仍在
    expect(savedAccount().claudeWeeklyScopedModels).toBe(previousScoped)
    expect(savedAccount().claudeFiveHourUtilization).toBe('12')
  })

  it('persists scoped models even when no top-level window was returned', async () => {
    await claudeAccountService.updateClaudeUsageSnapshot('acc-1', {
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 9,
          resets_at: '2026-09-09T07:00:00Z',
          scope: { model: { display_name: 'Fable' } },
          is_active: true,
        },
      ],
    })

    expect(redis.setClaudeAccount).toHaveBeenCalledTimes(1)
    expect(JSON.parse(savedAccount().claudeWeeklyScopedModels)).toEqual([
      expect.objectContaining({ modelName: 'Fable', utilization: 9 }),
    ])
  })
})
