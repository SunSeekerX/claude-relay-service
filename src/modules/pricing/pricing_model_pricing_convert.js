// 内部计费模型 <-> LiteLLM 种子字段转换（纯函数，无 IO）
// 内部权威结构对齐 llysc ModelPricing（$/M tokens 字符串）；计费引擎仍吃 LiteLLM per-token 字段

export const IMPORTABLE_MODES = new Set([
  'chat',
  'responses',
  'completion',
  'embedding',
  'image_generation',
  'audio_speech',
  'audio_transcription',
  'moderation',
  'rerank',
])

const getFirstDefined = (obj, keys) => {
  for (const key of keys) {
    const value = obj?.[key]
    if (value !== null) {
      return value
    }
  }
  return undefined
}

// per-token → per-million 字符串。用 String 入乘，避免 2e-7 变 0.19999999999999998
export const formatPerM = (value) => {
  if (value === null || value === '') {
    return undefined
  }
  const num = Number(String(value))
  if (!Number.isFinite(num)) {
    return undefined
  }
  const scaled = num * 1_000_000
  let text = scaled.toFixed(6)
  if (text.includes('.')) {
    text = text.replace(/0+$/, '').replace(/\.$/, '')
  }
  return text
}

const toPerM = (value) => formatPerM(value) ?? '0'
const toPerMOpt = (value) => formatPerM(value)

// per-million 字符串 → per-token number（计费用）
export const perMToToken = (perM) => {
  if (perM === null || perM === '') {
    return undefined
  }
  const num = Number(String(perM))
  if (!Number.isFinite(num)) {
    return undefined
  }
  return num / 1_000_000
}

const setIfDefined = (target, key, value) => {
  if (value !== undefined) {
    target[key] = value
  }
}

const CACHE_WRITE_1H_OVER_5M_RATIO = 1.6

const toTier1hPerMOpt = (explicit, write5m) => {
  if (explicit !== null) {
    return formatPerM(explicit)
  }
  if (write5m !== null) {
    const base = Number(String(write5m))
    if (!Number.isFinite(base)) {
      return undefined
    }
    return formatPerM(base * CACHE_WRITE_1H_OVER_5M_RATIO)
  }
  return undefined
}

const get1hCachePerM = (raw, fallbackName) => {
  if (raw.cache_creation_input_token_cost_above_1hr !== null) {
    return formatPerM(raw.cache_creation_input_token_cost_above_1hr)
  }
  const lower = String(fallbackName || '').toLowerCase()
  if (lower.includes('opus')) {
    return '30'
  }
  if (lower.includes('sonnet')) {
    return '6'
  }
  if (lower.includes('haiku')) {
    return '1.6'
  }
  return undefined
}

// 保留完整模型名（含 vendor/model）；历史 basename 命中由查价双查兜底
export const cleanModelName = (name) => {
  const text = String(name || '').trim()
  if (!text) {
    return ''
  }
  return text
}

// 仅取 basename（vendor/foo → foo），供双查 fallback
export const modelNameBasename = (name) => {
  const text = String(name || '').trim()
  if (!text) {
    return ''
  }
  return text.includes('/') ? text.split('/').pop() : text
}

export const normalizeProvider = (litellmProvider) => {
  if (typeof litellmProvider !== 'string' || !litellmProvider) {
    return 'imported'
  }
  if (litellmProvider.startsWith('vertex_ai')) {
    return 'google'
  }
  const alias = {
    gemini: 'google',
    'text-completion-openai': 'openai',
  }
  return alias[litellmProvider] || litellmProvider
}

const inferModelGroup = (modelName, provider) => {
  const lower = String(modelName || '').toLowerCase()
  if (lower.includes('opus')) {
    return 'claude-opus'
  }
  if (lower.includes('sonnet')) {
    return 'claude-sonnet'
  }
  if (lower.includes('haiku')) {
    return 'claude-haiku'
  }
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
    return 'openai'
  }
  if (lower.includes('gemini')) {
    return 'gemini'
  }
  return provider || 'other'
}

const buildImportedCapabilities = (raw) => ({
  vision: raw.supports_vision ?? false,
  function_calling: raw.supports_function_calling ?? false,
  parallel_function_calling: raw.supports_parallel_function_calling ?? false,
  prompt_caching: raw.supports_prompt_caching ?? false,
  reasoning: raw.supports_reasoning ?? false,
  web_search: raw.supports_web_search ?? false,
  audio:
    raw.supports_audio_input || raw.supports_audio_output
      ? { input: raw.supports_audio_input ?? false, output: raw.supports_audio_output ?? false }
      : false,
  response_schema: raw.supports_response_schema ?? false,
  system_messages: raw.supports_system_messages ?? false,
  tool_choice: raw.supports_tool_choice ?? false,
  pdf_input: raw.supports_pdf_input ?? false,
  assistant_prefill: raw.supports_assistant_prefill ?? false,
  computer_use: raw.supports_computer_use ?? false,
  url_context: raw.supports_url_context ?? false,
  video_input: raw.supports_video_input ?? false,
  native_streaming: raw.supports_native_streaming ?? false,
  service_tier: raw.supports_service_tier ?? false,
})

// 从 litellm 动态提取分段定价（$/M）
const extractTiersPerM = (raw, suffix = '') => {
  const thresholds = new Set()
  const suffixes = !suffix
    ? ['']
    : suffix === 'batch' || suffix === 'flex'
      ? ['_batch', '_batches', '_flex']
      : [`_${suffix}`]

  for (const key of Object.keys(raw || {})) {
    const matched =
      key.match(/_per_token_above_(\d+)k_tokens(_.+)?$/) || key.match(/token_cost_above_(\d+)k_tokens(_.+)?$/)
    if (!matched) {
      continue
    }
    const keySuffix = matched[2] ?? ''
    if (!suffixes.includes(keySuffix)) {
      continue
    }
    thresholds.add(Number(matched[1]) * 1000)
  }

  if (thresholds.size === 0) {
    return null
  }

  return [...thresholds]
    .sort((a, b) => a - b)
    .map((threshold) => {
      const tag = `${threshold / 1000}k`
      return {
        threshold,
        input_per_million_tokens: toPerMOpt(
          getFirstDefined(
            raw,
            suffixes.map((sfx) => `input_cost_per_token_above_${tag}_tokens${sfx}`),
          ),
        ),
        output_per_million_tokens: toPerMOpt(
          getFirstDefined(
            raw,
            suffixes.map((sfx) => `output_cost_per_token_above_${tag}_tokens${sfx}`),
          ),
        ),
        cache_write_per_million_tokens: toPerMOpt(
          getFirstDefined(
            raw,
            suffixes.map((sfx) => `cache_creation_input_token_cost_above_${tag}_tokens${sfx}`),
          ),
        ),
        cache_write_1h_per_million_tokens: toPerMOpt(
          getFirstDefined(
            raw,
            suffixes.map((sfx) => `cache_creation_input_token_cost_above_1hr_above_${tag}_tokens${sfx}`),
          ),
        ),
        cache_read_per_million_tokens: toPerMOpt(
          getFirstDefined(
            raw,
            suffixes.map((sfx) => `cache_read_input_token_cost_above_${tag}_tokens${sfx}`),
          ),
        ),
      }
    })
}

const scalePerMField = (longVal, baseVal, priVal) => {
  if (longVal === null || baseVal === null || priVal === null) {
    return undefined
  }
  const base = Number(String(baseVal))
  const longNum = Number(String(longVal))
  const priNum = Number(String(priVal))
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(longNum) || !Number.isFinite(priNum)) {
    return longVal
  }
  // long/base 都是 $/M 字符串数值，结果仍按 $/M 格式化
  const scaled = priNum * (longNum / base)
  let text = scaled.toFixed(6)
  if (text.includes('.')) {
    text = text.replace(/0+$/, '').replace(/\.$/, '')
  }
  return text
}

// 标准长档 × (priority短/标准短) 派生 priority 长档
const derivePriorityTiersFromBase = (baseTiers, basePrices, priorityPrices) => {
  if (!Array.isArray(baseTiers) || baseTiers.length === 0) {
    return undefined
  }
  const derived = baseTiers.map((tier) => ({
    threshold: tier.threshold,
    input_per_million_tokens: scalePerMField(tier.input_per_million_tokens, basePrices.input, priorityPrices.input),
    output_per_million_tokens: scalePerMField(tier.output_per_million_tokens, basePrices.output, priorityPrices.output),
    cache_write_per_million_tokens: scalePerMField(
      tier.cache_write_per_million_tokens,
      basePrices.cacheWrite,
      priorityPrices.cacheWrite,
    ),
    cache_write_1h_per_million_tokens: scalePerMField(
      tier.cache_write_1h_per_million_tokens,
      basePrices.cacheWrite1h,
      priorityPrices.cacheWrite1h,
    ),
    cache_read_per_million_tokens: scalePerMField(
      tier.cache_read_per_million_tokens,
      basePrices.cacheRead,
      priorityPrices.cacheRead,
    ),
  }))
  const hasAny = derived.some(
    (tier) =>
      tier.input_per_million_tokens !== null ||
      tier.output_per_million_tokens !== null ||
      tier.cache_write_per_million_tokens !== null ||
      tier.cache_write_1h_per_million_tokens !== null ||
      tier.cache_read_per_million_tokens !== null,
  )
  return hasAny ? derived : undefined
}

const buildMultimodalPricing = (raw) => {
  const toStr = (value) => (value !== null ? String(value) : undefined)
  const scq = raw.search_context_cost_per_query
  const imageTierEntries = [
    { condition: '512x512', key: 'output_cost_per_image_above_512_and_512_pixels' },
    { condition: '1024x1024', key: 'output_cost_per_image_above_1024_and_1024_pixels' },
    { condition: 'premium', key: 'output_cost_per_image_premium_image' },
    {
      condition: '512x512_premium',
      key: 'output_cost_per_image_above_512_and_512_pixels_and_premium_image',
    },
    {
      condition: '1024x1024_premium',
      key: 'output_cost_per_image_above_1024_and_1024_pixels_and_premium_image',
    },
  ]
  const imageOutputTiers = imageTierEntries
    .map((entry) => {
      const value = raw[entry.key]
      return value !== null ? { condition: entry.condition, output_per_image: toStr(value) } : null
    })
    .filter(Boolean)

  const videoInputTiers = [8, 15]
    .map((seconds) => {
      const value = raw[`input_cost_per_video_per_second_above_${seconds}s_interval`]
      return value !== null ? { threshold_seconds: seconds, input_per_second: toStr(value) } : null
    })
    .filter(Boolean)

  const mmThresholds = new Set()
  const mmFields = [
    'input_cost_per_audio_per_second_above_',
    'input_cost_per_video_per_second_above_',
    'input_cost_per_character_above_',
    'output_cost_per_character_above_',
    'input_cost_per_image_above_',
  ]
  for (const key of Object.keys(raw || {})) {
    for (const prefix of mmFields) {
      if (!key.startsWith(prefix)) {
        continue
      }
      const matched = key.match(/_above_(\d+)k_tokens$/)
      if (matched) {
        mmThresholds.add(Number(matched[1]) * 1000)
      }
    }
  }
  const multimodalTiers = mmThresholds.size
    ? [...mmThresholds]
        .sort((a, b) => a - b)
        .map((threshold) => {
          const k = threshold / 1000
          const tier = { threshold }
          const audio = toStr(raw[`input_cost_per_audio_per_second_above_${k}k_tokens`])
          if (audio) {
            tier.audio_input_per_second = audio
          }
          const video = toStr(raw[`input_cost_per_video_per_second_above_${k}k_tokens`])
          if (video) {
            tier.video_input_per_second = video
          }
          const inputChar = toStr(raw[`input_cost_per_character_above_${k}k_tokens`])
          if (inputChar) {
            tier.input_per_character = inputChar
          }
          const outputChar = toStr(raw[`output_cost_per_character_above_${k}k_tokens`])
          if (outputChar) {
            tier.output_per_character = outputChar
          }
          const image = toStr(raw[`input_cost_per_image_above_${k}k_tokens`])
          if (image) {
            tier.image_input_per_image = image
          }
          return tier
        })
    : undefined

  return {
    audio_input_per_million_tokens: toPerMOpt(raw.input_cost_per_audio_token),
    audio_output_per_million_tokens: toPerMOpt(raw.output_cost_per_audio_token),
    audio_input_per_second: toStr(raw.input_cost_per_audio_per_second ?? raw.input_cost_per_second),
    audio_output_per_second: toStr(raw.output_cost_per_audio_per_second ?? raw.output_cost_per_second),
    audio_cache_write_per_million_tokens: toPerMOpt(raw.cache_creation_input_audio_token_cost),
    audio_cache_read_per_million_tokens: toPerMOpt(raw.cache_read_input_audio_token_cost),
    image_input_per_image: toStr(raw.input_cost_per_image),
    image_output_per_image: toStr(raw.output_cost_per_image),
    image_input_per_million_tokens: toPerMOpt(raw.input_cost_per_image_token),
    image_output_per_million_tokens: toPerMOpt(raw.output_cost_per_image_token),
    image_input_per_pixel: toStr(raw.input_cost_per_pixel),
    image_output_per_pixel: toStr(raw.output_cost_per_pixel),
    image_cache_read_per_million_tokens: toPerMOpt(raw.cache_read_input_image_token_cost),
    image_output_tiers: imageOutputTiers.length ? imageOutputTiers : undefined,
    video_input_per_second: toStr(raw.input_cost_per_video_per_second),
    video_output_per_second: toStr(raw.output_cost_per_video_per_second),
    video_input_tiers: videoInputTiers.length ? videoInputTiers : undefined,
    multimodal_tiers: multimodalTiers,
    search_context_cost: scq
      ? {
          low: toStr(scq.search_context_size_low),
          medium: toStr(scq.search_context_size_medium),
          high: toStr(scq.search_context_size_high),
        }
      : undefined,
    input_per_query: toStr(raw.input_cost_per_query),
    input_per_request: toStr(raw.input_cost_per_request),
    input_per_character: toStr(raw.input_cost_per_character),
    output_per_character: toStr(raw.output_cost_per_character),
    cache_hit_per_million_tokens: toPerMOpt(raw.input_cost_per_token_cache_hit),
    cache_write_1h_above_200k_per_million_tokens: toPerMOpt(
      raw.cache_creation_input_token_cost_above_1hr_above_200k_tokens,
    ),
    dbu_input_per_million_tokens: toPerMOpt(raw.input_dbu_cost_per_token),
    dbu_output_per_million_tokens: toPerMOpt(raw.output_dbu_cost_per_token),
    ocr_per_page: toStr(raw.ocr_cost_per_page),
  }
}

const getFlexPricingRaw = (raw) => ({
  input: getFirstDefined(raw, [
    'input_cost_per_token_flex',
    'input_cost_per_token_batches',
    'input_cost_per_token_batch',
  ]),
  output: getFirstDefined(raw, [
    'output_cost_per_token_flex',
    'output_cost_per_token_batches',
    'output_cost_per_token_batch',
  ]),
  cacheWrite: getFirstDefined(raw, [
    'cache_creation_input_token_cost_flex',
    'cache_creation_input_token_cost_batches',
    'cache_creation_input_token_cost_batch',
  ]),
  cacheRead: getFirstDefined(raw, [
    'cache_read_input_token_cost_flex',
    'cache_read_input_token_cost_batches',
    'cache_read_input_token_cost_batch',
  ]),
})

// LiteLLM 种子条目 → 内部完整模型记录（导入用）
export const litellmToInternalModel = (name, raw) => {
  const modelName = cleanModelName(name)
  const source = raw && typeof raw === 'object' ? raw : {}
  const flexPricingRaw = getFlexPricingRaw(source)
  const priorityCacheWrite1h = getFirstDefined(source, ['cache_creation_input_token_cost_above_1hr_priority'])
  const flexCacheWrite1h = getFirstDefined(source, [
    'cache_creation_input_token_cost_above_1hr_flex',
    'cache_creation_input_token_cost_above_1hr_batches',
    'cache_creation_input_token_cost_above_1hr_batch',
  ])
  const priceTiers = extractTiersPerM(source)
  const baseInputPerM = toPerM(source.input_cost_per_token)
  const baseOutputPerM = toPerM(source.output_cost_per_token)
  const baseCacheWritePerM = toPerMOpt(source.cache_creation_input_token_cost)
  const baseCacheWrite1hPerM = get1hCachePerM(source, modelName)
  const baseCacheReadPerM = toPerMOpt(source.cache_read_input_token_cost)
  const hasPriority =
    source.input_cost_per_token_priority !== null ||
    source.output_cost_per_token_priority !== null ||
    source.cache_creation_input_token_cost_priority !== null ||
    priorityCacheWrite1h !== null ||
    source.cache_read_input_token_cost_priority !== null
  const priorityInputPerM = toPerMOpt(source.input_cost_per_token_priority)
  const priorityOutputPerM = toPerMOpt(source.output_cost_per_token_priority)
  const priorityCacheWritePerM = toPerMOpt(source.cache_creation_input_token_cost_priority)
  const priorityCacheWrite1hPerM = toTier1hPerMOpt(
    priorityCacheWrite1h,
    source.cache_creation_input_token_cost_priority,
  )
  const priorityCacheReadPerM = toPerMOpt(source.cache_read_input_token_cost_priority)
  const priorityTiers =
    extractTiersPerM(source, 'priority') ??
    (hasPriority
      ? derivePriorityTiersFromBase(
          priceTiers,
          {
            input: baseInputPerM,
            output: baseOutputPerM,
            cacheWrite: baseCacheWritePerM,
            cacheWrite1h: baseCacheWrite1hPerM,
            cacheRead: baseCacheReadPerM,
          },
          {
            input: priorityInputPerM,
            output: priorityOutputPerM,
            cacheWrite: priorityCacheWritePerM,
            cacheWrite1h: priorityCacheWrite1hPerM,
            cacheRead: priorityCacheReadPerM,
          },
        )
      : undefined)

  const hasFlex =
    flexPricingRaw.input !== null ||
    flexPricingRaw.output !== null ||
    flexPricingRaw.cacheWrite !== null ||
    flexCacheWrite1h !== null ||
    flexPricingRaw.cacheRead !== null

  const pricing = {
    currency: 'USD',
    input_per_million_tokens: baseInputPerM,
    output_per_million_tokens: baseOutputPerM,
    cache_write_per_million_tokens: baseCacheWritePerM,
    cache_write_1h_per_million_tokens: baseCacheWrite1hPerM,
    cache_read_per_million_tokens: baseCacheReadPerM,
    reasoning_per_million_tokens: toPerMOpt(source.output_cost_per_reasoning_token),
    price_tiers: priceTiers || undefined,
    priority_pricing: hasPriority
      ? {
          input_per_million_tokens: priorityInputPerM,
          output_per_million_tokens: priorityOutputPerM,
          cache_write_per_million_tokens: priorityCacheWritePerM,
          cache_write_1h_per_million_tokens: priorityCacheWrite1hPerM,
          cache_read_per_million_tokens: priorityCacheReadPerM,
          price_tiers: priorityTiers,
        }
      : undefined,
    flex_pricing: hasFlex
      ? {
          input_per_million_tokens: toPerMOpt(flexPricingRaw.input),
          output_per_million_tokens: toPerMOpt(flexPricingRaw.output),
          cache_write_per_million_tokens: toPerMOpt(flexPricingRaw.cacheWrite),
          cache_write_1h_per_million_tokens: toTier1hPerMOpt(flexCacheWrite1h, flexPricingRaw.cacheWrite),
          cache_read_per_million_tokens: toPerMOpt(flexPricingRaw.cacheRead),
          price_tiers: extractTiersPerM(source, 'flex') || extractTiersPerM(source, 'batch') || undefined,
        }
      : undefined,
    fast_rate_multiplier:
      typeof source.provider_specific_entry?.fast === 'number' && source.provider_specific_entry.fast > 0
        ? source.provider_specific_entry.fast
        : undefined,
    ...buildMultimodalPricing(source),
  }

  // 清掉 undefined，保持存盘干净
  const compactPricing = JSON.parse(JSON.stringify(pricing))

  return {
    name: modelName,
    provider: normalizeProvider(source.litellm_provider),
    mode: source.mode || 'chat',
    modelGroup: inferModelGroup(modelName, source.litellm_provider),
    deprecationDate: source.deprecation_date || null,
    maxInputTokens: source.max_input_tokens ?? null,
    maxOutputTokens: source.max_output_tokens ?? null,
    pricing: compactPricing,
    capabilities: buildImportedCapabilities(source),
    metadata: source,
    // 有完整 pricing 才参与计费优先
    hasBilling: true,
  }
}

const thresholdToTag = (threshold) => {
  const n = Number(threshold)
  if (!Number.isFinite(n) || n <= 0) {
    return null
  }
  if (n % 1000 === 0) {
    return `${n / 1000}k`
  }
  return `${n}`
}

const applyTierFields = (target, tiers, suffix = '') => {
  if (!Array.isArray(tiers)) {
    return
  }
  for (const tier of tiers) {
    const tag = thresholdToTag(tier?.threshold)
    if (!tag) {
      continue
    }
    setIfDefined(
      target,
      `input_cost_per_token_above_${tag}_tokens${suffix}`,
      perMToToken(tier.input_per_million_tokens),
    )
    setIfDefined(
      target,
      `output_cost_per_token_above_${tag}_tokens${suffix}`,
      perMToToken(tier.output_per_million_tokens),
    )
    setIfDefined(
      target,
      `cache_creation_input_token_cost_above_${tag}_tokens${suffix}`,
      perMToToken(tier.cache_write_per_million_tokens),
    )
    setIfDefined(
      target,
      `cache_creation_input_token_cost_above_1hr_above_${tag}_tokens${suffix}`,
      perMToToken(tier.cache_write_1h_per_million_tokens),
    )
    setIfDefined(
      target,
      `cache_read_input_token_cost_above_${tag}_tokens${suffix}`,
      perMToToken(tier.cache_read_per_million_tokens),
    )
  }
}

// 从种子 metadata 抽出非价格字段（端点/模态/能力标记等），价格一律以内部 pricing 为准
const isLiteLLMCostKey = (key) => {
  const k = String(key || '')
  return (
    k.includes('cost_per') ||
    k.includes('search_context_cost') ||
    k === 'provider_specific_entry' ||
    k.startsWith('input_cost') ||
    k.startsWith('output_cost') ||
    k.startsWith('cache_') ||
    // xAI 分档价是计费字段：不得从 metadata 打底回带，否则会盖掉内部模型管理员改的扁平单价
    // [人工决策-2026-08-25] 内部整模优先=只认 internal.pricing 反转字段；分档仅兜底种子对象自身携带
    k === 'xai_image_output_tiers' ||
    k === 'xai_video_output_tiers' ||
    k.startsWith('xai_')
  )
}

const metadataNonCostBase = (metadata) => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {}
  }
  const base = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (isLiteLLMCostKey(key)) {
      continue
    }
    base[key] = value
  }
  return base
}

// 内部完整模型 → LiteLLM 形字段（供 pricingService.calculateCost / 展示合并）
// metadata 非价格字段打底，计费字段只来自内部 pricing（整模价权威，不和种子价字段 merge）
export const internalToLiteLLM = (record) => {
  if (!record || typeof record !== 'object') {
    return null
  }
  const pricing = record.pricing && typeof record.pricing === 'object' ? record.pricing : {}
  const metaBase = metadataNonCostBase(record.metadata)
  const out = {
    ...metaBase,
    litellm_provider: record.provider || metaBase.litellm_provider || 'imported',
    mode: record.mode || metaBase.mode || 'chat',
    max_input_tokens: record.maxInputTokens ?? metaBase.max_input_tokens ?? undefined,
    max_output_tokens: record.maxOutputTokens ?? metaBase.max_output_tokens ?? undefined,
    max_tokens:
      record.maxOutputTokens ??
      record.maxInputTokens ??
      metaBase.max_tokens ??
      metaBase.max_output_tokens ??
      metaBase.max_input_tokens ??
      undefined,
    deprecation_date: record.deprecationDate || metaBase.deprecation_date || undefined,
  }

  setIfDefined(out, 'input_cost_per_token', perMToToken(pricing.input_per_million_tokens))
  setIfDefined(out, 'output_cost_per_token', perMToToken(pricing.output_per_million_tokens))
  setIfDefined(out, 'cache_creation_input_token_cost', perMToToken(pricing.cache_write_per_million_tokens))
  setIfDefined(out, 'cache_creation_input_token_cost_above_1hr', perMToToken(pricing.cache_write_1h_per_million_tokens))
  setIfDefined(out, 'cache_read_input_token_cost', perMToToken(pricing.cache_read_per_million_tokens))
  setIfDefined(out, 'output_cost_per_reasoning_token', perMToToken(pricing.reasoning_per_million_tokens))

  applyTierFields(out, pricing.price_tiers, '')

  if (pricing.priority_pricing) {
    const pp = pricing.priority_pricing
    setIfDefined(out, 'input_cost_per_token_priority', perMToToken(pp.input_per_million_tokens))
    setIfDefined(out, 'output_cost_per_token_priority', perMToToken(pp.output_per_million_tokens))
    setIfDefined(out, 'cache_creation_input_token_cost_priority', perMToToken(pp.cache_write_per_million_tokens))
    setIfDefined(
      out,
      'cache_creation_input_token_cost_above_1hr_priority',
      perMToToken(pp.cache_write_1h_per_million_tokens),
    )
    setIfDefined(out, 'cache_read_input_token_cost_priority', perMToToken(pp.cache_read_per_million_tokens))
    applyTierFields(out, pp.price_tiers, '_priority')
  }

  if (pricing.flex_pricing) {
    const fp = pricing.flex_pricing
    setIfDefined(out, 'input_cost_per_token_flex', perMToToken(fp.input_per_million_tokens))
    setIfDefined(out, 'output_cost_per_token_flex', perMToToken(fp.output_per_million_tokens))
    setIfDefined(out, 'cache_creation_input_token_cost_flex', perMToToken(fp.cache_write_per_million_tokens))
    setIfDefined(
      out,
      'cache_creation_input_token_cost_above_1hr_flex',
      perMToToken(fp.cache_write_1h_per_million_tokens),
    )
    setIfDefined(out, 'cache_read_input_token_cost_flex', perMToToken(fp.cache_read_per_million_tokens))
    applyTierFields(out, fp.price_tiers, '_flex')
  }

  // 多模态 / 其它
  setIfDefined(out, 'input_cost_per_audio_token', perMToToken(pricing.audio_input_per_million_tokens))
  setIfDefined(out, 'output_cost_per_audio_token', perMToToken(pricing.audio_output_per_million_tokens))
  if (pricing.audio_input_per_second !== null) {
    out.input_cost_per_audio_per_second = Number(pricing.audio_input_per_second)
  }
  if (pricing.audio_output_per_second !== null) {
    out.output_cost_per_audio_per_second = Number(pricing.audio_output_per_second)
  }
  setIfDefined(out, 'cache_creation_input_audio_token_cost', perMToToken(pricing.audio_cache_write_per_million_tokens))
  setIfDefined(out, 'cache_read_input_audio_token_cost', perMToToken(pricing.audio_cache_read_per_million_tokens))
  if (pricing.image_input_per_image !== null) {
    out.input_cost_per_image = Number(pricing.image_input_per_image)
  }
  if (pricing.image_output_per_image !== null) {
    out.output_cost_per_image = Number(pricing.image_output_per_image)
  }
  setIfDefined(out, 'input_cost_per_image_token', perMToToken(pricing.image_input_per_million_tokens))
  setIfDefined(out, 'output_cost_per_image_token', perMToToken(pricing.image_output_per_million_tokens))
  if (pricing.image_input_per_pixel !== null) {
    out.input_cost_per_pixel = Number(pricing.image_input_per_pixel)
  }
  if (pricing.image_output_per_pixel !== null) {
    out.output_cost_per_pixel = Number(pricing.image_output_per_pixel)
  }
  setIfDefined(out, 'cache_read_input_image_token_cost', perMToToken(pricing.image_cache_read_per_million_tokens))
  if (pricing.video_input_per_second !== null) {
    out.input_cost_per_video_per_second = Number(pricing.video_input_per_second)
  }
  if (pricing.video_output_per_second !== null) {
    out.output_cost_per_video_per_second = Number(pricing.video_output_per_second)
  }
  if (pricing.input_per_query !== null) {
    out.input_cost_per_query = Number(pricing.input_per_query)
  }
  if (pricing.input_per_request !== null) {
    out.input_cost_per_request = Number(pricing.input_per_request)
  }
  if (pricing.input_per_character !== null) {
    out.input_cost_per_character = Number(pricing.input_per_character)
  }
  if (pricing.output_per_character !== null) {
    out.output_cost_per_character = Number(pricing.output_per_character)
  }
  setIfDefined(out, 'input_cost_per_token_cache_hit', perMToToken(pricing.cache_hit_per_million_tokens))
  setIfDefined(
    out,
    'cache_creation_input_token_cost_above_1hr_above_200k_tokens',
    perMToToken(pricing.cache_write_1h_above_200k_per_million_tokens),
  )
  setIfDefined(out, 'input_dbu_cost_per_token', perMToToken(pricing.dbu_input_per_million_tokens))
  setIfDefined(out, 'output_dbu_cost_per_token', perMToToken(pricing.dbu_output_per_million_tokens))
  if (pricing.ocr_per_page !== null) {
    out.ocr_cost_per_page = Number(pricing.ocr_per_page)
  }
  if (pricing.search_context_cost) {
    out.search_context_cost_per_query = {
      search_context_size_low:
        pricing.search_context_cost.low !== null ? Number(pricing.search_context_cost.low) : undefined,
      search_context_size_medium:
        pricing.search_context_cost.medium !== null ? Number(pricing.search_context_cost.medium) : undefined,
      search_context_size_high:
        pricing.search_context_cost.high !== null ? Number(pricing.search_context_cost.high) : undefined,
    }
  }
  if (pricing.fast_rate_multiplier !== null) {
    const fast = Number(pricing.fast_rate_multiplier)
    if (Number.isFinite(fast) && fast > 0) {
      out.provider_specific_entry = { fast }
    }
  }

  // 图片输出尺寸/质量分段 → litellm 字段
  if (Array.isArray(pricing.image_output_tiers)) {
    const map = {
      '512x512': 'output_cost_per_image_above_512_and_512_pixels',
      '1024x1024': 'output_cost_per_image_above_1024_and_1024_pixels',
      premium: 'output_cost_per_image_premium_image',
      '512x512_premium': 'output_cost_per_image_above_512_and_512_pixels_and_premium_image',
      '1024x1024_premium': 'output_cost_per_image_above_1024_and_1024_pixels_and_premium_image',
    }
    for (const tier of pricing.image_output_tiers) {
      const field = map[tier?.condition]
      if (!field || tier.output_per_image === null || tier.output_per_image === '') {
        continue
      }
      const num = Number(tier.output_per_image)
      if (Number.isFinite(num)) {
        out[field] = num
      }
    }
  }

  // 视频时长分段
  if (Array.isArray(pricing.video_input_tiers)) {
    for (const tier of pricing.video_input_tiers) {
      const seconds = Number(tier?.threshold_seconds)
      if (!Number.isFinite(seconds) || tier.input_per_second === null || tier.input_per_second === '') {
        continue
      }
      const num = Number(tier.input_per_second)
      if (!Number.isFinite(num)) {
        continue
      }
      out[`input_cost_per_video_per_second_above_${seconds}s_interval`] = num
    }
  }

  // 多模态长上下文分段
  if (Array.isArray(pricing.multimodal_tiers)) {
    for (const tier of pricing.multimodal_tiers) {
      const thr = Number(tier?.threshold)
      if (!Number.isFinite(thr) || thr <= 0) {
        continue
      }
      const tag = thr % 1000 === 0 ? `${thr / 1000}k` : String(thr)
      if (tier.audio_input_per_second !== null && tier.audio_input_per_second !== '') {
        const num = Number(tier.audio_input_per_second)
        if (Number.isFinite(num)) {
          out[`input_cost_per_audio_per_second_above_${tag}_tokens`] = num
        }
      }
      if (tier.video_input_per_second !== null && tier.video_input_per_second !== '') {
        const num = Number(tier.video_input_per_second)
        if (Number.isFinite(num)) {
          out[`input_cost_per_video_per_second_above_${tag}_tokens`] = num
        }
      }
      if (tier.input_per_character !== null && tier.input_per_character !== '') {
        const num = Number(tier.input_per_character)
        if (Number.isFinite(num)) {
          out[`input_cost_per_character_above_${tag}_tokens`] = num
        }
      }
      if (tier.output_per_character !== null && tier.output_per_character !== '') {
        const num = Number(tier.output_per_character)
        if (Number.isFinite(num)) {
          out[`output_cost_per_character_above_${tag}_tokens`] = num
        }
      }
      if (tier.image_input_per_image !== null && tier.image_input_per_image !== '') {
        const num = Number(tier.image_input_per_image)
        if (Number.isFinite(num)) {
          out[`input_cost_per_image_above_${tag}_tokens`] = num
        }
      }
    }
  }

  // 能力回写（展示用）
  const caps = record.capabilities || {}
  if (caps.vision) {
    out.supports_vision = true
  }
  if (caps.function_calling) {
    out.supports_function_calling = true
  }
  if (caps.prompt_caching) {
    out.supports_prompt_caching = true
  }
  if (caps.reasoning) {
    out.supports_reasoning = true
  }
  if (caps.web_search) {
    out.supports_web_search = true
  }
  if (caps.service_tier) {
    out.supports_service_tier = true
  }

  out._billingSource = 'internal'
  return out
}

export const emptyPricing = () => ({
  currency: 'USD',
  // 空表单不预填 0，避免「新建保存」把种子价覆盖成免费
  input_per_million_tokens: '',
  output_per_million_tokens: '',
  cache_write_per_million_tokens: '',
  cache_write_1h_per_million_tokens: '',
  cache_read_per_million_tokens: '',
  reasoning_per_million_tokens: '',
  price_tiers: [],
  priority_pricing: {
    input_per_million_tokens: '',
    output_per_million_tokens: '',
    cache_write_per_million_tokens: '',
    cache_write_1h_per_million_tokens: '',
    cache_read_per_million_tokens: '',
    price_tiers: [],
  },
  flex_pricing: {
    input_per_million_tokens: '',
    output_per_million_tokens: '',
    cache_write_per_million_tokens: '',
    cache_write_1h_per_million_tokens: '',
    cache_read_per_million_tokens: '',
    price_tiers: [],
  },
  audio_input_per_million_tokens: '',
  audio_output_per_million_tokens: '',
  audio_input_per_second: '',
  audio_output_per_second: '',
  audio_cache_write_per_million_tokens: '',
  audio_cache_read_per_million_tokens: '',
  image_input_per_image: '',
  image_output_per_image: '',
  image_input_per_million_tokens: '',
  image_output_per_million_tokens: '',
  image_input_per_pixel: '',
  image_output_per_pixel: '',
  image_cache_read_per_million_tokens: '',
  image_output_tiers: [],
  video_input_per_second: '',
  video_output_per_second: '',
  video_input_tiers: [],
  multimodal_tiers: [],
  fast_rate_multiplier: null,
  search_context_cost: { low: '', medium: '', high: '' },
  input_per_query: '',
  input_per_request: '',
  input_per_character: '',
  output_per_character: '',
  cache_hit_per_million_tokens: '',
  cache_write_1h_above_200k_per_million_tokens: '',
  dbu_input_per_million_tokens: '',
  dbu_output_per_million_tokens: '',
  ocr_per_page: '',
})

export const emptyInternalModel = (name = '') => ({
  name: cleanModelName(name),
  provider: '',
  mode: 'chat',
  modelGroup: '',
  deprecationDate: null,
  maxInputTokens: null,
  maxOutputTokens: null,
  pricing: emptyPricing(),
  capabilities: {},
  metadata: null,
  hasBilling: true,
})

export const isFiniteNonNegNumber = (value) => {
  if (value === null || value === '') {
    return false
  }
  const num = Number(value)
  return Number.isFinite(num) && num >= 0
}

// 结构字段：阈值/币种/条件，不是单价，绝不能当成“有价格”
// 结构字段 + 倍率字段：都不是「单价」，单独存在不得让内部模型抢占种子
const NON_PRICE_KEYS = new Set([
  'currency',
  'condition',
  'threshold',
  'threshold_seconds',
  // Fast 倍率只乘在已有 token 单价上；单独保存会让普通请求按 0 元
  'fast_rate_multiplier',
])

// 是否具备可计费的完整内部定价（任一有限非负单价字段即可；含图/音/请求级）
// [人工决策] threshold 等结构字段不算价格——空分段只有 threshold 时不得通过校验，否则内部全 0 抢占种子
const hasAnyPriceValue = (value, keyHint = '') => {
  if (value === null || value === '') {
    return false
  }
  if (NON_PRICE_KEYS.has(keyHint)) {
    return false
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasAnyPriceValue(item))
  }
  if (typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => hasAnyPriceValue(item, key))
  }
  return isFiniteNonNegNumber(value)
}

export const hasBillingPricing = (record) => {
  if (!record || typeof record !== 'object') {
    return false
  }
  if (record.hasBilling === false) {
    return false
  }
  const { pricing } = record
  if (!pricing || typeof pricing !== 'object') {
    return false
  }
  return hasAnyPriceValue(pricing)
}

// 保存前清洗/校验 pricing：非法数字字段拒绝
export const assertAndSanitizePricing = (pricing) => {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
    throw new Error('pricing 必须是对象')
  }
  const errors = []
  const isPriceKey = (key) =>
    key.includes('per_million') ||
    key.includes('per_second') ||
    key.includes('per_image') ||
    key.includes('per_pixel') ||
    key.includes('per_page') ||
    key.includes('per_query') ||
    key.includes('per_request') ||
    key.includes('per_character') ||
    key === 'fast_rate_multiplier' ||
    key === 'threshold' ||
    key === 'threshold_seconds' ||
    key === 'low' ||
    key === 'medium' ||
    key === 'high'

  const walk = (obj, path) => {
    if (obj === null || obj === '') {
      return undefined
    }
    if (Array.isArray(obj)) {
      const arr = []
      obj.forEach((item, index) => {
        const v = walk(item, `${path}[${index}]`)
        if (v !== undefined) {
          arr.push(v)
        }
      })
      return arr
    }
    if (typeof obj === 'object') {
      const next = {}
      for (const [key, value] of Object.entries(obj)) {
        if (value === null || value === '') {
          continue
        }
        if (typeof value === 'object') {
          const nested = walk(value, `${path}.${key}`)
          if (
            nested === undefined ||
            (Array.isArray(nested) && nested.length === 0) ||
            (typeof nested === 'object' && !Array.isArray(nested) && Object.keys(nested).length === 0)
          ) {
            continue
          }
          next[key] = nested
          continue
        }
        if (isPriceKey(key)) {
          const num = Number(value)
          if (!Number.isFinite(num) || num < 0) {
            errors.push(`${path}.${key}=${value}`)
            continue
          }
          if (key === 'threshold' || key === 'threshold_seconds') {
            next[key] = num
          } else {
            // 金额统一字符串，避免 JSON 浮点脏值
            let text = String(value).trim()
            if (/e/i.test(text)) {
              text = num.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
            }
            // 再验一次
            if (!Number.isFinite(Number(text))) {
              errors.push(`${path}.${key}=${value}`)
              continue
            }
            next[key] = text
          }
          continue
        }
        next[key] = value
      }
      return next
    }
    return obj
  }

  const cleaned = walk(pricing, 'pricing') || {}
  if (errors.length) {
    throw new Error(`pricing 含非法数字字段: ${errors.slice(0, 8).join(', ')}`)
  }

  // 丢掉“只有 threshold、没有任何单价”的空分段，避免脏数据落库
  const pruneEmptyTiers = (obj) => {
    if (!obj || typeof obj !== 'object') {
      return obj
    }
    if (Array.isArray(obj)) {
      return obj
        .map((item) => pruneEmptyTiers(item))
        .filter((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return item !== null
          }
          // tier-like：有 threshold/condition 但无任何单价 → 丢弃
          const keys = Object.keys(item)
          const onlyStructural = keys.every((key) => NON_PRICE_KEYS.has(key))
          if (onlyStructural) {
            return false
          }
          return (
            hasAnyPriceValue(item) ||
            keys.some((key) => !NON_PRICE_KEYS.has(key) && item[key] !== null && item[key] !== '')
          )
        })
    }
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value) && (key.endsWith('_tiers') || key === 'price_tiers')) {
        const next = pruneEmptyTiers(value)
        if (!next.length) {
          delete obj[key]
        } else {
          obj[key] = next
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        pruneEmptyTiers(value)
        if (Object.keys(value).length === 0) {
          delete obj[key]
        }
      }
    }
    return obj
  }
  pruneEmptyTiers(cleaned)

  // 至少要有一个可计费单价（token/图/音/请求/分段均可），禁止空 pricing 抢占种子
  // threshold 不算价格
  if (!hasAnyPriceValue(cleaned)) {
    throw new Error('pricing 至少需要一个有效的非负单价字段（threshold / Fast 倍率不算单价）')
  }
  if (!cleaned.currency) {
    cleaned.currency = 'USD'
  }
  return cleaned
}

export const isImportableMode = (mode) => {
  // 无 mode / 未知自定义 mode 都放行；白名单仅作已知计费类文档，不做拒绝依据
  // （曾因 mode 过窄拒 embedding/image 等，现统一可导入）
  if (mode === null || mode === '') {
    return true
  }
  if (IMPORTABLE_MODES.has(mode)) {
    return true
  }
  return true
}

// metadata 敏感键模式：保存消毒 + 公开价表绝不出站
const METADATA_SENSITIVE_KEY =
  /(authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|set-cookie|client_secret|private[_-]?key|passwd|credential)/i

const MAX_METADATA_JSON_CHARS = 20000
const MAX_METADATA_DEPTH = 6

const sanitizeMetadataValue = (value, depth, keyPath) => {
  if (value === null) {
    return value
  }
  if (depth > MAX_METADATA_DEPTH) {
    return '[truncated-depth]'
  }
  if (typeof value === 'string') {
    if (value.length > 2000) {
      return `${value.slice(0, 2000)}...[truncated]`
    }
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item, i) => sanitizeMetadataValue(item, depth + 1, `${keyPath}[${i}]`))
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      if (METADATA_SENSITIVE_KEY.test(key)) {
        continue
      }
      out[key] = sanitizeMetadataValue(child, depth + 1, key)
    }
    return out
  }
  return undefined
}

// 保存前消毒 metadata：剥敏感键、限深限长；非法则 null
export const sanitizeMetadataForStore = (metadata) => {
  if (metadata === null) {
    return null
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null
  }
  const cleaned = sanitizeMetadataValue(metadata, 0, '')
  try {
    const json = JSON.stringify(cleaned)
    if (!json) {
      return null
    }
    if (json.length > MAX_METADATA_JSON_CHARS) {
      throw new Error(`metadata 过大（>${MAX_METADATA_JSON_CHARS} 字符）`)
    }
  } catch (error) {
    if (error && error.message && error.message.includes('metadata')) {
      throw error
    }
    return null
  }
  return cleaned
}

// 公开价表字段白名单（用户统计页展示用）；禁止透传任意 metadata
const PUBLIC_PRICING_KEYS = new Set([
  'litellm_provider',
  'mode',
  'max_tokens',
  'max_input_tokens',
  'max_output_tokens',
  'max_output_tokens_for_reasoning',
  'deprecation_date',
  'supports_vision',
  'supports_function_calling',
  'supports_parallel_function_calling',
  'supports_prompt_caching',
  'supports_reasoning',
  'supports_web_search',
  'supports_service_tier',
  'supports_pdf_input',
  'supports_response_schema',
  'supports_system_messages',
  'supports_tool_choice',
  'supports_assistant_prefill',
  'supports_computer_use',
  'supports_url_context',
  'supports_video_input',
  'supports_audio_input',
  'supports_audio_output',
  'supports_native_streaming',
  'supported_endpoints',
  'supported_modalities',
  'supported_regions',
  '_billingSource',
])

const isPublicPricingKey = (key) => {
  const k = String(key || '')
  if (PUBLIC_PRICING_KEYS.has(k)) {
    return true
  }
  // 价格相关字段全部放行（计费展示需要）
  if (k.includes('cost') || k.includes('price') || k.startsWith('input_') || k.startsWith('output_')) {
    return true
  }
  if (k.startsWith('cache_') || k.startsWith('search_context')) {
    return true
  }
  if (k === 'provider_specific_entry' || k.startsWith('xai_')) {
    return true
  }
  return false
}

export const toPublicPricingEntry = (entry) => {
  if (!entry || typeof entry !== 'object') {
    return entry
  }
  const out = {}
  for (const [key, value] of Object.entries(entry)) {
    if (!isPublicPricingKey(key)) {
      continue
    }
    out[key] = value
  }
  return out
}

export const toPublicPricingMap = (pricingMap) => {
  if (!pricingMap || typeof pricingMap !== 'object') {
    return {}
  }
  const out = {}
  for (const [name, entry] of Object.entries(pricingMap)) {
    out[name] = toPublicPricingEntry(entry)
  }
  return out
}
