import { jest } from '@jest/globals'
const stored = new Map()
const calculateCost = jest.fn(() => ({ costs: { total: 2 } }))
const client = {
  get: jest.fn(async (key) => stored.get(key)),
  multi: () => {
    const chain = {
      set: (key, value) => {
        stored.set(key, value)
        return chain
      },
      zadd: () => chain,
      expire: () => chain,
      exec: async () => [],
    }
    return chain
  },
}
const modules = {
  '../src/infra/redis.js': {
    redis: { getClient: () => client, getApiKey: async () => ({ name: 'key' }) },
  },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/modules/relay/relay_claude_relay_config_service.js': {
    claudeRelayConfigService: {
      getConfig: async () => ({
        requestDetailCaptureEnabled: true,
        requestDetailRetentionHours: 6,
        requestDetailBodyPreviewEnabled: false,
      }),
    },
  },
  '../src/modules/pricing/pricing_cost_calculator.js': { CostCalculator: { calculateCost } },
  '../src/modules/account/account_claude_service.js': { claudeAccountService: {} },
  '../src/modules/account/account_claude_console_service.js': { claudeConsoleAccountService: {} },
  '../src/modules/account/account_ccr_service.js': { ccrAccountService: {} },
  '../src/modules/account/account_gemini_service.js': {},
  '../src/modules/account/account_gemini_api_service.js': { geminiApiAccountService: {} },
  '../src/modules/account/account_openai_service.js': {},
  '../src/modules/account/account_openai_responses_service.js': {
    openaiResponsesAccountService: {},
  },
  '../src/modules/account/account_azure_openai_service.js': {},
  '../src/modules/account/account_droid_service.js': { droidAccountService: {} },
  '../src/modules/account/account_bedrock_service.js': { bedrockAccountService: {} },
}
for (const [name, exports] of Object.entries(modules)) {
  jest.unstable_mockModule(name, () => exports)
}
const { requestDetailService } = await import('../src/modules/relay/relay_request_detail_service.js')

beforeEach(() => {
  stored.clear()
  jest.clearAllMocks()
})

it('keeps numeric billing evidence when body previews are disabled', async () => {
  const billingAudit = {
    schemaVersion: 1,
    model: 'm',
    upstreamUsage: { input_tokens: 100, output_tokens: 5 },
    pricingSnapshot: { input: 2, output: 8 },
    baseCost: 0.1,
    realCost: 0.1,
    ratedCost: 0.2,
  }
  await requestDetailService.captureRequestDetail({
    requestId: 'audit',
    model: 'm',
    cost: 0.2,
    realCost: 0.1,
    billingAudit,
    requestBody: { input: 'private prompt' },
  })
  const saved = JSON.parse(stored.get('request_detail:item:audit'))
  expect(saved.billingAudit).toEqual(billingAudit)
  expect(saved.requestBodySnapshot).toBeUndefined()
  expect(JSON.stringify(saved)).not.toContain('private prompt')
})

it.each([0, 1e-10, 0.00001585])(
  'retains exact upstream cost %s through storage and display lookup',
  async (realCost) => {
    await requestDetailService.captureRequestDetail({
      requestId: 'fixture',
      timestamp: new Date().toISOString(),
      endpoint: '/grok/responses',
      accountType: 'grok',
      model: 'grok-test',
      cost: 0,
      realCost,
      realCostSource: 'upstream',
      upstreamCostTicks: String(Math.round(realCost * 1e10)),
      inputTokens: 10,
      totalTokens: 10,
    })
    const saved = JSON.parse(stored.get('request_detail:item:fixture'))
    expect(saved.realCost).toBe(realCost)
    const result = await requestDetailService.getRequestDetail('fixture')
    expect(result.record.realCost).toBe(realCost)
    expect(result.record.cost).toBe(0)
    expect(calculateCost).not.toHaveBeenCalled()
  },
)

it('stores timing zeros and leaves unavailable timing fields null', async () => {
  await requestDetailService.captureRequestDetail({
    requestId: 'timed',
    timestamp: new Date().toISOString(),
    model: 'fixture',
    durationMs: 30,
    firstTokenMs: 20,
    timings: {
      authenticationMs: 0,
      schedulingMs: 3,
      upstreamHeadersMs: 12,
      firstContentWaitMs: 8,
      upstreamAttempts: 1,
    },
  })
  const saved = JSON.parse(stored.get('request_detail:item:timed'))
  expect(saved.timings).toMatchObject({
    authenticationMs: 0,
    schedulingMs: 3,
    upstreamHeadersMs: 12,
    upstreamResponseMs: null,
    firstContentWaitMs: 8,
    upstreamAttempts: 1,
  })
  const result = await requestDetailService.getRequestDetail('timed')
  expect(result.record.timings).toEqual(saved.timings)
})

it('keeps a historical explicit zero amount without repricing it on read', async () => {
  await requestDetailService.captureRequestDetail({
    requestId: 'historical-zero',
    timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    model: 'fixture',
    inputTokens: 100,
    totalTokens: 100,
    cost: 0,
    realCost: 0,
  })
  const before = stored.get('request_detail:item:historical-zero')
  const result = await requestDetailService.getRequestDetail('historical-zero')
  expect(result.record).toMatchObject({ cost: 0, realCost: 0, costRecomputed: false })
  expect(stored.get('request_detail:item:historical-zero')).toBe(before)
  expect(calculateCost).not.toHaveBeenCalled()
})
