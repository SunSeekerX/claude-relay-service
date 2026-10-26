import crypto from 'node:crypto'
import path from 'node:path'
import { redis } from '../../infra/redis.js'
import { LIMITS } from '../../infra/redis_key.js'
import { tokenizerConfig } from '../../../config/tokenizers.js'
import { badRequest } from '../../common/http_result.js'
import { logger } from '../../common/logger.js'
import { ctokModelCoverage, ctokVocabularyHash, ctokVersion } from './tokenizer_ctok.js'
import {
  getTokenizerResourceCatalog,
  hashTokenizerFile,
  loadTokenizerAssets,
  getAppliedTokenizerAssets,
} from './tokenizer_assets.js'
import { runLocalTokenizer, tokenizerPoolStatus } from './tokenizer_count_pool.js'
import { extractCountTexts, estimateVisibleTokens } from './tokenizer_text.js'
import { loadBpeDefinition, tokenizerForOpenaiModel, openaiModelMappings } from './tokenizer_bpe.js'

const portableIds = ['claude_ctok', 'openai_o200k_base', 'openai_cl100k_base']
export const isKnownTokenizer = async (id) => {
  const { plan } = await loadTokenizerAssets()
  return (
    portableIds.includes(id) ||
    plan.bundles.some(
      (bundle) =>
        bundle.id === id && !['source-reference', 'native-runtime', 'tiktoken', 'ctok'].includes(bundle.format),
    )
  )
}

export const matchesTokenizerModel = (pattern, model) => {
  const rule = pattern.toLowerCase()
  return rule.endsWith('*') ? model.toLowerCase().startsWith(rule.slice(0, -1)) : model.toLowerCase() === rule
}

export const chooseTokenizer = (model, rules, override = '') => {
  if (typeof model !== 'string' || !model) {
    return { tokenizer: null, match: 'unsupported', source: 'unmapped-model' }
  }
  if (override && override !== 'inherit') {
    return { tokenizer: override, match: 'approximate', source: 'entry-override' }
  }
  const candidates = rules
    .filter((rule) => rule.enabled && rule.models.some((pattern) => matchesTokenizerModel(pattern, model)))
    .sort(
      (left, right) =>
        Number(right.match === 'verified') - Number(left.match === 'verified') ||
        right.priority - left.priority ||
        left.id.localeCompare(right.id),
    )
  if (candidates.length > 0) {
    return {
      tokenizer: candidates[0].tokenizer,
      match: candidates[0].match,
      source: 'global-rule',
      ruleId: candidates[0].id,
    }
  }
  if (/^claude-(?:(?:opus|sonnet|haiku|fable|mythos)-\d|\d)/i.test(model)) {
    return { tokenizer: 'claude_ctok', match: 'reconstructed', source: 'automatic' }
  }
  const openaiTokenizer = tokenizerForOpenaiModel(model)
  if (openaiTokenizer) {
    return { tokenizer: openaiTokenizer, match: 'verified', source: 'automatic' }
  }
  return { tokenizer: null, match: 'unsupported', source: 'unmapped-model' }
}

const publicSettings = (settings) => ({
  enabled: settings.enabled ?? true,
  disabledTokenizers: settings.disabledTokenizers ?? [],
  rules: settings.rules,
})
export const getTokenizerSettings = async () => publicSettings(await redis.getTokenizerSettings())

export const saveTokenizerSettings = async (input) => {
  if (
    !input ||
    typeof input.enabled !== 'boolean' ||
    !Array.isArray(input.rules) ||
    input.rules.length > LIMITS.tokenizerRules ||
    !Array.isArray(input.disabledTokenizers)
  ) {
    throw badRequest('词表启用状态或规则列表无效')
  }
  const { plan } = await loadTokenizerAssets()
  const ids = new Set([
    ...portableIds,
    ...plan.bundles
      .filter((bundle) => !['source-reference', 'native-runtime', 'tiktoken', 'ctok'].includes(bundle.format))
      .map((bundle) => bundle.id),
  ])
  if (input.disabledTokenizers.some((id) => !ids.has(id))) {
    throw badRequest('停用的词表不在支持清单内')
  }
  const rules = input.rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw badRequest('词表规则必须为对象')
    }
    if (
      !Array.isArray(rule.models) ||
      rule.models.length === 0 ||
      rule.models.length > 100 ||
      rule.models.some(
        (model) =>
          typeof model !== 'string' ||
          !model.trim() ||
          model.length > 200 ||
          (model.includes('*') && !/^[^*]+\*$/.test(model)),
      )
    ) {
      throw badRequest('型号规则需使用完整型号或末尾星号前缀，最多 100 项')
    }
    if (
      !ids.has(rule.tokenizer) ||
      !['verified', 'approximate'].includes(rule.match) ||
      !Number.isSafeInteger(rule.priority) ||
      Math.abs(rule.priority) > 100000 ||
      typeof rule.enabled !== 'boolean'
    ) {
      throw badRequest('词表、映射依据、优先级或启用状态无效')
    }
    return {
      id: typeof rule.id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(rule.id) ? rule.id : crypto.randomUUID(),
      models: [...new Set(rule.models.map((model) => model.trim()))],
      tokenizer: rule.tokenizer,
      match: rule.match,
      priority: rule.priority,
      enabled: rule.enabled,
    }
  })
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw badRequest('词表规则 ID 不能重复')
  }
  const settings = {
    rules,
    enabled: input.enabled,
    disabledTokenizers: [...new Set(input.disabledTokenizers)],
  }
  await redis.setTokenizerSettings(settings)
  return publicSettings(settings)
}

export const getTokenizerInventory = async () => {
  const resources = await getTokenizerResourceCatalog()
  const applied = await getAppliedTokenizerAssets()
  const embedded = []
  for (const filename of ['pieces_v3.json', 'pieces_v4_7.json']) {
    const hashes = await hashTokenizerFile(path.join(tokenizerConfig.resourceRoot, 'embedded', filename))
    embedded.push({
      id: `claude_ctok_${filename.replace('.json', '')}`,
      tokenizerId: 'claude_ctok',
      name: `Claude ctok · ${filename}`,
      family: 'Claude',
      format: 'ctok',
      version: ctokVersion,
      precision: 'reconstructed',
      distribution: 'embedded',
      status: 'available',
      engineReady: true,
      ...hashes,
      hashScope: 'raw-file',
      countVocabularySha256: ctokVocabularyHash(ctokModelCoverage(filename)[0].referenceModel),
      modelCoverage: ctokModelCoverage(filename),
    })
  }
  for (const encoding of ['o200k_base', 'cl100k_base']) {
    const definition = loadBpeDefinition(encoding)
    embedded.push({
      id: `openai_${encoding}`,
      tokenizerId: `openai_${encoding}`,
      name: `OpenAI · ${encoding}`,
      family: 'OpenAI',
      format: 'BPE ranks',
      version: definition.version,
      precision: 'official-text',
      distribution: 'package',
      status: 'available',
      engineReady: true,
      sha256: definition.sha256,
      hashScope: 'standard-bpe-ranks',
      sizeBytes: definition.sizeBytes,
      modelCoverage: [
        {
          family: encoding,
          versionRule: `官方映射 ${openaiModelMappings.revision.slice(0, 12)}`,
          models: [
            ...Object.entries(openaiModelMappings.exact)
              .filter(([, value]) => value === encoding)
              .map(([model]) => model),
            ...Object.entries(openaiModelMappings.prefix)
              .filter(([, value]) => value === encoding)
              .map(([prefix]) => `${prefix}*`),
          ],
          notes: '按固定版本官方 model.py 选择文本词表；完整请求、隐藏内容和多模态仍是估算，不自动映射 GPT-6。',
        },
      ],
    })
  }
  const tokenizers = [
    { value: 'claude_ctok', label: 'Claude ctok 1.3.0（逆向内容计数）', local: true },
    { value: 'openai_o200k_base', label: 'OpenAI o200k_base', local: true },
    { value: 'openai_cl100k_base', label: 'OpenAI cl100k_base', local: true },
    ...resources
      .filter((resource) => !['source-reference', 'native-runtime', 'tiktoken', 'ctok'].includes(resource.format))
      .map((resource) => ({
        value: resource.id,
        label: `${resource.family} · ${resource.id}${resource.engine === 'local' ? '（下载后应用）' : '（当前不支持计数）'}`,
        local: resource.engine === 'local',
      })),
  ]
  return {
    resources: resources.map((resource) => ({
      ...resource,
      appliedRevision: applied.bundles.find((bundle) => bundle.id === resource.id)?.revision ?? '',
    })),
    embedded,
    tokenizers,
    pool: tokenizerPoolStatus(),
  }
}

export const countVisibleContent = async ({ texts, model, override = '', missing = [] }) => {
  const started = Date.now()
  let selection = { source: 'unmapped-model', tokenizer: null }
  try {
    const settings = await redis.getTokenizerSettings()
    const applied = await getAppliedTokenizerAssets()
    selection = chooseTokenizer(model, settings.rules, override)
    if (!selection.tokenizer) {
      const automatic = applied.bundles.find((bundle) =>
        bundle.models.some((pattern) => matchesTokenizerModel(pattern, model)),
      )
      if (automatic) {
        selection = { tokenizer: automatic.id, match: 'verified', source: 'applied-vocabulary' }
      }
    }
    const disabled = settings.disabledTokenizers ?? []
    if (settings.enabled === false || disabled.includes(selection.tokenizer)) {
      return {
        contentTokens: estimateVisibleTokens(texts),
        source: 'char-heuristic',
        precision: 'approximate',
        scope: 'visible-text',
        estimate: true,
        selection,
        missing,
        fallbackReason: settings.enabled === false ? '词表计数已关闭，使用基础估算' : '所选词表已停用，使用基础估算',
        costMs: Date.now() - started,
      }
    }
    if (!selection.tokenizer) {
      throw new Error('此模型没有已核实或显式配置的词表映射')
    }
    const bundleId =
      {
        claude_ctok: 'claude_ctok_data',
        openai_o200k_base: 'openai_bpe',
        openai_cl100k_base: 'openai_bpe',
      }[selection.tokenizer] ?? selection.tokenizer
    const asset = applied.bundles.find((bundle) => bundle.id === bundleId)
    const result = await runLocalTokenizer({ texts, model, tokenizer: selection.tokenizer, asset })
    return {
      ...result,
      selection,
      missing,
      estimate: true,
      costMs: Date.now() - started,
      source: asset ? 'applied-vocabulary' : 'node-vocabulary',
      precision:
        (selection.match === 'approximate' && selection.tokenizer !== 'claude_ctok'
          ? 'approximate'
          : result.precision) ??
        (selection.tokenizer === 'claude_ctok'
          ? 'reconstructed'
          : selection.match === 'approximate'
            ? 'approximate'
            : 'official-text'),
    }
  } catch (error) {
    logger.warn('Local token-count estimate fallback', {
      error: { name: error.name, message: error.message, stack: error.stack, code: error.code },
      model,
      tokenizer: selection.tokenizer,
    })
    return {
      contentTokens: estimateVisibleTokens(texts),
      source: 'char-heuristic',
      precision: 'approximate',
      scope: 'visible-text',
      estimate: true,
      selection,
      missing,
      fallbackReason: error.message,
      costMs: Date.now() - started,
    }
  }
}

export const countAnthropicEstimate = async (body, override = '') => {
  const extracted = extractCountTexts(body)
  return countVisibleContent({
    ...extracted,
    model: body.model,
    override,
    missing: [...extracted.missing, 'protocol-framing', 'hidden-content'],
  })
}

export const anthropicEstimateResponse = (count) => ({
  input_tokens: count.contentTokens,
  _crs_estimate: true,
  _crs_estimate_method: count.source,
  _crs_precision: count.precision,
  _crs_tokenizer: count.selection.tokenizer,
  _crs_missing: count.missing,
  _crs_scope: 'visible-text',
})
