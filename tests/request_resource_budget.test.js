import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import zlib from 'node:zlib'
import http from 'node:http'
import express from 'express'
import request from 'supertest'
import { createRequestResourceBudget } from '../src/infra/middleware_request_resources.js'

jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: { warn: jest.fn(), security: jest.fn(), debug: jest.fn(), error: jest.fn() },
}))
jest.unstable_mockModule('../config/request_resources.js', () => ({
  requestResourcesConfig: { maxBodyBytes: 1024 },
}))
const { createRequestBodyParser } = await import('../src/infra/middleware_request_decompress.js')

const makeBudget = (overrides = {}) =>
  createRequestResourceBudget({ maxRequests: 2, maxBodyBytes: 1024, maxInflightBodyBytes: 2048, ...overrides })
const admit = (budget, headers = { 'content-length': '400' }, path = '/openai/responses') => {
  const req = { method: 'POST', originalUrl: path, headers }
  const res = new EventEmitter()
  res.setHeader = jest.fn()
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  const next = jest.fn()
  budget.middleware(req, res, next)
  if (next.mock.calls[0]?.length === 0) {
    req._crsReleaseRequestBodyProcessing?.()
  }
  return { req, res, next }
}

test('rejects excess requests before any downstream parsing and frees capacity exactly once', () => {
  const budget = makeBudget()
  const first = admit(budget)
  admit(budget)
  const rejected = admit(budget)
  expect(rejected.next).not.toHaveBeenCalled()
  expect(rejected.res.status).toHaveBeenCalledWith(503)
  expect(rejected.res.setHeader).toHaveBeenCalledWith('Retry-After', '1')
  first.res.emit('finish')
  first.res.emit('close')
  expect(budget.status()).toMatchObject({ activeRequests: 1, activeBodyBytes: 400 })
  expect(admit(budget).next).toHaveBeenCalledWith()
})

test('reserves the decoded upper bound for compressed and chunked bodies before reading', () => {
  const budget = makeBudget({ maxRequests: 64, maxInflightBodyBytes: 1500 })
  const first = admit(budget, { 'content-length': '10', 'content-encoding': 'zstd' })
  expect(budget.status().activeBodyBytes).toBe(1024)
  expect(admit(budget, { 'transfer-encoding': 'chunked' }).res.status).toHaveBeenCalledWith(503)
  first.req._crsRecordRequestBodyBytes(200)
  expect(admit(budget, { 'transfer-encoding': 'chunked' }).next).toHaveBeenCalledWith()
  expect(budget.status().activeBodyBytes).toBe(1224)
})

test('retains capacity after client close until usage draining completes', () => {
  const budget = makeBudget({ maxRequests: 1 })
  const { req, res } = admit(budget)
  const release = req._crsRetainRequestResources()
  res.emit('close')
  expect(admit(budget).res.status).toHaveBeenCalledWith(503)
  release()
  release()
  expect(budget.status()).toMatchObject({ activeRequests: 0, activeBodyBytes: 0 })
  expect(admit(budget).next).toHaveBeenCalledWith()
})

test('a disconnect during decoding cannot release capacity before body processing settles', () => {
  const budget = makeBudget({ maxRequests: 1 })
  const req = {
    method: 'POST',
    originalUrl: '/responses',
    headers: { 'content-encoding': 'zstd', 'content-length': '10' },
  }
  const res = new EventEmitter()
  budget.middleware(req, res, () => {})
  res.emit('close')
  expect(budget.status()).toMatchObject({ activeRequests: 1, activeBodyBytes: 1024 })
  req._crsReleaseRequestBodyProcessing()
  req._crsReleaseRequestBodyProcessing()
  expect(budget.status()).toMatchObject({ activeRequests: 0, activeBodyBytes: 0 })
})

test('GET health checks remain available while the relay is at capacity', () => {
  const budget = makeBudget({ maxRequests: 1 })
  admit(budget)
  const next = jest.fn()
  budget.middleware({ method: 'GET', url: '/health', headers: {} }, {}, next)
  expect(next).toHaveBeenCalledWith()
  expect(budget.status().activeRequests).toBe(1)
})

test.each([
  ['/v1/messages', { type: 'error', error: { type: 'overloaded_error' } }],
  ['/gemini/v1internal:streamGenerateContent', { error: { code: 503, status: 'UNAVAILABLE' } }],
  ['/grok/v1/responses', { error: { type: 'server_error', code: 'server_overloaded' } }],
])('preserves the overload error shape at %s', (path, body) => {
  const budget = makeBudget({ maxRequests: 1 })
  admit(budget)
  expect(admit(budget, {}, path).res.json.mock.calls[0][0]).toMatchObject(body)
})

const makeApp = () => {
  const app = express()
  const budget = makeBudget()
  app.use(budget.middleware)
  app.use(
    createRequestBodyParser(express.json, {
      type: 'application/json',
      limit: 1024,
      verify: (req, _res, buffer) => req._crsRecordRequestBodyBytes(buffer.length),
    }),
  )
  app.use((req, _res, next) => {
    req._crsReleaseRequestBodyProcessing?.()
    next()
  })
  app.post('/responses', (req, res) => res.json({ body: req.body, resources: budget.status() }))
  app.use((error, req, res, _next) => {
    req._crsReleaseRequestBodyProcessing?.()
    res.status(error.statusCode ?? error.status ?? 500).json({ error: error.type })
  })
  return { app, budget }
}

test.each(['gzip', 'br', 'zstd', 'identity'])(
  'parses %s requests through Express and releases their resource reservation',
  async (encoding) => {
    const { app, budget } = makeApp()
    const body = { model: 'fixture', input: '中'.repeat(70) }
    const raw = Buffer.from(JSON.stringify(body))
    const compress = {
      gzip: zlib.gzipSync,
      br: zlib.brotliCompressSync,
      zstd: zlib.zstdCompressSync,
      identity: (value) => value,
    }[encoding]
    const response = await request(app)
      .post('/responses')
      .set('content-encoding', encoding)
      .set('content-type', 'application/json')
      .serialize((value) => value)
      .send(compress(raw))
    expect(response.status).toBe(200)
    expect(response.body.body).toEqual(body)
    expect(response.body.resources.activeBodyBytes).toBe(raw.length)
    expect(budget.status().activeRequests).toBe(0)
  },
)

test.each(['gzip', 'br', 'zstd'])(
  'rejects an inflated %s body over the limit and releases its reservation',
  async (encoding) => {
    const { app, budget } = makeApp()
    const compress = { gzip: zlib.gzipSync, br: zlib.brotliCompressSync, zstd: zlib.zstdCompressSync }[encoding]
    const response = await request(app)
      .post('/responses')
      .set('content-type', 'application/json')
      .set('content-encoding', encoding)
      .serialize((value) => value)
      .send(compress(Buffer.from(JSON.stringify({ input: 'x'.repeat(2000) }))))
    expect(response.status).toBe(413)
    expect(budget.status()).toMatchObject({ activeRequests: 0, activeBodyBytes: 0 })
  },
)

test('malformed JSON and an oversized Content-Length cannot leak a reservation', async () => {
  const { app, budget } = makeApp()
  expect((await request(app).post('/responses').type('json').send('{')).status).toBe(400)
  expect((await request(app).post('/responses').send('x'.repeat(1500))).status).toBe(413)
  expect(budget.status()).toMatchObject({ activeRequests: 0, activeBodyBytes: 0 })
})

test('an aborted compressed upload releases its bytes and does not leave an unhandled request error', async () => {
  const { app, budget } = makeApp()
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const closed = new Promise((resolve) => server.once('request', (_req, res) => res.once('close', resolve)))
  const client = http.request({
    host: '127.0.0.1',
    port: server.address().port,
    path: '/responses',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
  })
  client.on('error', () => {})
  server.once('request', (req) => req.once('data', () => client.destroy()))
  try {
    client.write(zlib.brotliCompressSync(Buffer.from('{"input":"fixture"}')).subarray(0, 2))
    await closed
    await new Promise((resolve) => setImmediate(resolve))
    expect(budget.status()).toMatchObject({ activeRequests: 0, activeBodyBytes: 0 })
  } finally {
    client.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})
