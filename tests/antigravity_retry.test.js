import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { PassThrough, Readable } from 'node:stream'
import { setTimeout as wait } from 'node:timers/promises'
import { parseRetryAfterMilliseconds } from '../src/common/retry_after.js'
import { parseAntigravityRetryDelayMs, readAntigravityErrorBody } from '../src/modules/relay/relay_antigravity_retry.js'

const axios = jest.fn()
const env = {}
jest.unstable_mockModule('axios', () => ({ default: axios }))
jest.unstable_mockModule('../config/env.js', () => ({ env }))
jest.unstable_mockModule('../config/config.js', () => ({ config: { proxy: { timeout: 1000 } } }))
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: new Proxy({}, { get: () => jest.fn() }) }))
jest.unstable_mockModule('../src/modules/proxy/proxy_helper.js', () => ({
  ProxyHelper: { createProxyAgent: () => null },
}))
jest.unstable_mockModule('../src/modules/relay/relay_antigravity_upstream_dump.js', () => ({
  dumpAntigravityUpstreamRequest: async () => {},
}))
const { request } = await import('../src/modules/relay/relay_antigravity_client.js')
const payload = { accessToken: 'fixture', requestData: { model: 'gemini-2.5-flash', request: { contents: [] } } }
const body = (retryDelay) => ({
  error: {
    status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }],
  },
})
const limited = (data, headers = {}) =>
  Object.assign(new Error('fixture rate limit'), { response: { status: 429, data, headers } })
beforeEach(() => {
  axios.mockReset()
  env.ANTIGRAVITY_API_URL = 'https://fixture.example'
})

describe('retry hint contracts', () => {
  it('parses seconds and dates without losing explicit zero or rounding a minimum wait down', () => {
    expect(parseRetryAfterMilliseconds('0')).toBe(0)
    expect(parseRetryAfterMilliseconds('1.25')).toBe(1250)
    expect(parseRetryAfterMilliseconds('-1')).toBeNull()
    expect(parseRetryAfterMilliseconds('invalid')).toBeNull()
    expect(parseRetryAfterMilliseconds('Wed, 25 Nov 2026 12:00:05 GMT', Date.parse('2026-11-25T12:00:00Z'))).toBe(5000)
  })
  it('prefers valid Google RetryInfo including zero over Retry-After', () => {
    expect(parseAntigravityRetryDelayMs({ data: body('0.025s'), headers: { 'retry-after': '45' } })).toBe(25)
    expect(parseAntigravityRetryDelayMs({ data: body('0s'), headers: { 'retry-after': '45' } })).toBe(0)
    expect(parseAntigravityRetryDelayMs({ data: body('0.000000001s') })).toBe(1)
    expect(parseAntigravityRetryDelayMs({ data: body('invalid'), headers: { 'retry-after': '3' } })).toBe(3000)
    expect(parseAntigravityRetryDelayMs({ data: `event: error\ndata: ${JSON.stringify(body('0.02s'))}\n\n` })).toBe(20)
  })
  it('decodes failed streams with a byte/time limit and closes their connections', async () => {
    const stream = Readable.from([Buffer.from(JSON.stringify(body('0.025s')))])
    const response = { data: stream }
    await readAntigravityErrorBody(response, { timeoutMs: 100 })
    expect(response.data).toEqual(body('0.025s'))
    expect(stream.destroyed).toBe(true)
    const oversized = Readable.from([Buffer.alloc(128 * 1024, 'x')])
    const bounded = { data: oversized }
    await readAntigravityErrorBody(bounded, { timeoutMs: 100 })
    expect(Buffer.byteLength(bounded.data)).toBe(64 * 1024)
    expect(oversized.destroyed).toBe(true)
    const stalled = new PassThrough()
    await readAntigravityErrorBody({ data: stalled }, { timeoutMs: 10 })
    expect(stalled.destroyed).toBe(true)
  })
})

describe('Antigravity generation retries', () => {
  it('honors structured stream errors before retrying without changing the payload', async () => {
    const stream = Readable.from([JSON.stringify(body('0.025s'))])
    let firstCallAt
    axios.mockImplementationOnce(async () => {
      firstCallAt = Date.now()
      throw limited(stream, { 'retry-after': '45' })
    })
    axios.mockImplementationOnce(async () => {
      expect(Date.now() - firstCallAt).toBeGreaterThanOrEqual(24)
      return { data: Readable.from(['ok']) }
    })
    const original = structuredClone(payload.requestData)
    await request({ ...payload, stream: true })
    expect(axios).toHaveBeenCalledTimes(2)
    expect(axios.mock.calls[1][0].data).toEqual(axios.mock.calls[0][0].data)
    expect(stream.destroyed).toBe(true)
    expect(payload.requestData).toEqual(original)
  })

  it('waits for header-only 429 hints before changing to a fallback endpoint', async () => {
    delete env.ANTIGRAVITY_API_URL
    let rejectedAt
    axios.mockImplementationOnce(async () => {
      rejectedAt = Date.now()
      throw limited({}, { 'retry-after': '0.025' })
    })
    axios.mockImplementationOnce(async () => {
      expect(Date.now() - rejectedAt).toBeGreaterThanOrEqual(24)
      return { data: {} }
    })
    await request(payload)
    expect(axios.mock.calls[0][0].url).not.toBe(axios.mock.calls[1][0].url)
  })

  it('does not shorten a hint to fit the remaining request budget', async () => {
    const error = limited(body('300s'))
    axios.mockRejectedValue(error)
    await expect(request({ ...payload, timeoutMs: 20 })).rejects.toBe(error)
    expect(axios).toHaveBeenCalledTimes(1)
  })

  it('keeps retries bounded and accepts explicit zero without replacing it with two seconds', async () => {
    axios.mockRejectedValue(limited(body('0s')))
    await expect(request(payload)).rejects.toThrow('fixture rate limit')
    expect(axios).toHaveBeenCalledTimes(2)
  })

  it('cancels the retry delay promptly when the caller disconnects', async () => {
    const controller = new AbortController()
    axios.mockRejectedValue(limited(body('1s')))
    const promise = request({ ...payload, timeoutMs: 2000, signal: controller.signal })
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    setTimeout(() => controller.abort(), 10)
    await assertion
    expect(axios).toHaveBeenCalledTimes(1)
  })

  it('bounds a stalled stream connection but does not add a generation timeout after headers', async () => {
    axios.mockImplementationOnce(
      (options) =>
        new Promise((resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(new Error('fixture canceled')), { once: true }),
        ),
    )
    await expect(request({ ...payload, stream: true, timeoutMs: 10 })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    expect(axios).toHaveBeenCalledTimes(1)
    axios.mockReset().mockResolvedValue({ data: Readable.from(['ok']) })
    await request({ ...payload, stream: true, timeoutMs: 10 })
    await wait(20)
    expect(axios.mock.calls[0][0].signal.aborted).toBe(false)
  })

  it('closes a stalled error body when its request budget expires', async () => {
    const stream = new PassThrough()
    axios.mockRejectedValue(limited(stream))
    await expect(request({ ...payload, stream: true, timeoutMs: 15 })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    expect(stream.destroyed).toBe(true)
    expect(axios).toHaveBeenCalledTimes(1)
  })
})
