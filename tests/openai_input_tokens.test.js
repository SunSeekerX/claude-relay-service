import { beforeEach, expect, jest, test } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const upstream = jest.fn()
const selectAccount = jest.fn()
const getAccount = jest.fn()
const assertAccess = jest.fn()
const countLocal = jest.fn()
const recordUsage = jest.fn()
const updateQuota = jest.fn()
const logger = { error: jest.fn(), info: jest.fn() }
await jest.unstable_mockModule('axios', () => ({ default: upstream }))
await jest.unstable_mockModule('../src/common/logger.js', () => ({ logger }))
await jest.unstable_mockModule('../src/common/request_timing.js', () => ({
  timedUpstreamRequest: async (_req, operation) => operation(),
}))
await jest.unstable_mockModule('../src/common/common_helper.js', () => ({
  getMappedModelName: (mapping, model) => mapping?.[model] ?? model,
}))
await jest.unstable_mockModule('../src/modules/apikey/apikey_service.js', () => ({
  apiKeyService: { hasPermission: (permissions, service) => permissions.includes(service), recordUsage },
}))
await jest.unstable_mockModule('../src/modules/account/account_openai_responses_service.js', () => ({
  openaiResponsesAccountService: { getAccount, updateUsageQuota: updateQuota },
}))
await jest.unstable_mockModule('../src/modules/relay/relay_unified_openai_scheduler.js', () => ({
  unifiedOpenAIScheduler: { selectAccountForApiKey: selectAccount },
}))
await jest.unstable_mockModule('../src/modules/relay/relay_model_access.js', () => ({
  assertOutboundModelAccess: assertAccess,
}))
await jest.unstable_mockModule('../src/modules/proxy/proxy_resolver.js', () => ({
  proxyResolver: { resolveAgent: () => ({ agent: null }) },
}))
await jest.unstable_mockModule('../src/modules/tokenizer/tokenizer_service.js', () => ({
  countVisibleContent: countLocal,
}))
const { handleResponsesInputTokens } = await import('../src/modules/relay/relay_openai_input_tokens.js')
const { getRequestRouteFormat } = await import('../src/modules/relay/relay_routing_contract.js')
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.apiKey = { id: 'fixture-key', permissions: req.get('fixture-permission') === 'denied' ? [] : ['openai'] }
  next()
})
app.post('/v1/responses/input_tokens', handleResponsesInputTokens)
const body = {
  model: 'fixture-model',
  instructions: 'Be brief',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
}

beforeEach(() => {
  jest.clearAllMocks()
  selectAccount.mockResolvedValue({ accountId: 'fixture-account', accountType: 'openai-responses' })
  getAccount.mockResolvedValue({
    id: 'fixture-account',
    apiKey: 'fixture-secret',
    baseApi: 'https://upstream.invalid/v1/',
    supportedModels: { 'fixture-model': 'fixture-mapped' },
  })
  assertAccess.mockResolvedValue(undefined)
  upstream.mockResolvedValue({ status: 200, data: { object: 'response.input_tokens', input_tokens: 123 } })
  countLocal.mockResolvedValue({
    contentTokens: 9,
    source: 'node-vocabulary',
    precision: 'official-text',
    selection: { tokenizer: 'fixture-tokenizer' },
    missing: ['protocol-framing', 'hidden-content'],
  })
})

test('native counts preserve official response and mapping without generating, billing, quota or cost-hold admission', async () => {
  const result = await request(app).post('/v1/responses/input_tokens').send(body).expect(200)
  expect(result.body).toEqual({ object: 'response.input_tokens', input_tokens: 123 })
  expect(result.headers['x-token-count-source']).toBe('upstream')
  expect(selectAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'fixture-key' }), null, 'fixture-model', {
    deferGroupAdmission: true,
  })
  expect(upstream).toHaveBeenCalledWith(
    expect.objectContaining({
      url: 'https://upstream.invalid/v1/responses/input_tokens',
      method: 'POST',
      data: { ...body, model: 'fixture-mapped' },
      maxContentLength: 1048576,
    }),
  )
  expect(assertAccess).toHaveBeenCalledWith(expect.anything(), 'fixture-mapped', 'openai-responses')
  expect(recordUsage).not.toHaveBeenCalled()
  expect(updateQuota).not.toHaveBeenCalled()
  expect(countLocal).not.toHaveBeenCalled()
  expect(getRequestRouteFormat({ method: 'POST', path: '/r/test/v1/responses/input_tokens' })).toBe('openai-responses')
})

test.each([404, 405, 501])('unsupported upstream %s returns explicit local estimate and provenance', async (status) => {
  upstream.mockResolvedValue({ status, data: { error: { code: 'not_found' } } })
  const result = await request(app).post('/v1/responses/input_tokens').send(body).expect(200)
  expect(result.body).toMatchObject({
    object: 'response.input_tokens',
    input_tokens: 9,
    _crs_estimate: true,
    _crs_estimate_method: 'node-vocabulary',
    _crs_scope: 'visible-text',
  })
  expect(result.headers['x-token-count-estimated']).toBe('true')
  expect(countLocal.mock.calls[0][0]).toMatchObject({ texts: ['Be brief', 'Hello'], model: 'fixture-mapped' })
  expect(recordUsage).not.toHaveBeenCalled()
})

test('OAuth counts are explicitly estimated without inventing an unsupported OAuth upstream path', async () => {
  selectAccount.mockResolvedValue({ accountId: 'oauth-account', accountType: 'openai' })
  const result = await request(app).post('/v1/responses/input_tokens').send(body).expect(200)
  expect(result.body._crs_estimate).toBe(true)
  expect(result.body._crs_fallback_reason).toBe('oauth_count_endpoint_unavailable')
  expect(upstream).not.toHaveBeenCalled()
})

test.each([
  { previous_response_id: 'response-1' },
  { conversation: { id: 'remote' } },
  { prompt: { id: 'remote' } },
  { tools: [{ type: 'mcp', server_label: 'remote', server_url: 'https://remote.invalid/mcp' }] },
  { input: [{ type: 'input_file', file_id: 'file-1' }] },
  { input: [{ type: 'input_image', image_url: 'https://remote.invalid/image' }] },
  { input: [{ type: 'reasoning', encrypted_content: 'ciphertext' }] },
])('local fallback refuses unresolved server state or media: %j', async (extra) => {
  upstream.mockResolvedValue({ status: 404, data: {} })
  await request(app)
    .post('/v1/responses/input_tokens')
    .send({ ...body, ...extra })
    .expect(422)
  expect(countLocal).not.toHaveBeenCalled()
})

test.each([401, 403, 429, 500])('upstream %s does not turn into an estimated success', async (status) => {
  upstream.mockResolvedValue({ status, data: { error: { code: 'upstream_failure', message: 'internal' } } })
  const result = await request(app).post('/v1/responses/input_tokens').send(body)
  expect(result.status).toBeGreaterThanOrEqual(400)
  expect(countLocal).not.toHaveBeenCalled()
})

test('model-not-found, bad native responses, transport errors and permission failures remain errors', async () => {
  upstream.mockResolvedValueOnce({ status: 404, data: { error: { code: 'model_not_found' } } })
  await request(app).post('/v1/responses/input_tokens').send(body).expect(404)
  upstream.mockResolvedValueOnce({ status: 200, data: '<html>not a count</html>' })
  await request(app).post('/v1/responses/input_tokens').send(body).expect(502)
  upstream.mockRejectedValueOnce(new Error('network unavailable'))
  await request(app).post('/v1/responses/input_tokens').send(body).expect(502)
  await request(app).post('/v1/responses/input_tokens').set('fixture-permission', 'denied').send(body).expect(403)
  assertAccess.mockRejectedValueOnce(Object.assign(new Error('restricted model'), { statusCode: 403 }))
  await request(app).post('/v1/responses/input_tokens').send(body).expect(403)
  expect(countLocal).not.toHaveBeenCalled()
})

test('native upstream can resolve remote history and files without rejecting them as local-only input', async () => {
  await request(app)
    .post('/v1/responses/input_tokens')
    .send({ ...body, previous_response_id: 'server-history', input: [{ type: 'input_file', file_id: 'server-file' }] })
    .expect(200)
  expect(upstream.mock.calls[0][0].data.previous_response_id).toBe('server-history')
  expect(countLocal).not.toHaveBeenCalled()
})
