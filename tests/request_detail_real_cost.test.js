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
      exec: async () => []
    }
    return chain
  }
}
const modules = {
  '../src/infra/redis.js': {
    redis: { getClient: () => client, getApiKey: async () => ({ name: 'key' }) }
  },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/modules/relay/relay_claude_relay_config_service.js': {
    claudeRelayConfigService: {
      getConfig: async () => ({
        requestDetailCaptureEnabled: true,
        requestDetailRetentionHours: 6,
        requestDetailBodyPreviewEnabled: false
      })
    }
  },
  '../src/modules/pricing/pricing_cost_calculator.js': { CostCalculator: { calculateCost } },
  '../src/modules/account/account_claude_service.js': { claudeAccountService: {} },
  '../src/modules/account/account_claude_console_service.js': { claudeConsoleAccountService: {} },
  '../src/modules/account/account_ccr_service.js': { ccrAccountService: {} },
  '../src/modules/account/account_gemini_service.js': {},
  '../src/modules/account/account_gemini_api_service.js': { geminiApiAccountService: {} },
  '../src/modules/account/account_openai_service.js': {},
  '../src/modules/account/account_openai_responses_service.js': {
    openaiResponsesAccountService: {}
  },
  '../src/modules/account/account_azure_openai_service.js': {},
  '../src/modules/account/account_droid_service.js': { droidAccountService: {} },
  '../src/modules/account/account_bedrock_service.js': { bedrockAccountService: {} }
}
for (const [name, exports] of Object.entries(modules)) {
  jest.unstable_mockModule(name, () => exports)
}
const { requestDetailService } =
  await import('../src/modules/relay/relay_request_detail_service.js')

beforeEach(() => {
  stored.clear()
  jest.clearAllMocks()
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
      totalTokens: 10
    })
    const saved = JSON.parse(stored.get('request_detail:item:fixture'))
    expect(saved.realCost).toBe(realCost)
    const result = await requestDetailService.getRequestDetail('fixture')
    expect(result.record.realCost).toBe(realCost)
    expect(result.record.cost).toBe(0)
    expect(calculateCost).not.toHaveBeenCalled()
  }
)
