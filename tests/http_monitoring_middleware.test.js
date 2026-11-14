import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import { httpRequestStats } from '../src/common/http_request_stats.js'
import { createRequestResourceBudget } from '../src/infra/middleware_request_resources.js'
import { createRequestDetailMeta, recordRequestUsageSummary } from '../src/modules/relay/relay_request_detail_helper.js'

const logger = Object.fromEntries(['info', 'warn', 'error', 'debug', 'security'].map((name) => [name, jest.fn()]))
const modules = {
  '../config/config.js': { config: { security: {} } },
  '../config/env.js': { env: {} },
  '../src/common/logger.js': { logger },
  '../src/infra/redis.js': { redis: {} },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: {} },
  '../src/modules/user/user_service.js': { userService: {} },
  '../src/modules/relay/relay_claude_relay_config_service.js': { claudeRelayConfigService: {} },
  '../src/modules/payment/payment_balance_ledger.js': { balanceLedger: {} },
  '../src/modules/account/account_group_policy.js': {},
  '../src/modules/relay/relay_routing_service.js': {
    resolveRequestRoute: jest.fn(),
    applyRouteBinding: jest.fn(),
    resolveDefaultModelRoutes: jest.fn(),
    getRouteModels: jest.fn(),
    getLegacyProviderModels: jest.fn(),
  },
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
    ip: '127.0.0.1',
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
    json: jest.fn(),
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

it('logs one successful access summary with persisted model, account, terminal and accumulated usage', () => {
  const { req, res } = fixture('/openai/responses', true)
  const meta = createRequestDetailMeta(req)
  for (let part = 0; part < 2; part++) {
    recordRequestUsageSummary(meta, {
      model: 'actual-model', accountId: 'account-1', accountType: 'openai-responses',
      inputTokens: 2, outputTokens: 3, totalTokens: 5, cost: 0.01, realCost: 0.01,
      billingAudit: { protocolTerminal: 'response.completed' },
    })
  }
  res.emit('finish')
  res.emit('close')
  req._crsFinalizeRequestLog()
  expect(logger.info).toHaveBeenCalledTimes(1)
  expect(logger.info.mock.calls[0][1]._file).toMatchObject({
    model: 'actual-model', accountId: 'account-1', protocolTerminal: 'response.completed',
    usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10, recordCount: 2, cost: 0.02 },
  })
})

it('logs a disconnect after end was called when the response never finished flushing', () => {
  const { res } = fixture('/openai/responses', true)
  res.headersSent = true
  res.writableEnded = true
  res.writableFinished = false
  res.emit('close')
  expect(logger.info).not.toHaveBeenCalled()
  expect(logger.warn).toHaveBeenCalledTimes(1)
  expect(logger.warn.mock.calls[0][1]._file).toMatchObject({ statusCode: 200, clientDisconnected: true })
})

it('waits for usage draining after disconnect and emits one warning summary', () => {
  const { req, res } = fixture('/openai/responses', true)
  req.headers = { 'content-length': '20' }
  const budget = createRequestResourceBudget({ maxRequests: 0, maxBodyBytes: 1000, maxInflightBodyBytes: 0 })
  budget.middleware(req, res, () => {})
  req._crsReleaseRequestBodyProcessing()
  const release = req._crsRetainRequestResources()
  res.write('data:{"type":"response.output_text.delta","delta":"hi"}\n\n')
  jest.advanceTimersByTime(100)
  res.emit('close')
  expect(logger.info).not.toHaveBeenCalled()
  expect(logger.warn).not.toHaveBeenCalled()
  jest.advanceTimersByTime(200)
  recordRequestUsageSummary(createRequestDetailMeta(req), {
    model: 'actual-model', totalTokens: 9, cost: 0.1, billingAudit: { protocolTerminal: 'response.completed' },
  })
  release()
  expect(logger.warn).toHaveBeenCalledTimes(1)
  expect(logger.warn.mock.calls[0][1]._file).toMatchObject({
    durationMs: 100, drainDurationMs: 200, clientDisconnected: true,
    protocolTerminal: 'response.completed', usage: { totalTokens: 9 },
  })
})

it('does not hide a failed SSE terminal behind its HTTP 200 status', () => {
  const { req, res } = fixture('/openai/responses', true)
  req._crsRecordRelayResult({ statusCode: 502, errorCode: 'upstream_stream_incomplete', hasUsage: false, final: true })
  res.emit('finish')
  expect(logger.warn).toHaveBeenCalledTimes(1)
  expect(logger.warn.mock.calls[0][1]._file).toMatchObject({ statusCode: 200, relayStatusCode: 502, errorCode: 'upstream_stream_incomplete' })
})

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
    durationMs: 6000,
  })
})

it('times a custom tool input delta after control frames and keeps the first content time', () => {
  const { req, res } = fixture('/openai/responses', true)
  jest.advanceTimersByTime(100)
  res.write('event: response.created\ndata: {"type":"response.created","response":{}}\n\n')
  res.write('data: {"type":"response.output_item.added","item":{"type":"custom_tool_call"}}\n\n')
  expect(req.firstTokenMs).toBeNull()
  jest.advanceTimersByTime(500)
  res.write(Buffer.from('data: {"type":"response.custom_tool_call_input.delta","delta":"*** Begin Patch"}\n\n'))
  expect(req.firstTokenMs).toBe(600)
  jest.advanceTimersByTime(6000)
  res.write('data: {"type":"response.output_text.delta","delta":"done"}\n\n')
  res.emit('finish')
  expect(req.firstTokenMs).toBe(600)
  expect(logger.warn).not.toHaveBeenCalled()
})

it('warns when a custom tool input is the first content after a slow start', () => {
  const { req, res } = fixture('/openai/responses', true)
  jest.advanceTimersByTime(6000)
  res.write('data: {"type":"response.custom_tool_call_input.delta","delta":"patch"}\n\n')
  res.emit('finish')
  expect(logger.warn).toHaveBeenCalledWith('Slow first token: 6000ms POST /openai/responses', {
    requestId: req.requestId,
    durationMs: 6000,
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
