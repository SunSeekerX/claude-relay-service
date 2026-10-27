import { jest } from '@jest/globals'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { attach } from '../src/infra/redis_gemini_interactions_store.js'
import { RedisKeys } from '../src/infra/redis_key.js'

const values = new Map()
const pending = new Map()
const client = {
  get: async (key) => values.get(key) ?? null,
  set: async (key, value, ...options) => {
    if (options.includes('NX') && values.has(key)) {
      return null
    }
    if (options.includes('XX') && !values.has(key)) {
      return null
    }
    values.set(key, value)
    return 'OK'
  },
  zadd: async (_key, score, member) => pending.set(member, score),
  zrem: async (_key, member) => pending.delete(member),
  zrangebyscore: async () => [...pending].filter(([, score]) => score <= Date.now()).map(([key]) => key),
  eval: async (_script, _n, key, owner) => {
    if (values.get(key) === owner) {
      return Number(values.delete(key))
    }
    return 0
  }
}
const redis = { getClientSafe: () => client }
attach(redis)
const recordRateLimit = jest.spyOn(redis, 'recordGeminiInteractionRateLimit')
const axios = jest.fn()
const recordUsage = jest.fn()
const scheduler = { selectAccountForApiKey: jest.fn(), _isAccountAvailable: jest.fn().mockResolvedValue(true) }
const outbound = jest.fn()
const markUnavailable = jest.fn().mockResolvedValue({ success: true })
const mocks = {
  axios: { default: axios },
  '../config/config.js': { config: { proxy: { timeout: 1000 } } },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/infra/redis.js': { redis },
  '../src/modules/account/account_gemini_api_service.js': {
    geminiApiAccountService: {
      getAccount: async (id) => ({ id, baseUrl: 'https://example.test/v1beta/models', apiKey: 'fixture-secret' })
    }
  },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: { recordUsage } },
  '../src/modules/proxy/proxy_resolver.js': {
    proxyResolver: { resolveAgent: () => ({ agent: undefined }), report: jest.fn() }
  },
  '../src/modules/relay/relay_unified_gemini_scheduler.js': { unifiedGeminiScheduler: scheduler },
  '../src/modules/relay/relay_model_access.js': { assertModelAccess: jest.fn(), assertOutboundModelAccess: outbound },
  '../src/modules/relay/relay_upstream_error_helper.js': {
    markTempUnavailable: markUnavailable,
    parseRetryAfter: () => null,
    buildErrorContext: (context) => context
  },
  '../src/common/client_error_builder.js': {
    buildClientError: ({ statusCode, upstreamBody }) => ({ statusCode, body: upstreamBody })
  }
}
for (const [name, exports] of Object.entries(mocks)) {
  jest.unstable_mockModule(name, () => exports)
}
const { GeminiInteractionsService, buildInteractionUrl } =
  await import('../src/modules/relay/relay_gemini_interactions_service.js')

class Response extends EventEmitter {
  constructor() {
    super()
    this.statusCode = 200
    this.headers = {}
    this.chunks = []
    this.destroyed = false
    this.writableEnded = false
    this.headersSent = false
  }
  status(code) {
    this.statusCode = code
    return this
  }
  json(body) {
    this.body = body
    this.writableEnded = true
    return this
  }
  setHeader(key, value) {
    this.headers[key] = value
  }
  write(chunk) {
    this.headersSent = true
    this.chunks.push(Buffer.from(chunk))
    return true
  }
  end() {
    this.writableEnded = true
  }
}
const request = (body = {}, ownerId = 'key-1') => ({
  apiKey: { id: ownerId },
  body,
  params: {},
  query: {},
  path: '/v1beta/interactions',
  method: 'POST',
  requestId: 'req-1',
  requestStartedAt: Date.now()
})
const usage = {
  total_input_tokens: 100,
  total_cached_tokens: 30,
  total_output_tokens: 20,
  total_thought_tokens: 5,
  total_tokens: 125
}
const complete = { id: 'int-1', status: 'completed', model: 'gemini-test', usage, steps: [] }
const due = () => {
  for (const key of pending.keys()) {
    pending.set(key, 0)
  }
}
let service

beforeEach(() => {
  jest.clearAllMocks()
  values.clear()
  pending.clear()
  recordUsage.mockResolvedValue({ realCost: 1, ratedCost: 1 })
  recordRateLimit.mockImplementation(async (key) => {
    values.set(key, JSON.stringify({ ...JSON.parse(values.get(key)), rateLimitRecorded: true }))
    return 1
  })
  scheduler.selectAccountForApiKey.mockResolvedValue({ accountId: 'api-1', accountType: 'gemini-api' })
  axios.mockResolvedValue({ status: 200, data: complete })
  service = new GeminiInteractionsService()
})

it('forwards the official body/path and bills repeated resource reads only once', async () => {
  const body = { model: 'gemini-test', input: 'hello', store: true, generation_config: { temperature: 0 } }
  const req = request(body)
  const res = new Response()
  await service.create(req, res, {})
  expect(res.body).toEqual(complete)
  expect(axios.mock.calls[0][0]).toMatchObject({
    url: 'https://example.test/v1beta/interactions',
    method: 'POST',
    data: body,
    headers: { 'x-goog-api-key': 'fixture-secret' }
  })
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(recordUsage.mock.calls[0][1]).toMatchObject({
    input_tokens: 70,
    output_tokens: 20,
    reasoning_tokens: 5,
    _upstreamUsage: usage
  })
  expect(recordUsage.mock.calls[0][6]).toMatchObject({ protocolTerminal: 'completed', billingDedupTtl: 55 * 86400 })
  req.params.id = 'int-1'
  req.method = 'GET'
  await Promise.all([service.resource(req, new Response(), 'get'), service.resource(req, new Response(), 'get')])
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(JSON.stringify([...values])).not.toContain('hello')
})

it('counts native final usage and its rated cost once despite repeated resource reads', async () => {
  const req = request({ model: 'gemini-test', input: 'hello' })
  req.rateLimitInfo = { tokenCountKey: 'fixture', costCountKey: 'fixture-cost' }
  await service.create(req, new Response(), {})
  req.params.id = 'int-1'
  req.method = 'GET'
  await service.resource(req, new Response(), 'get')
  expect(recordRateLimit).toHaveBeenCalledTimes(1)
  expect(recordRateLimit).toHaveBeenCalledWith(RedisKeys.geminiInteraction.record('key-1', 'int-1'), 'key-1', 125, 1)
  expect(recordUsage).toHaveBeenCalledTimes(1)
})

it('preserves a zero rated cost when window accounting follows settlement', async () => {
  recordUsage.mockResolvedValueOnce({ realCost: 1, ratedCost: 0 })
  const req = request({ model: 'gemini-test', input: 'hello' })
  req.rateLimitInfo = {}
  await service.create(req, new Response(), {})
  expect(recordRateLimit).toHaveBeenCalledWith(expect.any(String), 'key-1', 125, 0)
})

it('restores background window accounting after a service restart', async () => {
  axios.mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress', model: 'gemini-test' } })
  const req = request({ model: 'gemini-test', input: 'hello', background: true })
  req.rateLimitInfo = {}
  await service.create(req, new Response(), {})
  expect(recordRateLimit).not.toHaveBeenCalled()
  due()
  await new GeminiInteractionsService().poll()
  expect(recordRateLimit).toHaveBeenCalledWith(expect.any(String), 'key-1', 125, 1)
  expect(pending.size).toBe(0)
})

it('retries a failed window update from persisted settlement without rebilling or reading upstream', async () => {
  recordRateLimit.mockRejectedValueOnce(new Error('window store unavailable'))
  const req = request({ model: 'gemini-test', input: 'hello', store: false })
  req.rateLimitInfo = {}
  const res = new Response()
  await service.create(req, res, {})
  expect(res.body).toEqual(complete)
  expect(pending.size).toBe(1)
  expect(JSON.parse(values.get(RedisKeys.geminiInteraction.record('key-1', 'int-1')))).toMatchObject({
    billed: true,
    ratedCost: 1,
    rateLimitTokens: 125
  })
  axios.mockClear()
  due()
  await new GeminiInteractionsService().poll()
  expect(recordRateLimit).toHaveBeenCalledTimes(2)
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(axios).not.toHaveBeenCalled()
  expect(pending.size).toBe(0)
})

it('does not disclose another API key interaction or forward its resource request', async () => {
  await service.create(request({ model: 'gemini-test', input: 'hello' }), new Response(), {})
  axios.mockClear()
  const req = request({}, 'other-key')
  req.params.id = 'int-1'
  const res = new Response()
  await service.resource(req, res, 'get')
  expect(res.statusCode).toBe(404)
  expect(axios).not.toHaveBeenCalled()
})

it('keeps continuation on the original account and checks outbound model access', async () => {
  await service.create(request({ model: 'gemini-test', input: 'hello' }), new Response(), {})
  scheduler.selectAccountForApiKey.mockClear()
  axios.mockResolvedValueOnce({ status: 200, data: { ...complete, id: 'int-2' } })
  await service.create(
    request({ model: 'gemini-test', input: 'next', previous_interaction_id: 'int-1' }),
    new Response(),
    {}
  )
  expect(scheduler.selectAccountForApiKey).toHaveBeenCalledWith(
    expect.anything(),
    null,
    'gemini-test',
    expect.objectContaining({ pinnedAccountId: 'api-1' })
  )
  expect(outbound).toHaveBeenCalled()
})

it('settles background work through the bounded pending queue', async () => {
  axios.mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress', model: 'gemini-test' } })
  await service.create(request({ model: 'gemini-test', input: 'hello', background: true }), new Response(), {})
  expect(recordUsage).not.toHaveBeenCalled()
  due()
  await service.poll()
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(pending.size).toBe(0)
})

const seedLegacyRecord = async (overrides = {}) => {
  const record = {
    ownerId: 'key-1',
    id: 'int-1',
    accountId: 'api-1',
    version: 'v1beta',
    model: 'gemini-test',
    status: 'completed',
    stored: true,
    billed: false,
    usage,
    meta: { requestId: 'legacy-request' },
    ...overrides
  }
  const key = await redis.createGeminiInteraction(record)
  pending.set(key, 0)
  return { key, record }
}

it('retains legacy stateless evidence for manual reconciliation without billing or querying upstream', async () => {
  await seedLegacyRecord({ stored: false })
  await service.poll()
  expect(recordUsage).not.toHaveBeenCalled()
  expect(axios).not.toHaveBeenCalled()
  expect(await redis.getGeminiInteraction('key-1', 'int-1')).toMatchObject({
    usage,
    billed: false,
    settlementUnknown: true,
    settlementReviewRequired: true,
    settlementReviewReason: 'upstream_not_stored'
  })
  expect(pending.size).toBe(0)
  await new GeminiInteractionsService().poll()
  expect(axios).not.toHaveBeenCalled()
})

it('settles retained legacy resources only from fresh final upstream usage', async () => {
  await seedLegacyRecord()
  const finalUsage = { ...usage, total_output_tokens: 40, total_tokens: 145 }
  axios.mockResolvedValueOnce({ status: 200, data: { ...complete, usage: finalUsage } })
  await service.poll()
  expect(axios).toHaveBeenCalledTimes(1)
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(recordUsage.mock.calls[0][1]._upstreamUsage).toEqual(finalUsage)
  expect(recordUsage.mock.calls[0][6]).toMatchObject({
    requestId: 'legacy-request',
    billingDedupId: `gemini-interaction:${RedisKeys.geminiInteraction.record('key-1', 'int-1')}`
  })
  expect(await redis.getGeminiInteraction('key-1', 'int-1')).toMatchObject({ billed: true, usageFinal: true })
  expect(pending.size).toBe(0)
})

it('marks an unavailable legacy resource for reconciliation after one 404', async () => {
  await seedLegacyRecord()
  axios.mockRejectedValueOnce(Object.assign(new Error('not found'), { response: { status: 404 } }))
  await service.poll()
  expect(recordUsage).not.toHaveBeenCalled()
  expect(await redis.getGeminiInteraction('key-1', 'int-1')).toMatchObject({
    usage,
    billed: false,
    settlementUnknown: true,
    settlementReviewRequired: true,
    settlementReviewReason: 'upstream_not_found'
  })
  expect(pending.size).toBe(0)
  await service.poll()
  expect(axios).toHaveBeenCalledTimes(1)
})

it('does not promote unmarked legacy checkpoint usage when a final resource response omits usage', async () => {
  await seedLegacyRecord()
  axios.mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'completed' } })
  await service.poll()
  expect(recordUsage).not.toHaveBeenCalled()
  expect(await redis.getGeminiInteraction('key-1', 'int-1')).toMatchObject({
    usage,
    billed: false,
    settlementUnknown: true,
    settlementReviewRequired: true,
    settlementReviewReason: 'legacy_final_usage_unverified'
  })
  expect(pending.size).toBe(0)
})

it('retains the old usage evidence when the fresh legacy response has incomplete final counters', async () => {
  await seedLegacyRecord()
  axios.mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'completed', usage: { total_tokens: 130 } } })
  await service.poll()
  expect(recordUsage).not.toHaveBeenCalled()
  expect(await redis.getGeminiInteraction('key-1', 'int-1')).toMatchObject({
    usage: { total_tokens: 130 },
    checkpointUsage: usage,
    billed: false,
    settlementReviewRequired: true,
    settlementReviewReason: 'legacy_final_usage_unverified'
  })
  expect(pending.size).toBe(0)
})

it('keeps a transient upstream failure in the recovery queue', async () => {
  await seedLegacyRecord()
  axios.mockRejectedValueOnce(
    Object.assign(new Error('temporarily unavailable'), { response: { status: 503, data: {}, headers: {} } })
  )
  await service.poll()
  expect(recordUsage).not.toHaveBeenCalled()
  expect((await redis.getGeminiInteraction('key-1', 'int-1')).settlementReviewRequired).toBeUndefined()
  expect(pending.size).toBe(1)
  due()
  await service.poll()
  expect(recordUsage).toHaveBeenCalledTimes(1)
})

it('clears manual reconciliation only when a subsequent resource read provides final usage', async () => {
  await seedLegacyRecord()
  axios.mockRejectedValueOnce(Object.assign(new Error('not found'), { response: { status: 404 } }))
  await service.poll()
  const req = request()
  req.params.id = 'int-1'
  req.method = 'GET'
  await service.resource(req, new Response(), 'get')
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(await redis.getGeminiInteraction('key-1', 'int-1')).toMatchObject({
    billed: true,
    usageFinal: true,
    settlementUnknown: false,
    settlementReviewRequired: false,
    settlementReviewReason: null
  })
})

it('retries reconciliation state persistence when another settlement holds the lease', async () => {
  const { key } = await seedLegacyRecord({ stored: false })
  const owner = await redis.lockGeminiInteraction(key)
  await service.poll()
  expect((await redis.getGeminiInteraction('key-1', 'int-1')).settlementReviewRequired).toBeUndefined()
  expect(pending.size).toBe(1)
  await redis.unlockGeminiInteraction(key, owner)
  due()
  await service.poll()
  expect((await redis.getGeminiInteraction('key-1', 'int-1')).settlementReviewRequired).toBe(true)
  expect(pending.size).toBe(0)
})

it('does not overwrite a concurrently confirmed settlement with a stale reconciliation request', async () => {
  const { key, record } = await seedLegacyRecord()
  await redis.saveGeminiInteraction(key, { ...record, billed: true, usageFinal: true })
  await service._deferToReconciliation(record, 'upstream_not_found')
  expect(await redis.getGeminiInteraction('key-1', 'int-1')).toMatchObject({ billed: true, usageFinal: true })
  expect((await redis.getGeminiInteraction('key-1', 'int-1')).settlementReviewRequired).toBeUndefined()
  expect(pending.size).toBe(0)
})

it('persists billing evidence before a failed settlement and retries even store=false', async () => {
  recordUsage.mockRejectedValueOnce(new Error('ledger unavailable'))
  await service.create(request({ model: 'gemini-test', input: 'private', store: false }), new Response(), {})
  expect(pending.size).toBe(1)
  axios.mockClear()
  due()
  await service.poll()
  expect(recordUsage).toHaveBeenCalledTimes(2)
  expect(axios).not.toHaveBeenCalled()
  expect(pending.size).toBe(0)
  expect([...values.values()].some((value) => value.includes('private'))).toBe(false)
})

it('captures cancel usage before deleting the upstream resource', async () => {
  axios.mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress', model: 'gemini-test' } })
  const req = request({ model: 'gemini-test', input: 'hello', background: true })
  await service.create(req, new Response(), {})
  axios
    .mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress' } })
    .mockResolvedValueOnce({ status: 200, data: { ...complete, status: 'cancelled' } })
    .mockResolvedValueOnce({ status: 204 })
  req.params.id = 'int-1'
  const res = new Response()
  await service.resource(req, res, 'delete')
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(res.statusCode).toBe(204)
  expect(axios.mock.calls.slice(-2).map(([x]) => [x.method, x.url])).toEqual([
    ['POST', 'https://example.test/v1beta/interactions/int-1/cancel'],
    ['DELETE', 'https://example.test/v1beta/interactions/int-1']
  ])
})

it('allows deletion with a persistent unknown settlement marker when cancel omits usage', async () => {
  axios.mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress', model: 'gemini-test' } })
  const req = request({ model: 'gemini-test', input: 'hello', background: true })
  await service.create(req, new Response(), {})
  axios
    .mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress' } })
    .mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'cancelled' } })
    .mockResolvedValueOnce({ status: 204 })
  req.params.id = 'int-1'
  const res = new Response()
  await service.resource(req, res, 'delete')
  expect(res.statusCode).toBe(204)
  expect(recordUsage).not.toHaveBeenCalled()
  expect(JSON.parse(values.get(RedisKeys.geminiInteraction.record('key-1', 'int-1')))).toMatchObject({
    stored: false,
    billed: false,
    settlementUnknown: true
  })
  expect(pending.size).toBe(0)
})

it('retains GET usage as provisional evidence when deletion cancels without final usage', async () => {
  axios.mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress', model: 'gemini-test' } })
  const req = request({ model: 'gemini-test', input: 'private-input', background: true })
  await service.create(req, new Response(), {})
  axios
    .mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress', usage } })
    .mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'cancelled' } })
    .mockResolvedValueOnce({ status: 204 })
  req.params.id = 'int-1'
  const res = new Response()
  await service.resource(req, res, 'delete')
  expect(res.statusCode).toBe(204)
  expect(recordUsage).not.toHaveBeenCalled()
  expect(JSON.parse(values.get(RedisKeys.geminiInteraction.record('key-1', 'int-1')))).toMatchObject({
    usage,
    usageFinal: false,
    stored: false,
    billed: false,
    settlementUnknown: true
  })
  expect(JSON.stringify([...values])).not.toContain('private-input')
  expect(pending.size).toBe(0)
})

it('retains the earlier checkpoint when cancellation returns only an incomplete usage object', async () => {
  axios.mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress', model: 'gemini-test' } })
  const req = request({ model: 'gemini-test', input: 'hello', background: true })
  await service.create(req, new Response(), {})
  axios
    .mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress', usage } })
    .mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'cancelled', usage: { total_tokens: 130 } } })
    .mockResolvedValueOnce({ status: 204 })
  req.params.id = 'int-1'
  await service.resource(req, new Response(), 'delete')
  expect(recordUsage).not.toHaveBeenCalled()
  expect(JSON.parse(values.get(RedisKeys.geminiInteraction.record('key-1', 'int-1')))).toMatchObject({
    usage: { total_tokens: 130 },
    checkpointUsage: usage,
    billed: false,
    settlementUnknown: true
  })
  expect(pending.size).toBe(0)
})

it('does not promote an earlier stream checkpoint to final usage when cancellation omits usage', async () => {
  const events = [
    { event_type: 'interaction.created', interaction: { id: 'int-1', status: 'in_progress' } },
    { event_type: 'step.stop', index: 0, usage },
    { event_type: 'interaction.completed', interaction: { id: 'int-1', status: 'cancelled' } }
  ]
  axios.mockResolvedValueOnce({
    status: 200,
    data: Readable.from(events.map((event) => `data:${JSON.stringify(event)}\n\n`))
  })
  await service.create(
    request({ model: 'gemini-test', input: 'hello', stream: true, store: false }),
    new Response(),
    {}
  )
  expect(recordUsage).not.toHaveBeenCalled()
  expect(JSON.parse(values.get(RedisKeys.geminiInteraction.record('key-1', 'int-1')))).toMatchObject({
    usage,
    usageFinal: false,
    billed: false,
    settlementUnknown: true
  })
  expect(pending.size).toBe(0)
})

it('does not delete a resource while its observed usage cannot be persisted under another lease', async () => {
  axios.mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress', model: 'gemini-test' } })
  const req = request({ model: 'gemini-test', input: 'hello', background: true })
  await service.create(req, new Response(), {})
  const key = RedisKeys.geminiInteraction.record('key-1', 'int-1')
  const owner = await redis.lockGeminiInteraction(key)
  axios.mockResolvedValueOnce({ status: 200, data: { ...complete, status: 'in_progress' } })
  req.params.id = 'int-1'
  const res = new Response()
  await service.resource(req, res, 'delete')
  expect(res.statusCode).toBe(503)
  expect(axios.mock.calls.map(([config]) => config.method)).toEqual(['POST', 'GET'])
  await redis.unlockGeminiInteraction(key, owner)
})

it('does not treat incomplete usage evidence as a confirmed zero bill', async () => {
  axios.mockResolvedValueOnce({ status: 200, data: { ...complete, usage: { total_tokens: 123 } } })
  await service.create(request({ model: 'gemini-test', input: 'hello' }), new Response(), {})
  expect(recordUsage).not.toHaveBeenCalled()
  expect(JSON.parse(values.get(RedisKeys.geminiInteraction.record('key-1', 'int-1'))).settlementUnknown).toBe(true)
})

it('keeps native SSE bytes intact while metering after client disconnect', async () => {
  const text =
    `data:${JSON.stringify({ event_type: 'interaction.created', interaction: { id: 'int-1', status: 'in_progress' } })}\r\n\r\n` +
    `data:${JSON.stringify({ event_type: 'step.delta', index: 0, delta: { type: 'text', text: '中文' } })}\n\n` +
    `data:${JSON.stringify({ event_type: 'interaction.completed', interaction: complete })}\n\n`
  const bytes = Buffer.from(text)
  axios.mockResolvedValueOnce({ status: 200, data: Readable.from(Array.from(bytes, (b) => Buffer.from([b]))) })
  const res = new Response()
  res.destroyed = true
  const req = request({ model: 'gemini-test', input: 'hello', stream: true })
  req.rateLimitInfo = {}
  await service.create(req, res, {})
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(recordRateLimit).toHaveBeenCalledWith(expect.any(String), 'key-1', 125, 1)
  expect(res.chunks).toEqual([])
})

it.each([
  { event_type: 'step.stop', index: 0, usage },
  { event_type: 'interaction.status_update', interaction_id: 'int-1', status: 'in_progress', usage },
  { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'answer' }, metadata: { total_usage: usage } }
])(
  'settles stateless streams from cumulative $event_type usage before a partial terminal snapshot',
  async (checkpoint) => {
    const events = [
      { event_type: 'interaction.created', interaction: { id: 'int-1', status: 'in_progress' } },
      checkpoint,
      { event_type: 'interaction.completed', interaction: { id: 'int-1', status: 'completed' } }
    ]
    const text = events.map((event) => `data:${JSON.stringify(event)}\n\n`).join('')
    axios.mockResolvedValueOnce({ status: 200, data: Readable.from([text]) })
    const req = request({ model: 'gemini-test', input: 'hello', stream: true, store: false })
    req._crsRecordRelayResult = jest.fn()
    const res = new Response()
    await service.create(req, res, {})
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0][1]._upstreamUsage).toEqual(usage)
    expect(pending.size).toBe(0)
    expect(Buffer.concat(res.chunks).toString()).toBe(text)
    expect(req._crsRecordRelayResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ statusCode: 200, hasUsage: true, final: true })
    )
  }
)

it('counts generated images without charging input images returned by resource reads', async () => {
  axios.mockResolvedValueOnce({ status: 200, data: { id: 'int-1', status: 'in_progress' } })
  const req = request({ model: 'gemini-test', input: 'hello', background: true })
  await service.create(req, new Response(), {})
  axios.mockResolvedValueOnce({
    status: 200,
    data: {
      ...complete,
      steps: [
        { type: 'user_input', content: [{ type: 'image', data: 'private-input-image' }] },
        { type: 'model_output', content: [{ type: 'image', data: 'private-output-image' }] }
      ]
    }
  })
  req.params.id = 'int-1'
  req.method = 'GET'
  await service.resource(req, new Response(), 'get')
  expect(recordUsage.mock.calls[0][6].billingUsage).toEqual({ image_count: 1 })
  expect(JSON.stringify([...values])).not.toContain('private-')
})

it('counts stream image payloads once across step starts and deltas and ignores placeholders', async () => {
  const events = [
    { event_type: 'interaction.created', interaction: { id: 'int-1', status: 'in_progress' } },
    {
      event_type: 'step.start',
      index: 0,
      step: { type: 'user_input', content: [{ type: 'image', data: 'input-image' }] }
    },
    { event_type: 'step.delta', index: 0, delta: { type: 'image', data: 'input-image' } },
    { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [{ type: 'image' }] } },
    { event_type: 'step.delta', index: 1, delta: { type: 'image' } },
    {
      event_type: 'step.start',
      index: 2,
      step: { type: 'model_output', content: [{ type: 'image', data: 'output-image' }] }
    },
    { event_type: 'step.delta', index: 2, delta: { type: 'image', mime_type: 'image/png', data: 'output-image' } },
    { event_type: 'interaction.completed', interaction: complete }
  ]
  axios.mockResolvedValueOnce({
    status: 200,
    data: Readable.from(events.map((event) => `data:${JSON.stringify(event)}\n\n`))
  })
  await service.create(
    request({ model: 'gemini-test', input: 'hello', stream: true, store: false }),
    new Response(),
    {}
  )
  expect(recordUsage.mock.calls[0][6].billingUsage).toEqual({ image_count: 1 })
  expect(JSON.stringify([...values])).not.toContain('output-image')
})

it.each([
  ['EOF', [], 'upstream_stream_incomplete'],
  ['error', [{ event_type: 'error', error: { code: 'unavailable', message: 'failed' } }], 'upstream_stream_error']
])('retains unknown settlement and records a failed result for stateless stream %s', async (_name, tail, errorCode) => {
  const events = [{ event_type: 'interaction.created', interaction: { id: 'int-1', status: 'in_progress' } }, ...tail]
  axios.mockResolvedValueOnce({
    status: 200,
    data: Readable.from(events.map((event) => `data:${JSON.stringify(event)}\n\n`))
  })
  const req = request({ model: 'gemini-test', input: 'hello', stream: true, store: false })
  req._crsRecordRelayResult = jest.fn()
  const res = new Response()
  await service.create(req, res, {})
  expect(recordUsage).not.toHaveBeenCalled()
  expect(JSON.parse(values.get(RedisKeys.geminiInteraction.record('key-1', 'int-1')))).toMatchObject({
    billed: false,
    settlementUnknown: true
  })
  expect(req._crsRecordRelayResult).toHaveBeenLastCalledWith({
    statusCode: 502,
    errorCode,
    hasUsage: false,
    final: true
  })
  expect(Buffer.concat(res.chunks).toString()).not.toContain('interaction.completed')
})

it('rejects OAuth continuation/state and selects only once for its compatibility path', async () => {
  scheduler.selectAccountForApiKey.mockResolvedValue({ accountId: 'oauth-1', accountType: 'gemini' })
  const generate = jest.fn(async (req, res) => {
    expect(req._crsGeminiSelection.accountId).toBe('oauth-1')
    expect(req.body.contents[0].parts[0].text).toBe('hello')
    res.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] })
  })
  const res = new Response()
  await service.create(request({ model: 'gemini-test', input: 'hello', store: false }), res, { generate })
  expect(res.body.status).toBe('incomplete')
  const blocked = new Response()
  await service.create(request({ model: 'gemini-test', input: 'hello', background: true }), blocked, { generate })
  expect(blocked.statusCode).toBe(400)
  expect(generate).toHaveBeenCalledTimes(1)
  expect(axios).not.toHaveBeenCalled()
})

it('does not append success when the OAuth stream errors or ends early', async () => {
  scheduler.selectAccountForApiKey.mockResolvedValue({ accountId: 'oauth-1', accountType: 'gemini' })
  const res = new Response()
  await service.create(request({ model: 'gemini-test', input: 'hello', stream: true, store: false }), res, {
    stream: async (_req, out) => {
      out.setHeader('Content-Type', 'text/event-stream')
      out.write('data:{"error":{"code":500,"message":"failed"}}\n\n')
      out.end()
    }
  })
  const output = Buffer.concat(res.chunks).toString()
  expect(output).toContain('"event_type":"error"')
  expect(output).not.toContain('interaction.completed')
})

it('rejects prepaid background work before scheduling or sending a request', async () => {
  const req = request({ model: 'gemini-test', input: 'hello', background: true })
  req.apiKey.billingMode = 'prepaid'
  const res = new Response()
  await service.create(req, res, {})
  expect(res.statusCode).toBe(403)
  expect(scheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  expect(axios).not.toHaveBeenCalled()
})

it('records native authentication failures through the shared upstream error path', async () => {
  axios.mockRejectedValueOnce(
    Object.assign(new Error('unauthorized'), {
      response: { status: 401, headers: {}, data: Readable.from(['{"error":{"code":401,"message":"unauthorized"}}']) }
    })
  )
  const res = new Response()
  await service.create(request({ model: 'gemini-test', input: 'hello', stream: true }), res, {})
  expect(markUnavailable).toHaveBeenCalledWith('api-1', 'gemini-api', 401, null, expect.anything())
  expect(recordUsage).not.toHaveBeenCalled()
})

it('builds versioned resource URLs without leaking query API keys', () => {
  expect(buildInteractionUrl('https://example.test/prefix/v1beta/models?key=secret', 'v1', 'a/b', true)).toBe(
    'https://example.test/prefix/v1/interactions/a%2Fb/cancel'
  )
  expect(() => buildInteractionUrl('https://example.test/models/{model}:{action}', 'v1')).toThrow(/template/)
})
