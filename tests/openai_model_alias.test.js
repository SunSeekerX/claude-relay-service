import {
  canonicalizeOpenAIModelAliasSpelling,
  isOpenAIGPT6AstraModel,
  normalizeKnownOpenAICodexModel,
  applyOpenAIPublicModelAlias,
  collectOpenAIModelSelectCandidates,
} from '../src/modules/relay/relay_openai_model_alias.js'

describe('relay_openai_model_alias', () => {
  test('canonicalize spelling', () => {
    expect(canonicalizeOpenAIModelAliasSpelling('GPT-6-Astra')).toBe('gpt-6-astra')
    expect(canonicalizeOpenAIModelAliasSpelling('openai/gpt-6')).toBe('gpt-6')
  })

  test('gpt-6 family maps to astra', () => {
    expect(isOpenAIGPT6AstraModel('gpt-6')).toBe(true)
    expect(isOpenAIGPT6AstraModel('gpt-6-astra')).toBe(true)
    expect(normalizeKnownOpenAICodexModel('gpt-6')).toBe('gpt-6-astra')
    expect(normalizeKnownOpenAICodexModel('gpt-5.6')).toBe('gpt-5.6-sol')
  })

  test('applyOpenAIPublicModelAlias rewrites body.model', () => {
    const body = { model: 'gpt-6' }
    applyOpenAIPublicModelAlias(body)
    expect(body.model).toBe('gpt-6-astra')
  })


  test('applyOpenAIPublicModelAlias does not override account mapping', () => {
    const body = { model: 'deployment-astra' }
    applyOpenAIPublicModelAlias(body, { originalModel: 'gpt-6', mapped: true })
    expect(body.model).toBe('deployment-astra')
    applyOpenAIPublicModelAlias(body, { originalModel: 'gpt-6' })
    expect(body.model).toBe('deployment-astra')
  })

  test('collectOpenAIModelSelectCandidates includes public alias', () => {
    expect(collectOpenAIModelSelectCandidates('gpt-6')).toEqual(['gpt-6', 'gpt-6-astra'])
  })
})
