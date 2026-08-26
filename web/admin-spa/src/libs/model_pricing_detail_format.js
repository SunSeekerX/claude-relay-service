// 模型详情友好展示（对齐 llysc）：基础价 / 分段 / Priority·Flex / 多模态 / 能力
// 支持 litellm 扁平 per-token 字段 与 内部 nested per-million 结构

const toNum = (value) => {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

// litellm per-token → $/M；已是 per-million 的大数原样
const toPerM = (value) => {
  const num = toNum(value)
  if (num == null) return null
  if (Math.abs(num) > 0 && Math.abs(num) < 0.01) return num * 1e6
  return num
}

export const formatPriceMoney = (perM) => {
  const num = toNum(perM)
  if (num == null) return null
  if (num === 0) return '$0'
  const abs = Math.abs(num)
  let fixed
  if (abs < 0.01) fixed = num.toFixed(6)
  else if (abs < 1) fixed = num.toFixed(4)
  else fixed = num.toFixed(2)
  if (abs >= 1) return `$${Number(fixed).toFixed(2)}`
  return `$${fixed.replace(/\.?0+$/, '')}`
}

const pos = (value) => {
  const num = toNum(value)
  return num != null && num > 0
}

export const effectiveCw1h = (raw1h, base5m) => (pos(raw1h) ? raw1h : base5m)

const isNestedPricing = (source) =>
  !!(
    source &&
    typeof source === 'object' &&
    (source.input_per_million_tokens != null ||
      source.priority_pricing != null ||
      source.flex_pricing != null ||
      (Array.isArray(source.price_tiers) && source.price_tiers.length))
  )

const formatRateParts = ({
  input,
  output,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
  reasoning
} = {}) => {
  const parts = []
  const push = (key, label, perM) => {
    const money = formatPriceMoney(perM)
    if (money == null) return
    parts.push({ key, label, value: money })
  }
  push('input', '输入', input)
  push('output', '输出', output)
  push('cacheWrite', '缓存写5m', cacheWrite5m)
  push('cacheWrite', '缓存写1h', cacheWrite1h)
  push('cacheRead', '缓存读取', cacheRead)
  if (reasoning != null && reasoning > 0 && reasoning !== output) {
    push('reasoning', '思考', reasoning)
  }
  return parts
}

const formatRateLine = (rate) =>
  formatRateParts(rate)
    .map((part) => `${part.label}: ${part.value}`)
    .join(', ')

const formatTokens = (tokens) => {
  const num = toNum(tokens)
  if (num == null || num <= 0) return ''
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(0)}K`
  return String(num)
}

const scaleByBase = (tierVal, baseVal, serviceVal) => {
  const t = toNum(tierVal)
  const b = toNum(baseVal)
  const s = toNum(serviceVal)
  if (t == null) return s
  if (b == null || b === 0 || s == null) return t
  return s * (t / b)
}

const synthesizeServiceTiers = (service, base, baseTiers) => {
  if (!service || !baseTiers?.length) return service
  if (service.tiers?.length) return service
  return {
    ...service,
    _estimatedLongContext: true,
    tiers: baseTiers.map((tier) => ({
      threshold: tier.threshold,
      estimated: true,
      input: scaleByBase(tier.input, base.input, service.input),
      output: scaleByBase(tier.output, base.output, service.output),
      cacheWrite5m: scaleByBase(tier.cacheWrite5m, base.cacheWrite5m, service.cacheWrite5m),
      cacheWrite1h: scaleByBase(tier.cacheWrite1h, base.cacheWrite1h, service.cacheWrite1h),
      cacheRead: scaleByBase(tier.cacheRead, base.cacheRead, service.cacheRead)
    }))
  }
}

const normalizeFlat = (source) => {
  const base5m = toPerM(source.cache_creation_input_token_cost)
  const base1h = toPerM(source.cache_creation_input_token_cost_above_1hr)
  const base = {
    input: toPerM(source.input_cost_per_token),
    output: toPerM(source.output_cost_per_token),
    cacheWrite5m: base5m,
    cacheWrite1h: effectiveCw1h(base1h, base5m),
    cacheRead: toPerM(source.cache_read_input_token_cost),
    reasoning: toPerM(source.output_cost_per_reasoning_token)
  }

  const thresholdSet = new Set()
  for (const key of Object.keys(source)) {
    const match = key.match(/_above_(\d+)k_tokens/)
    if (match) thresholdSet.add(Number(match[1]) * 1000)
  }
  const thresholds = [...thresholdSet].sort((a, b) => a - b)

  const readTier = (threshold, suffix = '') => {
    const k = threshold / 1000
    const pick = (baseKey) => toPerM(source[`${baseKey}_above_${k}k_tokens${suffix}`])
    const cw5 = pick('cache_creation_input_token_cost')
    const cw1raw = toPerM(
      source[`cache_creation_input_token_cost_above_1hr_above_${k}k_tokens${suffix}`]
    )
    return {
      threshold,
      input: pick('input_cost_per_token'),
      output: pick('output_cost_per_token'),
      cacheWrite5m: cw5,
      cacheWrite1h: effectiveCw1h(cw1raw, cw5),
      cacheRead: pick('cache_read_input_token_cost'),
      reasoning: pick('output_cost_per_reasoning_token')
    }
  }

  const baseTiers = thresholds
    .map((threshold) => readTier(threshold, ''))
    .filter(
      (tier) =>
        tier.input != null ||
        tier.output != null ||
        tier.cacheWrite5m != null ||
        tier.cacheRead != null
    )

  const readService = (suffix) => {
    const has =
      source[`input_cost_per_token${suffix}`] != null ||
      source[`output_cost_per_token${suffix}`] != null ||
      source[`cache_creation_input_token_cost${suffix}`] != null ||
      source[`cache_read_input_token_cost${suffix}`] != null ||
      thresholds.some(
        (threshold) =>
          source[`input_cost_per_token_above_${threshold / 1000}k_tokens${suffix}`] != null ||
          source[`output_cost_per_token_above_${threshold / 1000}k_tokens${suffix}`] != null
      )
    if (!has) return null
    const cw5 = toPerM(source[`cache_creation_input_token_cost${suffix}`])
    const cw1 = toPerM(source[`cache_creation_input_token_cost_above_1hr${suffix}`])
    return {
      input: toPerM(source[`input_cost_per_token${suffix}`]),
      output: toPerM(source[`output_cost_per_token${suffix}`]),
      cacheWrite5m: cw5,
      cacheWrite1h: effectiveCw1h(cw1, cw5 != null ? cw5 : base.cacheWrite5m),
      cacheRead: toPerM(source[`cache_read_input_token_cost${suffix}`]),
      tiers: thresholds
        .map((threshold) => readTier(threshold, suffix))
        .filter(
          (tier) =>
            tier.input != null ||
            tier.output != null ||
            tier.cacheWrite5m != null ||
            tier.cacheRead != null
        )
    }
  }

  return {
    kind: 'flat',
    base,
    baseTiers,
    priority: readService('_priority'),
    flex: readService('_flex'),
    batch: readService('_batches') || readService('_batch'),
    meta: source,
    caps: source,
    search: source.search_context_cost_per_query || null,
    multimodal: {
      audioInM: toPerM(source.input_cost_per_audio_token),
      audioOutM: toPerM(source.output_cost_per_audio_token),
      audioInSec: toNum(source.input_cost_per_audio_per_second),
      audioOutSec: toNum(source.output_cost_per_audio_per_second),
      imageIn: toNum(source.input_cost_per_image),
      imageOut: toNum(source.output_cost_per_image),
      imageInM: toPerM(source.input_cost_per_image_token),
      imageOutM: toPerM(source.output_cost_per_image_token),
      videoInSec: toNum(source.input_cost_per_video_per_second),
      videoOutSec: toNum(source.output_cost_per_video_per_second),
      charIn: toNum(source.input_cost_per_character),
      charOut: toNum(source.output_cost_per_character),
      perQuery: toNum(source.input_cost_per_query),
      perRequest: toNum(source.input_cost_per_request)
    }
  }
}

const normalizeForDetail = (source = {}) => {
  if (isNestedPricing(source)) {
    return {
      kind: 'nested',
      pricing: source,
      meta: source,
      caps: source.capabilities || source
    }
  }
  return normalizeFlat(source)
}

const CAP_LABELS = [
  ['supports_vision', '视觉'],
  ['supports_function_calling', '工具'],
  ['supports_parallel_function_calling', '并行工具调用'],
  ['supports_tool_choice', '工具选择'],
  ['supports_prompt_caching', '缓存'],
  ['supports_reasoning', '推理'],
  ['supports_web_search', '搜索'],
  ['supports_response_schema', '结构化'],
  ['supports_system_messages', '系统消息'],
  ['supports_pdf_input', 'PDF 输入'],
  ['supports_native_streaming', '原生流式'],
  ['supports_service_tier', '服务档位'],
  ['supports_audio_input', '音频输入'],
  ['supports_audio_output', '音频输出'],
  ['supports_video_input', '视频输入'],
  ['supports_computer_use', '电脑使用'],
  ['supports_url_context', 'URL 上下文'],
  ['supports_assistant_prefill', '助手预填']
]

export const buildModelPricingDetailView = (name, source = {}) => {
  const normalized = normalizeForDetail(source || {})
  const meta = normalized.meta || {}

  const infoParts = []
  const provider = meta.litellm_provider || meta.provider || meta.modelGroup
  if (provider) infoParts.push(`模型组: ${provider}`)
  const maxOut = meta.max_output_tokens || meta.maxOutputTokens
  if (maxOut) infoParts.push(`最大输出: ${formatTokens(maxOut)}`)
  const maxIn = meta.max_input_tokens || meta.max_tokens || meta.maxInputTokens
  if (maxIn) infoParts.push(`最大输入: ${formatTokens(maxIn)}`)
  if (meta.mode) infoParts.push(`模式: ${meta.mode}`)
  if (meta.deprecation_date || meta.deprecationDate) {
    infoParts.push(`弃用: ${String(meta.deprecation_date || meta.deprecationDate).slice(0, 10)}`)
  }

  let baseLine = ''
  let baseParts = []
  let baseTiers = []
  const tierLines = []

  if (normalized.kind === 'nested') {
    const pricing = normalized.pricing || {}
    const baseRate = {
      input: toPerM(pricing.input_per_million_tokens),
      output: toPerM(pricing.output_per_million_tokens),
      cacheWrite5m: toPerM(pricing.cache_write_per_million_tokens),
      cacheWrite1h: effectiveCw1h(
        toPerM(pricing.cache_write_1h_per_million_tokens),
        toPerM(pricing.cache_write_per_million_tokens)
      ),
      cacheRead: toPerM(pricing.cache_read_per_million_tokens),
      reasoning: toPerM(pricing.reasoning_per_million_tokens)
    }
    baseParts = formatRateParts(baseRate)
    baseLine = formatRateLine(baseRate)
    baseTiers = (pricing.price_tiers || [])
      .map((tier) => {
        const rate = {
          input: toPerM(tier.input_per_million_tokens),
          output: toPerM(tier.output_per_million_tokens),
          cacheWrite5m: toPerM(tier.cache_write_per_million_tokens),
          cacheWrite1h: effectiveCw1h(
            toPerM(tier.cache_write_1h_per_million_tokens),
            toPerM(tier.cache_write_per_million_tokens)
          ),
          cacheRead: toPerM(tier.cache_read_per_million_tokens)
        }
        const parts = formatRateParts(rate)
        if (!parts.length) return null
        const thr = Number(tier.threshold) || 0
        return { label: `>${(thr / 1000).toFixed(0)}K`, text: formatRateLine(rate), parts }
      })
      .filter(Boolean)

    const addService = (label, obj) => {
      if (!obj) return
      const rate = {
        input: toPerM(obj.input_per_million_tokens ?? pricing.input_per_million_tokens),
        output: toPerM(obj.output_per_million_tokens ?? pricing.output_per_million_tokens),
        cacheWrite5m: toPerM(
          obj.cache_write_per_million_tokens ?? pricing.cache_write_per_million_tokens
        ),
        cacheWrite1h: effectiveCw1h(
          toPerM(obj.cache_write_1h_per_million_tokens),
          toPerM(obj.cache_write_per_million_tokens ?? pricing.cache_write_per_million_tokens)
        ),
        cacheRead: toPerM(obj.cache_read_per_million_tokens ?? pricing.cache_read_per_million_tokens)
      }
      const parts = formatRateParts(rate)
      if (parts.length) tierLines.push({ label, text: formatRateLine(rate), parts, tier: label })
      for (const tier of obj.price_tiers || []) {
        const thrRate = {
          input: toPerM(tier.input_per_million_tokens),
          output: toPerM(tier.output_per_million_tokens),
          cacheWrite5m: toPerM(tier.cache_write_per_million_tokens),
          cacheWrite1h: effectiveCw1h(
            toPerM(tier.cache_write_1h_per_million_tokens),
            toPerM(tier.cache_write_per_million_tokens)
          ),
          cacheRead: toPerM(tier.cache_read_per_million_tokens)
        }
        const thrParts = formatRateParts(thrRate)
        if (!thrParts.length) continue
        const thr = Number(tier.threshold) || 0
        tierLines.push({
          label: tier.estimated
            ? `  >${(thr / 1000).toFixed(0)}K (推导)`
            : `  >${(thr / 1000).toFixed(0)}K`,
          text: formatRateLine(thrRate),
          parts: thrParts,
          tier: label,
          estimated: Boolean(tier.estimated)
        })
      }
    }
    addService('Priority', pricing.priority_pricing)
    addService('Flex', pricing.flex_pricing)
  } else {
    baseParts = formatRateParts(normalized.base || {})
    baseLine = formatRateLine(normalized.base || {})
    baseTiers = (normalized.baseTiers || []).map((tier) => ({
      label: `>${(tier.threshold / 1000).toFixed(0)}K`,
      text: formatRateLine(tier),
      parts: formatRateParts(tier)
    }))

    const addService = (label, serviceRaw) => {
      if (!serviceRaw) return
      const service = synthesizeServiceTiers(
        serviceRaw,
        normalized.base,
        normalized.baseTiers
      )
      const rate = {
        input: service.input ?? normalized.base.input,
        output: service.output ?? normalized.base.output,
        cacheWrite5m: service.cacheWrite5m ?? normalized.base.cacheWrite5m,
        cacheWrite1h: service.cacheWrite1h ?? normalized.base.cacheWrite1h,
        cacheRead: service.cacheRead ?? normalized.base.cacheRead
      }
      const parts = formatRateParts(rate)
      if (parts.length) {
        tierLines.push({ label, text: formatRateLine(rate), parts, tier: label })
      }
      for (const tier of service.tiers || []) {
        const thrRate = {
          input: tier.input ?? service.input ?? normalized.base.input,
          output: tier.output ?? service.output ?? normalized.base.output,
          cacheWrite5m: tier.cacheWrite5m ?? service.cacheWrite5m ?? normalized.base.cacheWrite5m,
          cacheWrite1h: tier.cacheWrite1h ?? service.cacheWrite1h ?? normalized.base.cacheWrite1h,
          cacheRead: tier.cacheRead ?? service.cacheRead ?? normalized.base.cacheRead
        }
        const thrParts = formatRateParts(thrRate)
        if (!thrParts.length) continue
        tierLines.push({
          label: tier.estimated
            ? `  >${(tier.threshold / 1000).toFixed(0)}K (推导)`
            : `  >${(tier.threshold / 1000).toFixed(0)}K`,
          text: formatRateLine(thrRate),
          parts: thrParts,
          tier: label,
          estimated: Boolean(tier.estimated)
        })
      }
    }
    addService('Priority', normalized.priority)
    addService('Flex', normalized.flex)
    addService('Batch', normalized.batch)
  }

  const mmParts = []
  if (normalized.kind === 'flat') {
    const mm = normalized.multimodal || {}
    const pushMm = (label, perM, suffix = '') => {
      const money = formatPriceMoney(perM)
      if (money == null) return
      mmParts.push(`${label}: ${money}${suffix}`)
    }
    pushMm('音频输入', mm.audioInM, '/M')
    pushMm('音频输出', mm.audioOutM, '/M')
    if (mm.audioInSec != null) mmParts.push(`音频输入: ${formatPriceMoney(mm.audioInSec)}/s`)
    if (mm.audioOutSec != null) mmParts.push(`音频输出: ${formatPriceMoney(mm.audioOutSec)}/s`)
    if (mm.imageIn != null) mmParts.push(`图片输入: ${formatPriceMoney(mm.imageIn)}/张`)
    if (mm.imageOut != null) mmParts.push(`图片输出: ${formatPriceMoney(mm.imageOut)}/张`)
    pushMm('图片输入', mm.imageInM, '/M')
    pushMm('图片输出', mm.imageOutM, '/M')
    if (mm.videoInSec != null) mmParts.push(`视频输入: ${formatPriceMoney(mm.videoInSec)}/s`)
    if (mm.videoOutSec != null) mmParts.push(`视频输出: ${formatPriceMoney(mm.videoOutSec)}/s`)
    if (mm.perQuery != null) mmParts.push(`查询: ${formatPriceMoney(mm.perQuery)}/次`)
    if (mm.perRequest != null) mmParts.push(`请求: ${formatPriceMoney(mm.perRequest)}/次`)
  } else {
    const pricing = normalized.pricing || {}
    const sc = pricing.search_context_cost
    if (sc) {
      if (sc.low != null && sc.low !== '') mmParts.push(`搜索(低): $${sc.low}`)
      if (sc.medium != null && sc.medium !== '') mmParts.push(`搜索(中): $${sc.medium}`)
      if (sc.high != null && sc.high !== '') mmParts.push(`搜索(高): $${sc.high}`)
    }
  }
  const search = normalized.search
  if (search && typeof search === 'object') {
    if (search.search_context_size_low != null) mmParts.push(`搜索(低): $${search.search_context_size_low}`)
    if (search.search_context_size_medium != null)
      mmParts.push(`搜索(中): $${search.search_context_size_medium}`)
    if (search.search_context_size_high != null)
      mmParts.push(`搜索(高): $${search.search_context_size_high}`)
  }

  const caps = normalized.caps || {}
  const capabilityTags = []
  for (const [key, label] of CAP_LABELS) {
    if (caps[key]) capabilityTags.push(label)
  }
  const nestedCaps = caps.capabilities
  if (nestedCaps && typeof nestedCaps === 'object') {
    if (nestedCaps.vision) capabilityTags.push('视觉')
    if (nestedCaps.function_calling) capabilityTags.push('工具')
    if (nestedCaps.reasoning) capabilityTags.push('推理')
    if (nestedCaps.prompt_caching) capabilityTags.push('缓存')
    if (nestedCaps.web_search) capabilityTags.push('搜索')
    if (nestedCaps.service_tier) capabilityTags.push('服务档位')
  }
  const uniqueTags = [...new Set(capabilityTags)]

  const summaryLines = [`模型: ${name}`]
  if (infoParts.length) summaryLines.push(infoParts.join(' · '))
  if (baseLine) summaryLines.push(`基础价格: ${baseLine}`)
  for (const tier of baseTiers) summaryLines.push(`分段 ${tier.label}: ${tier.text}`)
  for (const line of tierLines) summaryLines.push(`${line.label}: ${line.text}`)
  if (mmParts.length) summaryLines.push(`多模态: ${mmParts.join(', ')}`)
  if (uniqueTags.length) summaryLines.push(`能力: ${uniqueTags.join('、')}`)

  return {
    name,
    infoParts,
    baseLine,
    baseParts,
    baseTiers,
    tierLines,
    multimodalLine: mmParts.join(', '),
    capabilityTags: uniqueTags,
    summaryText: summaryLines.join('\n')
  }
}
