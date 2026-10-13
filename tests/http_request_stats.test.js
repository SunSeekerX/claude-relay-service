import { EventEmitter } from 'node:events'
import { httpRequestStats } from '../src/common/http_request_stats.js'
import {
  createRequestDetailMeta,
  finalizeRequestDetailMeta
} from '../src/modules/relay/relay_request_detail_helper.js'

const observe = (url = '/openai/responses', statusCode = 200) => {
  const req = { originalUrl: url, method: 'POST' }
  const res = new EventEmitter()
  Object.assign(res, { statusCode, headersSent: true })
  httpRequestStats.observe(req, res)
  return { req, res }
}

beforeEach(() => httpRequestStats.reset())

it('counts HTTP statuses and disconnects exactly once, excluding health checks', () => {
  for (const status of [200, 302, 401, 502]) {
    const { res } = observe('/admin/dashboard', status)
    res.emit('finish')
    res.emit('close')
  }
  observe('/openai/responses').res.emit('close')
  observe('/health?probe=docker').res.emit('finish')
  observe('/api/health').res.emit('finish')
  expect(httpRequestStats.getStats()).toMatchObject({
    requests: 5,
    http: { completed: 4, disconnected: 1, status2xx: 2, status3xx: 1, status4xx: 1, status5xx: 1 },
    relay: { total: 0 }
  })
})

it('keeps an HTTP 200 separate from a failed SSE terminal and missing usage', () => {
  const { req, res } = observe()
  req._crsRecordRelayResult({
    statusCode: 502,
    errorCode: 'server_error',
    hasUsage: false,
    final: true
  })
  res.emit('finish')
  expect(httpRequestStats.getStats()).toMatchObject({
    http: { completed: 1, status2xx: 1 },
    relay: { total: 1, completed: 0, failed: 1, unmetered: 1 }
  })
})

it('records the later upstream completion after the client disconnects', () => {
  const { req, res } = observe()
  res.emit('close')
  expect(httpRequestStats.getStats().relay.total).toBe(0)
  req._crsRecordRelayResult({ statusCode: 200, hasUsage: true, final: true })
  req._crsRecordRelayResult({ statusCode: 200, hasUsage: true, final: true })
  expect(httpRequestStats.getStats()).toMatchObject({
    requests: 1,
    http: { disconnected: 1 },
    relay: { total: 1, completed: 1, unmetered: 0 }
  })
})

it('retains an explicit final failure after an earlier usage callback and later billing callback', () => {
  const { req } = observe()
  const meta = createRequestDetailMeta(req)
  finalizeRequestDetailMeta(meta)
  req._crsRecordRelayResult({ statusCode: 502, hasUsage: true, final: true })
  finalizeRequestDetailMeta(meta)
  expect(httpRequestStats.getStats().relay).toEqual({
    total: 1,
    completed: 0,
    failed: 1,
    incomplete: 0,
    unmetered: 0
  })
})

it('keeps output-limited incompleteness distinct from failures and normal completion', () => {
  const { req } = observe()
  req._crsRecordRelayResult({ statusCode: 200, errorCode: 'response_incomplete', hasUsage: true })
  expect(httpRequestStats.getStats().relay).toMatchObject({ total: 1, incomplete: 1, failed: 0 })
})

it('counts upstream nonstream rejection but does not treat an auth refusal as forwarding', () => {
  const denied = observe('/api/v1/messages', 401)
  denied.res.emit('finish')
  const upstream = observe('/openai/responses', 503)
  upstream.req._crsUpstreamHeaders = {}
  upstream.res.emit('finish')
  expect(httpRequestStats.getStats()).toMatchObject({
    requests: 2,
    relay: { total: 1, failed: 1 }
  })
})

it('returns independent snapshots and resets the counters', () => {
  observe().res.emit('finish')
  const snapshot = httpRequestStats.getStats()
  snapshot.http.completed = 99
  expect(httpRequestStats.getStats().http.completed).toBe(1)
  httpRequestStats.reset()
  expect(httpRequestStats.getStats().requests).toBe(0)
})
