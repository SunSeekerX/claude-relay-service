import { redis } from '../src/infra/redis.js'
import { serviceRatesService } from '../src/modules/payment/payment_service_rates_service.js'
import requestDetailService from '../src/modules/relay/relay_request_detail_service.js'
import { billingEventPublisher } from '../src/modules/payment/payment_billing_event_publisher.js'
import { CostCalculator } from '../src/modules/pricing/pricing_cost_calculator.js'
import { apiKeyService } from '../src/modules/apikey/apikey_service.js'
jest.mock(
  '../config/config',
  () => ({
    security: {
      apiKeyPrefix: 'cr_'
    }
  }),
  { virtual: true }
)

// 捕获挂到 MULTI 上的 hset：generateApiKey/updateApiKey 现在用 getClientSafe().multi() 原子写 hash + 索引
const mockMultiHsetCalls = []
const mockMulti = {
  hset: (...args) => {
    mockMultiHsetCalls.push(args)
    return mockMulti
  },
  hdel: () => mockMulti,
  expire: () => mockMulti,
  zadd: () => mockMulti,
  zrem: () => mockMulti,
  sadd: () => mockMulti,
  srem: () => mockMulti,
  del: () => mockMulti,
  exec: () => Promise.resolve([])
}

jest.mock('../src/infra/redis.js', () => ({
  setApiKey: jest.fn(),
  getApiKey: jest.fn(),
  getClientSafe: jest.fn(() => ({ multi: () => mockMulti })),
  incrementTokenUsage: jest.fn(),
  incrementDailyCost: jest.fn(),
  incrementAccountUsage: jest.fn(),
  addUsageRecord: jest.fn()
}))

jest.mock('../src/modules/pricing/pricing_cost_rank_service.js', () => ({
  addKeyToIndexes: jest.fn()
}))

jest.mock('../src/modules/apikey/apikey_index_service.js', () => ({
  addToIndex: jest.fn(),
  updateIndex: jest.fn()
}))

jest.mock('../src/common/logger.js', () => ({
  success: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  database: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/modules/payment/payment_service_rates_service.js', () => ({
  getService: jest.fn(),
  getServiceRate: jest.fn()
}))
jest.mock('../src/modules/relay/relay_request_detail_service.js', () => ({
  captureRequestDetail: jest.fn()
}))
jest.mock('../src/modules/payment/payment_billing_event_publisher.js', () => ({
  publishBillingEvent: jest.fn()
}))
jest.mock('../src/modules/pricing/pricing_cost_calculator.js', () => ({
  calculateCost: jest.fn()
}))
jest.mock('../src/modules/relay/relay_model_helper.js', () => ({
  isClaudeFamilyModel: jest.fn(() => false)
}))
jest.mock('../src/modules/relay/relay_request_detail_helper.js', () => ({
  finalizeRequestDetailMeta: jest.fn((value) => value)
}))


describe('apiKeyService openai responses config', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMultiHsetCalls.length = 0
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      name: 'Key',
      serviceRates: '{}'
    })
    redis.setApiKey.mockResolvedValue()
    redis.incrementTokenUsage.mockResolvedValue()
    redis.incrementDailyCost.mockResolvedValue()
    redis.incrementAccountUsage.mockResolvedValue()
    redis.addUsageRecord.mockResolvedValue()
    serviceRatesService.getService.mockReturnValue('claude')
    serviceRatesService.getServiceRate.mockResolvedValue(1)
    requestDetailService.captureRequestDetail.mockResolvedValue({ captured: true })
    billingEventPublisher.publishBillingEvent.mockResolvedValue()
  })

  test('generateApiKey stores default toggle values', async () => {
    redis.setApiKey.mockResolvedValue()

    const result = await apiKeyService.generateApiKey({ name: 'Test Key' })
    // hash 写入走原子 MULTI：取 multi.hset(`apikey:{id}`, keyData) 的 keyData
    const storedKeyData = mockMultiHsetCalls.find(
      (c) => typeof c[0] === 'string' && c[0].startsWith('apikey:') && typeof c[1] === 'object'
    )[1]

    expect(storedKeyData.enableOpenAIResponsesCodexAdaptation).toBe('true')
    expect(storedKeyData.enableOpenAIResponsesPayloadRules).toBe('false')
    expect(storedKeyData.openaiResponsesPayloadRules).toBe('[]')

    expect(result.enableOpenAIResponsesCodexAdaptation).toBe(true)
    expect(result.enableOpenAIResponsesPayloadRules).toBe(false)
    expect(result.openaiResponsesPayloadRules).toEqual([])
  })

  test('updateApiKey serializes toggle and payload rule fields', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      apiKey: 'hashed-key',
      name: 'Old Key',
      isActive: 'true',
      tags: '[]'
    })
    redis.setApiKey.mockResolvedValue()

    await apiKeyService.updateApiKey('key-1', {
      enableOpenAIResponsesCodexAdaptation: false,
      enableOpenAIResponsesPayloadRules: true,
      openaiResponsesPayloadRules: [{ path: 'model', valueType: 'string', value: 'gpt-5' }]
    })

    const storedKeyData = mockMultiHsetCalls.find(
      (c) => typeof c[0] === 'string' && c[0].startsWith('apikey:') && typeof c[1] === 'object'
    )[1]
    expect(storedKeyData.enableOpenAIResponsesCodexAdaptation).toBe('false')
    expect(storedKeyData.enableOpenAIResponsesPayloadRules).toBe('true')
    expect(storedKeyData.openaiResponsesPayloadRules).toBe(
      JSON.stringify([{ path: 'model', valueType: 'string', value: 'gpt-5' }])
    )
  })

  test('getApiKeyById returns parsed toggle and rule values', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      name: 'Key',
      apiKey: 'hashed-key',
      tokenLimit: '0',
      isActive: 'true',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastUsedAt: '',
      expiresAt: '',
      userId: '',
      userUsername: '',
      createdBy: 'admin',
      permissions: '[]',
      dailyCostLimit: '0',
      totalCostLimit: '0',
      claudeAccountId: '',
      claudeConsoleAccountId: '',
      geminiAccountId: '',
      openaiAccountId: '',
      bedrockAccountId: '',
      droidAccountId: '',
      azureOpenaiAccountId: '',
      ccrAccountId: '',
      enableOpenAIResponsesCodexAdaptation: 'false',
      enableOpenAIResponsesPayloadRules: 'true',
      openaiResponsesPayloadRules: JSON.stringify([
        { path: 'model', valueType: 'string', value: 'gpt-5' }
      ])
    })

    const result = await apiKeyService.getApiKeyById('key-1')

    expect(result.enableOpenAIResponsesCodexAdaptation).toBe(false)
    expect(result.enableOpenAIResponsesPayloadRules).toBe(true)
    expect(result.openaiResponsesPayloadRules).toEqual([
      { path: 'model', valueType: 'string', value: 'gpt-5' }
    ])
  })

  test('recordUsageWithDetails uses CostCalculator unknown fallback for missing model pricing', async () => {
    CostCalculator.calculateCost.mockReturnValue({
      costs: {
        input: 0.051618,
        output: 0.000765,
        cacheCreate: 0,
        cacheWrite: 0,
        cacheRead: 0.0006144,
        total: 0.0529974
      },
      debug: {
        usedFallbackPricing: true,
        pricingSource: 'unknown-fallback',
        isLongContextRequest: false
      },
      usingDynamicPricing: false
    })

    const result = await apiKeyService.recordUsageWithDetails(
      'key-1',
      {
        input_tokens: 17206,
        output_tokens: 51,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2048
      },
      'mimo-v2.5-pro',
      'acct-1',
      'claude-console',
      {
        requestId: 'req-1',
        endpoint: '/api/v1/messages',
        method: 'POST',
        statusCode: 200
      }
    )

    expect(CostCalculator.calculateCost).toHaveBeenCalledWith(
      {
        input_tokens: 17206,
        output_tokens: 51,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2048
      },
      'mimo-v2.5-pro'
    )
    expect(result.realCost).toBeCloseTo(0.0529974, 10)
    expect(result.ratedCost).toBeCloseTo(0.0529974, 10)
    expect(redis.incrementDailyCost.mock.calls[0][0]).toBe('key-1')
    expect(redis.incrementDailyCost.mock.calls[0][1]).toBeCloseTo(0.0529974, 10)
    expect(redis.incrementDailyCost.mock.calls[0][2]).toBeCloseTo(0.0529974, 10)
    expect(redis.addUsageRecord).toHaveBeenCalledWith(
      'key-1',
      expect.objectContaining({
        model: 'mimo-v2.5-pro',
        cost: 0.052997,
        realCost: 0.052997,
        usedFallbackPricing: true,
        pricingSource: 'unknown-fallback',
        costBreakdown: expect.objectContaining({
          input: 0.051618,
          output: 0.000765,
          cacheRead: 0.0006144,
          total: 0.0529974
        })
      })
    )
    expect(requestDetailService.captureRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        model: 'mimo-v2.5-pro',
        cost: 0.052997,
        realCost: 0.052997,
        usedFallbackPricing: true,
        pricingSource: 'unknown-fallback'
      })
    )
  })
})
