import { beforeEach, describe, expect, jest, test } from '@jest/globals'

let settings
let applied
const countLocal = jest.fn(async () => ({ contentTokens: 0, tokenizer: 'openai_o200k_base', scope: 'visible-text' }))
const store = {
  getTokenizerSettings: async () => settings,
  setTokenizerSettings: async (value) => {
    settings = JSON.parse(JSON.stringify(value))
  },
}
await jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis: store }))
await jest.unstable_mockModule('../src/modules/tokenizer/tokenizer_assets.js', () => ({
  getAppliedTokenizerAssets: async () => ({ bundles: applied }),
  loadTokenizerAssets: async () => ({ plan: { bundles: [] } }),
  getTokenizerResourceCatalog: async () => [],
  hashTokenizerFile: jest.fn(),
}))
await jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }))
await jest.unstable_mockModule('../src/modules/tokenizer/tokenizer_count_pool.js', () => ({
  runLocalTokenizer: countLocal,
  tokenizerPoolStatus: () => ({}),
}))
const { chooseTokenizer, saveTokenizerSettings, getTokenizerSettings, countVisibleContent } =
  await import('../src/modules/tokenizer/tokenizer_service.js')
beforeEach(() => {
  settings = { rules: [], enabled: true, disabledTokenizers: [] }
  applied = []
  countLocal.mockClear()
})

describe('model selection and provenance', () => {
  test('unknown aliases have no automatic tokenizer and verified mappings outrank approximate priority', () => {
    expect(chooseTokenizer('gpt-6', []).tokenizer).toBeNull()
    const rules = [
      {
        id: 'approx',
        enabled: true,
        models: ['gpt-*'],
        tokenizer: 'openai_cl100k_base',
        match: 'approximate',
        priority: 999,
      },
      {
        id: 'verified',
        enabled: true,
        models: ['gpt-6'],
        tokenizer: 'openai_o200k_base',
        match: 'verified',
        priority: 0,
      },
    ]
    expect(chooseTokenizer('gpt-6', rules).ruleId).toBe('verified')
    expect(chooseTokenizer('gpt-6', rules, 'claude_ctok').source).toBe('entry-override')
  })

  test('zero counts are retained', async () => {
    expect((await countVisibleContent({ texts: [''], model: 'gpt-4o' })).contentTokens).toBe(0)
  })

  test('global and vocabulary switches bypass the worker, including explicit entry overrides', async () => {
    settings.enabled = false
    expect((await countVisibleContent({ texts: ['hello'], model: 'gpt-4o' })).fallbackReason).toContain('关闭')
    settings.enabled = true
    settings.disabledTokenizers = ['openai_o200k_base']
    expect(
      (await countVisibleContent({ texts: ['hello'], model: 'alias', override: 'openai_o200k_base' })).fallbackReason,
    ).toContain('停用')
    expect(countLocal).not.toHaveBeenCalled()
  })

  test('an applied vocabulary is selected for its declared models and passed to the local worker', async () => {
    applied = [{ id: 'deepseek_v3', revision: 'fixture-v1', models: ['deepseek-v3'], files: [] }]
    const result = await countVisibleContent({ texts: ['hello'], model: 'deepseek-v3' })
    expect(result.source).toBe('applied-vocabulary')
    expect(countLocal).toHaveBeenCalledWith(expect.objectContaining({ tokenizer: 'deepseek_v3', asset: applied[0] }))
  })

  test('unmapped models return visibly marked estimates without guessing a vocabulary', async () => {
    const result = await countVisibleContent({ texts: ['hello'], model: 'unknown-alias' })
    expect(result).toMatchObject({
      estimate: true,
      source: 'char-heuristic',
      precision: 'approximate',
      selection: { tokenizer: null },
    })
    expect(result.fallbackReason).toBeTruthy()
  })
})

test('settings persist global and individual switches and preserve false/zero rule fields', async () => {
  const input = {
    enabled: false,
    disabledTokenizers: ['claude_ctok'],
    rules: [
      {
        id: 'rule1',
        models: ['alias'],
        tokenizer: 'openai_o200k_base',
        match: 'approximate',
        priority: 0,
        enabled: false,
      },
    ],
  }
  const saved = await saveTokenizerSettings(input)
  expect(saved).toEqual(input)
  expect(await getTokenizerSettings()).toEqual(input)
  await expect(saveTokenizerSettings({ ...input, enabled: 'false' })).rejects.toThrow()
  await expect(saveTokenizerSettings({ ...input, disabledTokenizers: ['unknown'] })).rejects.toThrow()
})
