import { beforeEach, expect, jest, test } from '@jest/globals'
import { EventEmitter } from 'node:events'

const network = jest.fn()
const markUnavailable = jest.fn()
const group = { id: 'g', modelWhitelist: ['public-fast', 'account-fast'] }
const account = { id: 'a', supportedModels: { 'account-fast': 'banned-target' } }
const accountService = {
  getAccount: async () => account,
  getMappedModel: (mapping, model) => mapping[model] ?? model,
}
const mocks = {
  axios: { default: network },
  '../src/infra/redis.js': { redis: { getClientSafe: () => ({}), getAllIdsByIndex: async () => ['a'], batchGetChunked: async () => [JSON.stringify({ id: 'a', name: 'Bedrock', supportedModels: ['claude-a'] })] } },
  '../config/config.js': { config: { system: {}, security: { encryptionKey: 'test-fixture-only' } } },
  '../src/modules/webhook/webhook_notifier.js': { webhookNotifier: {} },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: {} },
  '../src/modules/relay/relay_request_detail_service.js': { requestDetailService: {} },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/modules/account/account_claude_console_service.js': { claudeConsoleAccountService: accountService },
  '../src/modules/account/account_openai_responses_service.js': { openaiResponsesAccountService: accountService },
  '../src/modules/relay/relay_unified_openai_scheduler.js': { unifiedOpenAIScheduler: {} },
  '../src/modules/account/account_ccr_service.js': { ccrAccountService: accountService },
  '../src/modules/account/account_group_service.js': { accountGroupService: { getGroup: async () => group } },
  '../src/modules/account/account_group_policy.js': { extractBoundGroupIdForAccountType: () => null },
  '../src/modules/user/user_message_queue_service.js': { userMessageQueueService: { isUserMessageRequest: () => false } },
  '../src/modules/proxy/proxy_resolver.js': { proxyResolver: { report: jest.fn() } },
  '../src/modules/relay/relay_upstream_error_helper.js': { markTempUnavailable: markUnavailable },
}
for (const [module, exports] of Object.entries(mocks)) {
  await jest.unstable_mockModule(module, () => exports)
}
const { claudeConsoleRelayService } = await import('../src/modules/relay/relay_claude_console_relay_service.js')
const { ccrRelayService } = await import('../src/modules/relay/relay_ccr_relay_service.js')
const { bedrockRelayService } = await import('../src/modules/relay/relay_bedrock_relay_service.js')
const { applyRouteModel } = await import('../src/modules/relay/relay_route_model.js')

beforeEach(() => jest.clearAllMocks())

test.each([
  ['Console', claudeConsoleRelayService],
  ['CCR', ccrRelayService],
])('%s rejects a forbidden nested mapping before any upstream request', async (_name, service) => {
  for (const restrictedBy of ['key', 'group']) {
    const route = { echoModel: 'upstream', binding: restrictedBy === 'group' ? 'group:g' : 'a', modelMapping: { 'public-fast': 'account-fast' } }
    const key = { id: 'key', _relayRoute: route, enableModelRestriction: restrictedBy === 'key', restrictedModels: ['banned-target'] }
    const req = { body: { model: 'public-fast' }, apiKey: key }
    applyRouteModel(req, { setHeader: () => {} }, route)
    expect(req.body.model).toBe('account-fast')
    await expect(service.relayRequest(req.body, key, null, null, {}, account.id)).rejects.toMatchObject({ statusCode: 403, code: 'model_not_allowed' })
    await expect(service.relayStreamRequestWithUsageCapture(req.body, key, null, {}, null, account.id)).rejects.toMatchObject({ statusCode: 403, code: 'model_not_allowed' })
  }
  expect(network).not.toHaveBeenCalled()
  expect(markUnavailable).not.toHaveBeenCalled()
})

test('Bedrock uses an explicit requested model and applies account default only when omitted', () => {
  const options = { id: 'a', defaultModel: 'us.anthropic.claude-default-v1:0' }
  expect(bedrockRelayService._selectModel({ model: 'us.anthropic.claude-selected-v1:0' }, options)).toBe('us.anthropic.claude-selected-v1:0')
  expect(bedrockRelayService._selectModel({}, options)).toBe(options.defaultModel)
})

test('Bedrock rejects a disallowed default before client creation and network access', async () => {
  const client = jest.spyOn(bedrockRelayService, '_getBedrockClient')
  try {
    await expect(bedrockRelayService.handleNonStreamRequest({}, { id: 'a', supportedModels: ['allowed'], defaultModel: 'blocked' })).rejects.toMatchObject({ statusCode: 403 })
    expect(client).not.toHaveBeenCalled()
  } finally {
    client.mockRestore()
  }
})

const { openaiResponsesRelayService } = await import('../src/modules/relay/relay_openai_responses_relay_service.js')
test('OpenAI Responses rejects a nested mapped model with HTTP 403 and does not call upstream', async () => {
  const res = new EventEmitter()
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (body) => { res.body = body; return res }
  const key = { id: 'key', enableModelRestriction: true, restrictedModels: ['banned-target'] }
  await openaiResponsesRelayService.handleRequest({ headers: {}, path: '/v1/responses', body: { model: 'account-fast', input: 'test' } }, res, account, key)
  expect(res.statusCode).toBe(403)
  expect(network).not.toHaveBeenCalled()
})
jest.useFakeTimers()
const { bedrockAccountService } = await import('../src/modules/account/account_bedrock_service.js')
jest.clearAllTimers()
jest.useRealTimers()
test('Bedrock shared-pool account summaries retain model restrictions', async () => {
  expect(await bedrockAccountService.getAllAccounts()).toMatchObject({ success: true, data: [{ id: 'a', supportedModels: ['claude-a'] }] })
})
