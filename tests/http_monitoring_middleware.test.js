import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import { httpRequestStats } from '../src/common/http_request_stats.js'

const logger = Object.fromEntries(
  ['info', 'warn', 'error', 'debug', 'security'].map((name) => [name, jest.fn()])
)
const modules = {
  '../config/config.js': { config: { security: {} } },
  '../config/env.js': { env: {} },
  '../src/common/logger.js': { logger },
  '../src/infra/redis.js': { redis: {} },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: {} },
  '../src/modules/user/user_service.js': { userService: {} },
  '../src/modules/relay/relay_claude_relay_config_service.js': { claudeRelayConfigService: {} },
  '../src/modules/payment/payment_balance_ledger.js': { balanceLedger: {} },
  '../src/modules/account/account_group_policy.js': {}
}
for (const [name, exports] of Object.entries(modules)) {
  jest.unstable_mockModule(name, () => exports)
}
const { requestLogger } = await import('../src/infra/middleware_auth.js')
const fixture = (path, stream = false) => {
  const req = {
    originalUrl: path,
    method: stream ? 'POST' : 'GET',
    body: { stream },
    get: () => undefined,
    ip: '127.0.0.1'
  }
  const res = new EventEmitter()
  Object.assign(res, {
    statusCode: 200,
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    setHeader: jest.fn(),
    get: () => (stream ? 'text/event-stream' : 'application/json'),
    write: jest.fn(() => {
      res.headersSent = true
      return true
    }),
    json: jest.fn()
  })
  requestLogger(req, res, jest.fn())
  return { req, res }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers().setSystemTime(Date.parse('2026-10-13T12:00:00.000Z'))
  httpRequestStats.reset()
})
afterEach(() => jest.useRealTimers())

it('keeps a long successful generation in access logs without a slow-first-token warning', () => {
  const { res } = fixture('/openai/responses', true)
  jest.advanceTimersByTime(100)
  res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')
  jest.advanceTimersByTime(60000)
  res.emit('finish')
  res.emit('close')
  expect(logger.warn).not.toHaveBeenCalled()
  expect(logger.info.mock.calls[0][1]._file.durationMs).toBe(60100)
  expect(httpRequestStats.getStats().requests).toBe(1)
})

it('warns about a slow content start and includes the request identity', () => {
  const { req, res } = fixture('/openai/responses', true)
  jest.advanceTimersByTime(6000)
  res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')
  res.emit('finish')
  expect(logger.warn).toHaveBeenCalledWith('Slow first token: 6000ms POST /openai/responses', {
    requestId: req.requestId,
    durationMs: 6000
  })
})

it('retains slow nonstream request warnings and excludes query-string health requests', () => {
  const { res } = fixture('/admin/dashboard')
  jest.advanceTimersByTime(6000)
  res.emit('finish')
  expect(logger.warn.mock.calls[0][0]).toBe('Slow request: 6000ms GET /admin/dashboard')
  const health = fixture('/health?probe=local')
  health.res.emit('finish')
  expect(httpRequestStats.getStats().requests).toBe(1)
})
