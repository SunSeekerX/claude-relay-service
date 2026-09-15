import { jest } from '@jest/globals'

jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
}))

const {
  parseRateLimitWindows,
  resolveRateLimitReset,
  DEFAULT_MAX_FALLBACK_SECONDS,
} = await import('../src/modules/relay/relay_anthropic_rate_limit_header_helper.js')

const ts = (iso) => Math.floor(Date.parse(iso) / 1000)

const NOW = Date.parse('2026-09-05T04:25:00Z')
const FIVE_HOUR_RESET = ts('2026-09-05T06:10:00Z')
const SEVEN_DAY_RESET = ts('2026-09-09T04:00:00Z')

const headers = (overrides = {}) => ({
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-reset': String(FIVE_HOUR_RESET),
  'anthropic-ratelimit-unified-5h-utilization': '0.11',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-reset': String(SEVEN_DAY_RESET),
  'anthropic-ratelimit-unified-7d-utilization': '0.04',
  'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
  'anthropic-ratelimit-unified-7d_oi-reset': String(SEVEN_DAY_RESET),
  'anthropic-ratelimit-unified-7d_oi-utilization': '0.0',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
  'anthropic-ratelimit-unified-reset': String(SEVEN_DAY_RESET),
  ...overrides,
})

describe('resolveRateLimitReset', () => {
  it('anchors to the rejected 5h window, not the 7d unified-reset', () => {
    const result = resolveRateLimitReset(
      headers({ 'anthropic-ratelimit-unified-5h-status': 'rejected' }),
      'fable',
      { now: NOW },
    )

    expect(result.resetTimestamp).toBe(FIVE_HOUR_RESET)
    expect(result.resetTimestamp).not.toBe(SEVEN_DAY_RESET)
    expect(result.windowKey).toBe('5h')
    expect(result.scope).toBe('account')
    expect(result.authoritative).toBe(true)
  })

  it('prefers the model-scoped window when it is the one rejected', () => {
    const result = resolveRateLimitReset(
      headers({
        'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
      }),
      'opus',
      { now: NOW },
    )

    expect(result.resetTimestamp).toBe(SEVEN_DAY_RESET)
    expect(result.windowKey).toBe('7d_oi')
    expect(result.scope).toBe('model')
    expect(result.authoritative).toBe(true)
  })

  it('does not hand the opus-only window to a different family', () => {
    const result = resolveRateLimitReset(
      headers({
        'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
      }),
      'fable',
      { now: NOW },
    )

    expect(result.windowKey).toBe('5h')
    expect(result.scope).toBe('account')
  })

  it('takes the latest reset when several account windows are rejected', () => {
    const result = resolveRateLimitReset(
      headers({
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-7d-status': 'rejected',
      }),
      'sonnet',
      { now: NOW },
    )

    expect(result.resetTimestamp).toBe(SEVEN_DAY_RESET)
    expect(result.windowKey).toBe('7d')
  })

  it('clamps the unified-reset fallback when no window reports a rejection', () => {
    const result = resolveRateLimitReset(headers(), 'fable', { now: NOW })

    expect(result.authoritative).toBe(false)
    expect(result.scope).toBeNull()
    expect(result.clamped).toBe(true)
    expect(result.resetTimestamp).toBe(Math.floor(NOW / 1000) + DEFAULT_MAX_FALLBACK_SECONDS)
    expect(result.resetTimestamp).toBeLessThan(SEVEN_DAY_RESET)
  })

  it('honours a custom fallback cap', () => {
    const result = resolveRateLimitReset(headers(), 'fable', {
      now: NOW,
      maxFallbackSeconds: 900,
    })

    expect(result.resetTimestamp).toBe(Math.floor(NOW / 1000) + 900)
    expect(result.clamped).toBe(true)
    expect(result.scope).toBeNull()
    expect(result.authoritative).toBe(false)
  })

  it('ignores non-positive fallback cap and uses default', () => {
    const result = resolveRateLimitReset(headers(), 'fable', {
      now: NOW,
      maxFallbackSeconds: -1,
    })

    expect(result.resetTimestamp).toBe(Math.floor(NOW / 1000) + DEFAULT_MAX_FALLBACK_SECONDS)
    expect(result.scope).toBeNull()
  })

  it('leaves a near-term fallback reset untouched but non-authoritative', () => {
    const soon = Math.floor(NOW / 1000) + 120
    const result = resolveRateLimitReset(
      {
        'anthropic-ratelimit-unified-reset': String(soon),
      },
      'fable',
      { now: NOW },
    )

    expect(result.resetTimestamp).toBe(soon)
    expect(result.clamped).toBe(false)
    expect(result.authoritative).toBe(false)
    expect(result.scope).toBeNull()
  })

  it('reads headers case-insensitively', () => {
    const result = resolveRateLimitReset(
      {
        'Anthropic-RateLimit-Unified-5h-Status': 'rejected',
        'Anthropic-RateLimit-Unified-5h-Reset': String(FIVE_HOUR_RESET),
      },
      'fable',
      { now: NOW },
    )

    expect(result.resetTimestamp).toBe(FIVE_HOUR_RESET)
    expect(result.windowKey).toBe('5h')
  })

  it('accepts ISO timestamps as well as unix seconds', () => {
    const result = resolveRateLimitReset(
      {
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': '2026-09-05T06:10:00Z',
      },
      'fable',
      { now: NOW },
    )

    expect(result.resetTimestamp).toBe(FIVE_HOUR_RESET)
  })

  it('returns null when there is nothing usable to go on', () => {
    expect(resolveRateLimitReset({}, 'fable', { now: NOW }).resetTimestamp).toBeNull()
    expect(resolveRateLimitReset(null, 'fable', { now: NOW }).resetTimestamp).toBeNull()
    expect(resolveRateLimitReset(undefined, null, { now: NOW }).resetTimestamp).toBeNull()
  })
})

describe('parseRateLimitWindows', () => {
  it('parses every window the upstream reports', () => {
    const windows = parseRateLimitWindows(headers())
    expect(windows.map((window) => window.key)).toEqual(['5h', '7d', '7d_oi'])

    const fiveHour = windows.find((window) => window.key === '5h')
    expect(fiveHour).toMatchObject({
      status: 'allowed',
      reset: FIVE_HOUR_RESET,
      utilization: 0.11,
      family: null,
      isAccountWide: true,
    })

    const opusWindow = windows.find((window) => window.key === '7d_oi')
    expect(opusWindow).toMatchObject({ family: 'opus', isAccountWide: false })
  })

  it('skips windows the upstream did not report', () => {
    expect(parseRateLimitWindows({})).toEqual([])
    expect(parseRateLimitWindows(null)).toEqual([])
  })
})
