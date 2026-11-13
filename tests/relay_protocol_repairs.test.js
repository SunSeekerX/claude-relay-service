import { describe, expect, test } from '@jest/globals'
import fs from 'node:fs'
import vm from 'node:vm'
import { buildResponsesProviderRequest } from '../src/modules/relay/relay_responses_conversion.js'
import {
  convertClaudeRequestToResponses,
  convertResponsesRequestToClaude,
} from '../src/modules/relay/translator/relay_translator_claude_responses.js'
import { mergeClaudeMessageTurns } from '../src/modules/relay/relay_claude_message_turns.js'
import {
  getClaudeThinkingCapabilities,
  normalizeClaudeRequestForModel,
} from '../src/modules/relay/translator/relay_translator_thinking.js'
import {
  buildTokenUsagePayload,
  normalizeOpenAITokenUsage,
  resolveOpenAIServiceTier,
} from '../src/modules/relay/relay_request_detail_helper.js'
import { buildAzureOpenAIRequest, assertAzureModelAccess } from '../src/modules/relay/relay_azure_openai_request.js'
import { buildBillingAudit } from '../src/modules/pricing/pricing_billing_audit.js'

const sourceMethod = (file, from, to, globals = {}) => {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  if (start < 0 || end < 0) {
    throw new Error('Fixture could not locate production method')
  }
  return new vm.Script(`({${source.slice(start, end)}})`).runInNewContext(globals)
}
const patch = sourceMethod(
  '../src/modules/relay/relay_claude_relay_service.js',
  '  _patchOrphanedToolUse(messages) {',
  '  // 处理请求体',
  {
    mergeClaudeMessageTurns,
    logger: { warn: () => {} },
  },
)._patchOrphanedToolUse

describe('parallel tool turns', () => {
  test('turn merging preserves the latest per-message effort and leaves the input history intact', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a', content: 'a' }],
        output_config: { effort: 'low' },
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'b', content: 'b' }],
        output_config: { effort: 'xhigh' },
      },
    ]
    const result = mergeClaudeMessageTurns(messages)
    expect(result[0].output_config.effort).toBe('xhigh')
    expect(result[0].content).toHaveLength(2)
    expect(messages[0].content).toHaveLength(1)
  })
  test.each([
    ['gateway', (body) => buildResponsesProviderRequest(body, 'claude').request],
    ['registry', convertResponsesRequestToClaude],
  ])('%s never synthesizes errors for complete parallel results', (_name, convert) => {
    const request = convert({
      model: 'claude-fable-5-2',
      input: [
        { type: 'function_call', call_id: 'a', name: 'read_a', arguments: '{}' },
        { type: 'function_call', call_id: 'b', name: 'read_b', arguments: '{}' },
        { type: 'function_call_output', call_id: 'a', output: 'ok a' },
        { type: 'function_call_output', call_id: 'b', output: 'ok b' },
      ],
    })
    const messages = patch(request.messages)
    expect(messages.map((message) => message.role)).toEqual(['assistant', 'user'])
    expect(messages[1].content.map((block) => block.tool_use_id)).toEqual(['a', 'b'])
    expect(messages[1].content.some((block) => block.is_error)).toBe(false)
  })
  test('real missing results still receive one synthetic error after combining the turn', () => {
    const messages = patch([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a' },
          { type: 'tool_use', id: 'b' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] },
    ])
    expect(messages[1].content[0]).toMatchObject({ tool_use_id: 'a', is_error: true })
    expect(messages[1].content[1]).toMatchObject({ tool_use_id: 'b', content: 'ok' })
    expect(messages[1].content[2]).toMatchObject({ type: 'text', text: 'continue' })
  })
})

test('file-backed images fail explicitly and failed tool results retain their meaning', () => {
  expect(() =>
    convertClaudeRequestToResponses({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'private-file' } }] }],
    }),
  ).toThrow(/image source/)
  const result = convertClaudeRequestToResponses({
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'exit 1' }] },
    ],
  })
  expect(result.input[0].output).toContain('is_error=true')
  expect(result.input[0].output).toContain('exit 1')
})

test('new models preserve requested effort before token budget clamping', () => {
  for (const effort of ['high', 'xhigh']) {
    const { request } = buildResponsesProviderRequest(
      { model: 'claude-fable-5-2', input: 'solve', reasoning: { effort } },
      'claude',
    )
    expect(request.thinking).toEqual({ type: 'adaptive' })
    expect(request.output_config.effort).toBe(effort)
  }
  expect(getClaudeThinkingCapabilities('claude-haiku-5-5')).toMatchObject({ adaptiveOnly: false, xhighEffort: true })
  expect(convertClaudeRequestToResponses({ output_config: { effort: 'xhigh' }, messages: [] }).reasoning.effort).toBe(
    'xhigh',
  )
})

test('Haiku 5.5 uses adaptive reasoning while retaining its supported disabled mode', () => {
  const { request } = buildResponsesProviderRequest(
    { model: 'claude-haiku-5-5', input: 'solve', reasoning: { effort: 'high' } },
    'claude',
  )
  expect(request.thinking).toEqual({ type: 'adaptive' })
  expect(request.output_config.effort).toBe('high')
  const disabled = { model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, temperature: 1, top_p: 1, top_k: 1 }
  normalizeClaudeRequestForModel(disabled)
  expect(disabled.thinking.type).toBe('disabled')
  expect(disabled.temperature).toBeUndefined()
  const implicit = { model: 'claude-fable-5-2', temperature: 1, top_p: 1 }
  normalizeClaudeRequestForModel(implicit)
  expect(implicit.temperature).toBeUndefined()
  expect(implicit.top_p).toBeUndefined()
})

test('configuration updates change effective effort and inline audio reaches Gemini media parts', () => {
  const { request } = buildResponsesProviderRequest(
    {
      model: 'claude-fable-5-2',
      input: [
        { role: 'user', content: 'solve' },
        { type: 'configuration_update', reasoning: { effort: 'xhigh' } },
      ],
    },
    'claude',
  )
  expect(request.output_config.effort).toBe('xhigh')
  const gemini = buildResponsesProviderRequest(
    {
      model: 'gemini-3.8-pro',
      input: [{ role: 'user', content: [{ type: 'input_audio', audio_url: 'data:audio/wav;base64,AQID' }] }],
    },
    'gemini',
  ).request
  expect(gemini.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'audio/wav', data: 'AQID' } })
  expect(() =>
    buildResponsesProviderRequest(
      { input: [{ role: 'user', content: [{ type: 'input_audio', file_id: 'private' }] }] },
      'gemini',
    ),
  ).toThrow(/audio IDs/)
})

test('Droid partitions OpenAI input exactly once and retains Anthropic additive caches', () => {
  const service = sourceMethod(
    '../src/modules/relay/relay_droid_relay_service.js',
    '  _normalizeUsageSnapshot(',
    '  /**\n   * 计算 usage',
    { buildTokenUsagePayload, normalizeOpenAITokenUsage },
  )
  const raw = {
    input_tokens: 10000,
    output_tokens: 100,
    input_tokens_details: { cached_tokens: 8000 },
    output_tokens_details: { reasoning_tokens: 20 },
  }
  expect(service._normalizeUsageSnapshot(raw, 'openai')).toMatchObject({
    input_tokens: 2000,
    cache_read_input_tokens: 8000,
    output_tokens: 100,
    reasoning_tokens: 20,
    reasoning_included_in_output: true,
    _upstreamUsage: { input_tokens: 10000 },
  })
  expect(
    service._normalizeUsageSnapshot(
      { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 8000 },
      'anthropic',
    ),
  ).toMatchObject({ input_tokens: 2000, cache_read_input_tokens: 8000 })
})

test('Azure v1 and deployment modes use their own URL and authentication contracts', () => {
  const account = {
    azureEndpoint: 'https://resource.openai.azure.com/',
    deploymentName: 'deployment',
    apiKey: 'fixture',
  }
  expect(buildAzureOpenAIRequest(account, 'chat/completions', { model: 'azure/gpt-test' }).url).toContain(
    '/openai/deployments/deployment/chat/completions?api-version=',
  )
  const request = buildAzureOpenAIRequest({ ...account, apiMode: 'v1', authType: 'entra' }, 'responses', {
    model: 'gpt-test',
  })
  expect(request.url).toBe('https://resource.openai.azure.com/openai/v1/responses')
  expect(request.headers.Authorization).toBe('Bearer fixture')
  expect(request.body.model).toBe('deployment')
})

test('Azure checks both the public model and final deployment against key restrictions', () => {
  const key = { enableModelRestriction: true, restrictedModels: ['gpt-6-sol'] }
  expect(() => assertAzureModelAccess(key, 'azure/gpt-6-sol', { deploymentName: 'custom' })).toThrow(/not allowed/)
  expect(() => assertAzureModelAccess(key, 'gpt-4', { deploymentName: 'gpt-6-sol' })).toThrow(/not allowed/)
  expect(() => assertAzureModelAccess(key, 'gpt-4', { deploymentName: 'custom' })).not.toThrow()
})

test.each(['gemini-3.8-pro', 'gemini-2.5-pro'])('Claude tool images remain model-visible on %s', (model) => {
  const source = fs.readFileSync(
    new URL('../src/modules/relay/relay_anthropic_gemini_bridge_service.js', import.meta.url),
    'utf8',
  )
  const section = (name) => {
    const start = source.indexOf(`const ${name} =`)
    return source.slice(start, source.indexOf('/**', start))
  }
  const convert = new vm.Script(
    `${section('normalizeToolResultContent')}\n${section('convertAnthropicMessagesToGeminiContents')}\nconvertAnthropicMessagesToGeminiContents`,
  ).runInNewContext({ MAX_ANTIGRAVITY_TOOL_RESULT_CHARS: 200000 })
  const messages = [
    {
      role: 'user',
      content: ['a', 'b'].map((id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }],
      })),
    },
  ]
  for (const vendor of ['antigravity', 'gemini-cli']) {
    const [content] = convert(
      messages,
      new Map([
        ['a', 'screenshot'],
        ['b', 'screenshot'],
      ]),
      { vendor, model },
    )
    if (model.startsWith('gemini-3')) {
      expect(content.parts.map((part) => part.functionResponse.parts[0].inlineData.data)).toEqual(['AQID', 'AQID'])
    } else {
      expect(content.parts.slice(0, 2).map((part) => part.functionResponse.id)).toEqual(['a', 'b'])
      expect(content.parts.slice(2).map((part) => part.inlineData.data)).toEqual(['AQID', 'AQID'])
    }
  }
})

test('Azure denies a Claude-only key before account selection', () => {
  const source = fs.readFileSync(new URL('../src/modules/relay/relay_azure_openai_routes.js', import.meta.url), 'utf8')
  const authorize = new vm.Script(
    `${source.slice(source.indexOf('const authorizeAzureOpenAI'), source.indexOf('// 支持的模型'))}\nauthorizeAzureOpenAI`,
  ).runInNewContext({ apiKeyService: { hasPermission: (permissions, service) => permissions.includes(service) } })
  let called = false
  const res = {
    status(code) {
      this.code = code
      return this
    },
    json(body) {
      this.body = body
    },
  }
  authorize({ apiKey: { permissions: ['claude'] } }, res, () => {
    called = true
  })
  expect(res.code).toBe(403)
  expect(called).toBe(false)
})

test('Azure reports disjoint cache buckets, original usage, tier and one correct account total', async () => {
  let recorded
  let accountTotal
  const reporter = sourceMethod(
    '../src/modules/relay/relay_azure_openai_routes.js',
    '  async _performReport(',
    '\n}\n\nconst usageReporter',
    {
      buildTokenUsagePayload,
      normalizeOpenAITokenUsage,
      resolveOpenAIServiceTier,
      apiKeyService: {
        recordUsage: async (...args) => {
          recorded = args
        },
      },
      azureOpenaiAccountService: {
        updateAccountUsage: async (_id, total) => {
          accountTotal = total
        },
      },
      logger: new Proxy({}, { get: () => () => {} }),
    },
  )
  const usage = {
    prompt_tokens: 10000,
    completion_tokens: 100,
    service_tier: 'priority',
    prompt_tokens_details: {
      cached_tokens: 8000,
      cache_write_tokens: 1000,
      cache_write_tokens_details: { ttl_30m_tokens: 600, ttl_12h_tokens: 400 },
    },
  }
  expect(await reporter._performReport('fixture', usage, 'key', 'gpt-test', 'account')).toBe(true)
  expect(recorded[1]).toMatchObject({
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_input_tokens: 8000,
    cache_creation_input_tokens: 1000,
    cache_write_tokens_details: { ttl_30m_tokens: 600, ttl_12h_tokens: 400 },
    _upstreamUsage: { prompt_tokens: 10000 },
  })
  expect(recorded[5]).toBe('priority')
  expect(accountTotal).toBe(10100)
})

test('Azure hard gates apply to bound, shared and session candidates regardless of auto protection', async () => {
  const source = fs.readFileSync(
    new URL('../src/modules/account/account_azure_openai_service.js', import.meta.url),
    'utf8',
  )
  const start = source.indexOf('export const _isAccountAvailable')
  const end = source.indexOf('export const selectAvailableAccount', start)
  let account = {
    id: 'account',
    isActive: 'true',
    schedulable: 'true',
    supportedModels: ['gpt-test'],
    disableAutoProtection: 'true',
  }
  const available = new vm.Script(
    `${source.slice(start, end).replace('export ', '')}\n_isAccountAvailable`,
  ).runInNewContext({
    getAccount: async () => account,
    isSubscriptionExpired: (value) => value.expired,
    upstreamErrorHelper: { isTempUnavailable: async () => true },
  })
  expect(await available('account', 'azure-openai', 'gpt-test')).toBe(true)
  for (const change of [{ schedulable: 'false' }, { isActive: 'false' }, { expired: true }]) {
    const previous = account
    account = { ...account, ...change }
    expect(await available('account', 'azure-openai', 'gpt-test')).toBe(false)
    account = previous
  }
  expect(await available('account', 'azure-openai', 'other')).toBe(false)
})

test('Claude 1h unit price reaches the independent billing snapshot', () => {
  const source = fs.readFileSync(new URL('../src/modules/pricing/pricing_cost_calculator.js', import.meta.url), 'utf8')
  const start = source.indexOf('  static buildDetailedPricingResult(')
  const end = source.indexOf('  static buildLegacyCostResult(', start)
  const calculator = new vm.Script(`({${source.slice(start, end).replace('static ', '')}})`).runInNewContext()
  calculator.formatCost = String
  calculator.isOpenAIModel = () => false
  const result = calculator.buildDetailedPricingResult({}, 'claude-test', {
    pricing: { input: 3e-6, output: 15e-6, cacheCreate: 3.75e-6, cacheRead: 0.3e-6, ephemeral1h: 6e-6 },
    totalCost: 0,
  })
  const audit = buildBillingAudit({ model: 'claude-test', pricing: result.pricing })
  expect(audit.pricingSnapshot).toMatchObject({ cacheWrite: 3.75, cacheWrite1h: 6 })
})
