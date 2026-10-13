import { jest } from '@jest/globals'

const key = () => ({ id: 'key', permissions: ['openai'], name: 'fixture' })
const validateWsApiKey = jest.fn()
const acquireWsTurnConcurrency = jest.fn()
const recordUsage = jest.fn()
const captureUnmeteredRequest = jest.fn()
const releases = []
const validateAccount = jest.fn()
const logger = new Proxy({}, { get: () => jest.fn() })
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger }))
jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis: {} }))
jest.unstable_mockModule('../src/common/gateway_ws_api_key_auth.js', () => ({
  validateWsApiKey,
  acquireWsTurnConcurrency
}))
jest.unstable_mockModule('../src/modules/apikey/apikey_service.js', () => ({
  apiKeyService: { recordUsage }
}))
jest.unstable_mockModule('../src/modules/account/account_openai_service.js', () => ({
  updateAccountUsage: jest.fn().mockResolvedValue()
}))
jest.unstable_mockModule('../src/modules/relay/relay_request_detail_service.js', () => ({
  requestDetailService: { captureUnmeteredRequest }
}))
const { createResponsesWsBilling } =
  await import('../src/modules/relay/relay_responses_ws_billing.js')

const makeBilling = () => {
  const billing = createResponsesWsBilling({
    req: { url: '/v1/responses', headers: {}, requestStartedAt: Date.now() },
    apiKeyData: key(),
    validateAccount
  })
  billing.setAccount('account')
  return billing
}
const admit = async (billing, event) => {
  const text = JSON.stringify({ type: 'response.create', model: 'gpt-test', ...event })
  await billing.beforeClientText(text)
  billing.ingestClientText(text)
}
const emit = (billing, type, id, streamId = null, response = {}) =>
  billing.ingestUpstreamText(
    JSON.stringify({
      type,
      ...(streamId ? { stream_id: streamId } : {}),
      response: { id, ...response }
    })
  )

beforeEach(() => {
  jest.clearAllMocks()
  releases.length = 0
  validateWsApiKey.mockResolvedValue({ ok: true, keyData: key() })
  validateAccount.mockResolvedValue()
  acquireWsTurnConcurrency.mockImplementation(async () => {
    const release = jest.fn().mockResolvedValue()
    releases.push(release)
    return { ok: true, release }
  })
  recordUsage.mockResolvedValue({ realCost: 1, ratedCost: 2 })
  captureUnmeteredRequest.mockResolvedValue({ captured: true })
})

describe('Responses WebSocket admission and settlement', () => {
  it('settles interleaved lanes at terminal events and releases each slot before disconnect', async () => {
    const billing = makeBilling()
    expect(acquireWsTurnConcurrency).not.toHaveBeenCalled()
    await admit(billing, { stream_id: 'a', model: 'gpt-a', service_tier: 'priority' })
    await admit(billing, { stream_id: 'b', model: 'gpt-b', service_tier: 'flex' })
    emit(billing, 'response.created', 'a1', 'a')
    emit(billing, 'response.created', 'b1', 'b')
    emit(billing, 'response.incomplete', 'b1', 'b', {
      usage: { input_tokens: 5, output_tokens: 2 },
      incomplete_details: { reason: 'max_output_tokens' }
    })
    emit(billing, 'response.completed', 'a1', 'a', {
      usage: { input_tokens: 20, output_tokens: 1 }
    })
    await billing.flush()
    expect(recordUsage.mock.calls.map((call) => [call[2], call[5]])).toEqual([
      ['gpt-b', 'flex'],
      ['gpt-a', 'priority']
    ])
    expect(recordUsage.mock.calls[0][6]).toMatchObject({
      requestId: 'b1',
      statusCode: 200,
      throwOnBillingFailure: true
    })
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true)
    expect(billing.hasActiveTurns()).toBe(false)
    await billing.close()
    expect(recordUsage).toHaveBeenCalledTimes(2)
  })

  it('rechecks the latest budget before the next round', async () => {
    const billing = makeBilling()
    await admit(billing, {})
    emit(billing, 'response.created', 'one')
    emit(billing, 'response.completed', 'one', null, {
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    await billing.flush()
    validateWsApiKey.mockResolvedValueOnce({
      ok: false,
      status: 402,
      code: 'daily_cost_limit_exceeded',
      message: 'limit'
    })
    await expect(admit(billing, {})).rejects.toMatchObject({ statusCode: 402 })
    expect(acquireWsTurnConcurrency).toHaveBeenCalledTimes(1)
    await billing.close()
  })

  it('warmup consumes no generation slot and no bill', async () => {
    const billing = makeBilling()
    await admit(billing, { generate: false })
    expect(acquireWsTurnConcurrency.mock.calls[0][1].acquireConcurrency).toBe(false)
    emit(billing, 'response.created', 'warm')
    emit(billing, 'response.completed', 'warm', null, {
      usage: { input_tokens: 0, output_tokens: 0 }
    })
    await billing.flush()
    expect(recordUsage).not.toHaveBeenCalled()
    expect(releases[0]).toHaveBeenCalledTimes(1)
    await billing.close()
  })

  it('ignores duplicate terminals and keeps an active lane separate from a rejected queued request', async () => {
    const billing = makeBilling()
    await admit(billing, {})
    emit(billing, 'response.created', 'one')
    await admit(billing, {})
    billing.ingestUpstreamText(
      JSON.stringify({
        type: 'error',
        error: { code: 'invalid_request_error', message: 'bad input' }
      })
    )
    await billing.flush()
    expect(releases[1]).toHaveBeenCalledTimes(1)
    expect(releases[0]).not.toHaveBeenCalled()
    expect(billing.hasActiveTurns()).toBe(true)
    for (let index = 0; index < 2; index += 1) {
      emit(billing, 'response.completed', 'one', null, {
        usage: { input_tokens: 1, output_tokens: 2 }
      })
    }
    await billing.flush()
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(releases[0]).toHaveBeenCalledTimes(1)
    await billing.close()
  })

  it('keeps the slot through steering and settles parent and successor with the inherited tier', async () => {
    const billing = makeBilling()
    await admit(billing, { stream_id: 'lane', service_tier: 'priority' })
    emit(billing, 'response.created', 'parent', 'lane')
    await billing.beforeClientText(
      JSON.stringify({ type: 'response.steer', previous_response_id: 'parent', input: [] })
    )
    emit(billing, 'response.incomplete', 'parent', 'lane', {
      usage: { input_tokens: 2, output_tokens: 1 },
      incomplete_details: { reason: 'steered' }
    })
    emit(billing, 'response.created', 'child', 'lane')
    await billing.flush()
    expect(releases[0]).not.toHaveBeenCalled()
    emit(billing, 'response.completed', 'child', 'lane', {
      usage: { input_tokens: 3, output_tokens: 1 }
    })
    await billing.flush()
    expect(recordUsage.mock.calls.map((call) => call[5])).toEqual(['priority', 'priority'])
    expect(releases[0]).toHaveBeenCalledTimes(1)
    expect(acquireWsTurnConcurrency).toHaveBeenCalledTimes(1)
    await billing.close()
  })

  it('blocks further generation after a critical ledger failure and releases the slot', async () => {
    const billing = makeBilling()
    await admit(billing, {})
    emit(billing, 'response.created', 'one')
    recordUsage.mockRejectedValueOnce(new Error('ledger offline'))
    emit(billing, 'response.completed', 'one', null, {
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    await expect(billing.flush()).rejects.toMatchObject({ code: 'billing_unavailable' })
    await expect(admit(billing, {})).rejects.toMatchObject({ statusCode: 503 })
    expect(releases[0]).toHaveBeenCalledTimes(1)
    await expect(billing.close()).rejects.toMatchObject({ code: 'billing_unavailable' })
  })

  it('releases every unfinished lane even when detail capture fails', async () => {
    const billing = makeBilling()
    await admit(billing, { stream_id: 'a' })
    await admit(billing, { stream_id: 'b' })
    captureUnmeteredRequest.mockRejectedValueOnce(new Error('details offline'))
    await billing.close()
    expect(recordUsage).not.toHaveBeenCalled()
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true)
    expect(captureUnmeteredRequest).toHaveBeenCalledTimes(2)
  })

  it('releases admission acquired concurrently with disconnect', async () => {
    const billing = makeBilling()
    let enter
    const entered = new Promise((resolve) => {
      enter = resolve
    })
    let finish
    validateAccount.mockImplementationOnce(() => {
      enter()
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const admission = admit(billing, {})
    await entered
    await billing.close()
    finish()
    await expect(admission).rejects.toMatchObject({ statusCode: 503 })
    expect(releases[0]).toHaveBeenCalledTimes(1)
  })
})

describe('Responses WebSocket request boundaries', () => {
  it.each(['not JSON', 'null', '[]'])(
    'rejects malformed or batched client messages before admission: %s',
    async (text) => {
      const billing = makeBilling()
      await expect(billing.beforeClientText(text)).rejects.toMatchObject({ statusCode: 400 })
      expect(acquireWsTurnConcurrency).not.toHaveBeenCalled()
      await billing.close()
    }
  )

  it('retains Grok tool and official charges even when token usage is absent', async () => {
    const billing = createResponsesWsBilling({
      req: { url: '/grok/v1/responses', headers: {} },
      apiKeyData: key(),
      accountType: 'grok',
      requiredPermission: 'grok'
    })
    billing.setAccount('account')
    await admit(billing, { model: 'grok-test' })
    emit(billing, 'response.created', 'tools')
    emit(billing, 'response.completed', 'tools', null, {
      usage: { cost_in_usd_ticks: '1', server_side_tool_usage_details: { web_search_calls: 1 } }
    })
    await billing.flush()
    expect(recordUsage.mock.calls[0][1]).toMatchObject({
      cost_in_usd_ticks: '1',
      server_side_tool_usage_details: { web_search_calls: 1 }
    })
    expect(recordUsage.mock.calls[0][6].errorCode).toBe('token_usage_missing')
    await billing.close()
  })
})

it('checks the cached model while an unacknowledged model change may be rejected upstream', async () => {
  const billing = makeBilling()
  await admit(billing, { model: 'gpt-original' })
  emit(billing, 'response.created', 'original')
  emit(billing, 'response.completed', 'original', null, {
    usage: { input_tokens: 1, output_tokens: 1 }
  })
  await billing.flush()
  await admit(billing, { model: 'gpt-other', input: false })
  validateWsApiKey.mockResolvedValueOnce({
    ok: true,
    keyData: { ...key(), enableModelRestriction: true, restrictedModels: ['gpt-original'] }
  })
  await expect(
    billing.beforeClientText(JSON.stringify({ type: 'response.create', input: [] }))
  ).rejects.toMatchObject({ statusCode: 403, code: 'model_not_allowed' })
  expect(acquireWsTurnConcurrency).toHaveBeenCalledTimes(2)
  await billing.close()
})
