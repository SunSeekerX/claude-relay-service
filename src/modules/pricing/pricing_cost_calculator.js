import { pricingService } from './pricing_service.js'
import { logger } from '../../common/logger.js'
const warnedDetailedPricingFallbackModels = new Set()

// Claude模型价格配置 (USD per 1M tokens) - 备用定价
const MODEL_PRICING = {
  // Claude 3.5 Sonnet
  'claude-3-5-sonnet-20241022': {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  'claude-sonnet-4-20250514': {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  'claude-sonnet-4-5-20250929': {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },

  // Claude 3.5 Haiku
  'claude-3-5-haiku-20241022': {
    input: 0.25,
    output: 1.25,
    cacheWrite: 0.3,
    cacheRead: 0.03,
  },

  // Claude 3 Opus
  'claude-3-opus-20240229': {
    input: 15.0,
    output: 75.0,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },

  // Claude Opus 4.1 (新模型)
  'claude-opus-4-1-20250805': {
    input: 15.0,
    output: 75.0,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },

  // Claude 3 Sonnet
  'claude-3-sonnet-20240229': {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },

  // Claude 3 Haiku
  'claude-3-haiku-20240307': {
    input: 0.25,
    output: 1.25,
    cacheWrite: 0.3,
    cacheRead: 0.03,
  },

  // 默认定价（用于未知模型）
  unknown: {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
}

export class CostCalculator {
  static isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value)
  }

  // 走 pricingService 详细定价的条件。除 5m/1h 缓存明细与 [1m] 长上下文外还有两类：
  // ① 带 service_tier——legacy 分支的档位处理不含长上下文维度；
  // ② 总输入超过最小长上下文档阈值——legacy 分支只读基础价字段，
  //    gpt-5.4/5.5/5.6 等的 above_272k 档会被整单漏掉（长请求越大漏收越多）
  static isDetailedPricingRequest(usage, model = 'unknown', serviceTier = null) {
    const totalInputTokens =
      (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)

    const hasUnitUsage =
      Number(usage.image_count) > 0 ||
      Number(usage.num_images) > 0 ||
      Number(usage.output_images) > 0 ||
      Number(usage.input_image_count) > 0 ||
      Number(usage.request_count) > 0 ||
      Number(usage.query_count) > 0 ||
      Number(usage.audio_input_seconds) > 0 ||
      Number(usage.input_audio_seconds) > 0 ||
      Number(usage.audio_output_seconds) > 0 ||
      Number(usage.output_audio_seconds) > 0 ||
      Number(usage.video_input_seconds) > 0 ||
      Number(usage.input_video_seconds) > 0 ||
      Number(usage.video_output_seconds) > 0 ||
      Number(usage.output_video_seconds) > 0

    return (
      (usage.cache_creation && typeof usage.cache_creation === 'object') ||
      (typeof model === 'string' && model.includes('[1m]')) ||
      (typeof serviceTier === 'string' && serviceTier.trim() !== '') ||
      totalInputTokens > pricingService.minContextTierThreshold ||
      // Claude fast mode / 1M beta 信号只有详细分支认，漏判会整单丢掉倍率
      pricingService.hasClaudeBillingSignal(usage) ||
      // 按图/按次等非 token 量走详细分支，保证与 pricingService 单价字段一致
      hasUnitUsage
    )
  }

  static isValidPricingServiceResult(result) {
    return (
      result &&
      result.hasPricing === true &&
      result.pricing &&
      this.isFiniteNumber(result.pricing.input) &&
      this.isFiniteNumber(result.pricing.output) &&
      this.isFiniteNumber(result.pricing.cacheCreate) &&
      this.isFiniteNumber(result.pricing.cacheRead) &&
      this.isFiniteNumber(result.inputCost) &&
      this.isFiniteNumber(result.outputCost) &&
      this.isFiniteNumber(result.cacheCreateCost) &&
      this.isFiniteNumber(result.cacheReadCost) &&
      this.isFiniteNumber(result.totalCost)
    )
  }

  // 溢价档判定（白名单，禁黑名单）：未知 tier 一律按基础价。
  // 与 pricingService._resolveServiceTierSuffix 同口径，两处白名单必须同步改：
  // ① ultrafast 受控档、官方未公开价，暂按 Fast(_priority) 计费，不认它会整单按基础价漏收；
  // ② scale 不是溢价档（Scale Tier 是预购 TPM/RPM 容量，与 Fast 独立计费、溢出也不转 Fast），
  //    按基础价——理由详见 pricingService._resolveServiceTierSuffix 的人工决策注释
  static isPriorityServiceTier(serviceTier) {
    const tier = typeof serviceTier === 'string' ? serviceTier.trim().toLowerCase() : ''
    return tier === 'priority' || tier === 'fast' || tier === 'ultrafast'
  }

  static isFlexServiceTier(serviceTier) {
    return (typeof serviceTier === 'string' ? serviceTier.trim().toLowerCase() : '') === 'flex'
  }

  static isOpenAIModel(model, pricingData = null) {
    if (typeof model === 'string' && (model.includes('gpt') || model.includes('o1'))) {
      return true
    }

    return pricingData?.litellm_provider === 'openai'
  }

  static getPricingSource(model, pricingData) {
    if (pricingData) {
      return 'dynamic'
    }

    if (MODEL_PRICING[model]) {
      return 'static'
    }

    return 'unknown-fallback'
  }

  static logDetailedPricingFallback(model, usage, result) {
    const warnKey = typeof model === 'string' && model ? model : 'unknown'

    if (warnedDetailedPricingFallbackModels.has(warnKey)) {
      return
    }

    warnedDetailedPricingFallbackModels.add(warnKey)

    const hasDetailedCache = !!(usage.cache_creation && typeof usage.cache_creation === 'object')
    const isLongContextModel = typeof model === 'string' && model.includes('[1m]')

    logger.warn(
      `💰 Missing detailed pricing for model ${warnKey}; using fallback pricing ` +
        `(hasPricing=${result?.hasPricing === true}, cacheCreation=${hasDetailedCache}, longContext=${isLongContextModel})`,
    )
  }

  static buildDetailedPricingResult(usage, model, result, serviceTier = null) {
    return {
      model,
      pricing: {
        input: result.pricing.input * 1000000, // 转换为 per 1M tokens
        output: result.pricing.output * 1000000,
        cacheWrite: result.pricing.cacheCreate * 1000000,
        cacheRead: result.pricing.cacheRead * 1000000,
      },
      usingDynamicPricing: true,
      isLongContextRequest: result.isLongContextRequest || false,
      usage: {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheCreateTokens: usage.cache_creation_input_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        totalTokens:
          (usage.input_tokens || 0) +
          (usage.output_tokens || 0) +
          (usage.cache_creation_input_tokens || 0) +
          (usage.cache_read_input_tokens || 0),
      },
      costs: {
        input: result.inputCost,
        output: result.outputCost,
        cacheCreate: result.cacheCreateCost,
        cacheWrite: result.cacheCreateCost,
        cacheRead: result.cacheReadCost,
        ephemeral5m: result.ephemeral5mCost || 0,
        ephemeral1h: result.ephemeral1hCost || 0,
        imageOutput: result.imageOutputCost || 0,
        imageInput: result.imageInputCost || 0,
        unit: result.unitCost || 0,
        total: result.totalCost,
      },
      formatted: {
        input: this.formatCost(result.inputCost),
        output: this.formatCost(result.outputCost),
        cacheCreate: this.formatCost(result.cacheCreateCost),
        cacheWrite: this.formatCost(result.cacheCreateCost),
        cacheRead: this.formatCost(result.cacheReadCost),
        ephemeral5m: this.formatCost(result.ephemeral5mCost || 0),
        ephemeral1h: this.formatCost(result.ephemeral1hCost || 0),
        total: this.formatCost(result.totalCost),
      },
      debug: {
        isOpenAIModel: this.isOpenAIModel(model),
        hasCacheCreatePrice: !!result.pricing.cacheCreate,
        cacheCreateTokens: usage.cache_creation_input_tokens || 0,
        cacheWritePriceUsed: result.pricing.cacheCreate * 1000000,
        isLongContextModel: typeof model === 'string' && model.includes('[1m]'),
        isLongContextRequest: result.isLongContextRequest || false,
        usedFallbackPricing: false,
        pricingSource: 'dynamic',
        serviceTier: serviceTier || null,
      },
    }
  }

  static buildLegacyCostResult(usage, model = 'unknown', serviceTier = null, options = {}) {
    const safeModel = typeof model === 'string' && model ? model : 'unknown'

    const inputTokens = usage.input_tokens || 0
    const outputTokens = usage.output_tokens || 0
    const cacheCreateTokens = usage.cache_creation_input_tokens || 0
    const cacheReadTokens = usage.cache_read_input_tokens || 0

    const pricingData = pricingService.getModelPricing(safeModel)
    const pricingSource = this.getPricingSource(safeModel, pricingData)
    let pricing
    let usingDynamicPricing = false

    if (pricingData) {
      // 溢价档白名单（判定见 isPriorityServiceTier：priority/fast/ultrafast，scale 不算）。
      // 不再要求 supports_service_tier——该字段在定价源里只有个别模型带，
      // 以它为门会让绝大多数已配 *_priority 价的模型按基础价少收；有档位价即视为支持
      const usePriority = this.isPriorityServiceTier(serviceTier)
      // flex 是折扣档，漏了会按基础价多收
      const useFlex = this.isFlexServiceTier(serviceTier)
      // 档位字段后缀，无命中则读基础字段
      const tierSuffix = usePriority ? '_priority' : useFlex ? '_flex' : ''
      const tierPrice = (baseField) =>
        ((tierSuffix && pricingData[`${baseField}${tierSuffix}`]) || pricingData[baseField] || 0) * 1000000

      const inputPrice = tierPrice('input_cost_per_token')
      const outputPrice = tierPrice('output_cost_per_token')
      const cacheReadPrice = tierPrice('cache_read_input_token_cost')

      let cacheWritePrice = tierPrice('cache_creation_input_token_cost')

      if (
        this.isOpenAIModel(safeModel, pricingData) &&
        !pricingData.cache_creation_input_token_cost &&
        cacheCreateTokens > 0
      ) {
        cacheWritePrice = inputPrice
      }

      pricing = {
        input: inputPrice,
        output: outputPrice,
        cacheWrite: cacheWritePrice,
        cacheRead: cacheReadPrice,
      }
      usingDynamicPricing = true
    } else {
      pricing = MODEL_PRICING[safeModel] || MODEL_PRICING['unknown']
    }

    // 图片模型常见：只有 output_cost_per_image_token，无 output_cost_per_token
    if ((!pricing.output || pricing.output === 0) && pricingData?.output_cost_per_image_token) {
      pricing.output = pricingData.output_cost_per_image_token * 1000000
    }
    if ((!pricing.input || pricing.input === 0) && pricingData?.input_cost_per_image_token) {
      pricing.input = pricingData.input_cost_per_image_token * 1000000
    }

    const inputCost = (inputTokens / 1000000) * pricing.input
    const outputCost = (outputTokens / 1000000) * pricing.output
    const cacheWriteCost = (cacheCreateTokens / 1000000) * pricing.cacheWrite
    const cacheReadCost = (cacheReadTokens / 1000000) * pricing.cacheRead

    // 非 token 单价（与 pricingService._buildCostResult 对齐）
    const countOf = (...keys) => {
      for (const key of keys) {
        const num = Number(usage[key])
        if (Number.isFinite(num) && num > 0) {
          return num
        }
      }
      return 0
    }
    const imageOutCount = countOf('image_count', 'num_images', 'output_images')
    const imageInCount = countOf('input_image_count', 'input_images')
    const requestCount = countOf('request_count', 'num_requests')
    const queryCount = countOf('query_count', 'num_queries')
    const audioInSec = countOf('audio_input_seconds', 'input_audio_seconds')
    const audioOutSec = countOf('audio_output_seconds', 'output_audio_seconds')
    const videoInSec = countOf('video_input_seconds', 'input_video_seconds')
    const videoOutSec = countOf('video_output_seconds', 'output_video_seconds')
    const imageOutputCost = imageOutCount * (Number(pricingData?.output_cost_per_image) || 0)
    const imageInputCost = imageInCount * (Number(pricingData?.input_cost_per_image) || 0)
    const requestCost = requestCount * (Number(pricingData?.input_cost_per_request) || 0)
    const queryCost = queryCount * (Number(pricingData?.input_cost_per_query) || 0)
    const audioInputCost =
      audioInSec * (Number(pricingData?.input_cost_per_audio_per_second ?? pricingData?.input_cost_per_second) || 0)
    const audioOutputCost =
      audioOutSec * (Number(pricingData?.output_cost_per_audio_per_second ?? pricingData?.output_cost_per_second) || 0)
    const videoInputCost = videoInSec * (Number(pricingData?.input_cost_per_video_per_second) || 0)
    const videoOutputCost = videoOutSec * (Number(pricingData?.output_cost_per_video_per_second) || 0)
    const unitCost =
      imageOutputCost +
      imageInputCost +
      requestCost +
      queryCost +
      audioInputCost +
      audioOutputCost +
      videoInputCost +
      videoOutputCost

    const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost + unitCost

    return {
      model: safeModel,
      pricing,
      usingDynamicPricing,
      usage: {
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        imageOutCount,
        totalTokens: inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens,
      },
      costs: {
        input: inputCost,
        output: outputCost,
        cacheCreate: cacheWriteCost,
        cacheWrite: cacheWriteCost,
        cacheRead: cacheReadCost,
        ephemeral5m: 0,
        ephemeral1h: 0,
        imageOutput: imageOutputCost,
        imageInput: imageInputCost,
        unit: unitCost,
        total: totalCost,
      },
      formatted: {
        input: this.formatCost(inputCost),
        output: this.formatCost(outputCost),
        cacheCreate: this.formatCost(cacheWriteCost),
        cacheWrite: this.formatCost(cacheWriteCost),
        cacheRead: this.formatCost(cacheReadCost),
        ephemeral5m: this.formatCost(0),
        ephemeral1h: this.formatCost(0),
        total: this.formatCost(totalCost),
      },
      debug: {
        isOpenAIModel: this.isOpenAIModel(safeModel, pricingData),
        hasCacheCreatePrice: !!pricingData?.cache_creation_input_token_cost,
        cacheCreateTokens,
        cacheWritePriceUsed: pricing.cacheWrite,
        isLongContextModel: typeof safeModel === 'string' && safeModel.includes('[1m]'),
        isLongContextRequest: false,
        usedFallbackPricing: options.usedFallbackPricing === true || pricingSource === 'unknown-fallback',
        pricingSource,
        serviceTier: serviceTier || null,
      },
    }
  }

  /**
   * 计算单次请求的费用
   * @param {Object} usage - 使用量数据
   * @param {number} usage.input_tokens - 输入token数量
   * @param {number} usage.output_tokens - 输出token数量
   * @param {number} usage.cache_creation_input_tokens - 缓存创建token数量
   * @param {number} usage.cache_read_input_tokens - 缓存读取token数量
   * @param {string} model - 模型名称
   * @returns {Object} 费用详情
   */
  static calculateCost(usage, model = 'unknown', serviceTier = null) {
    // 如果 usage 包含详细的 cache_creation 对象、是 1M 模型或带 service_tier，优先使用 pricingService
    if (this.isDetailedPricingRequest(usage, model, serviceTier)) {
      const result = pricingService.calculateCost(usage, model, serviceTier)
      if (this.isValidPricingServiceResult(result)) {
        return this.buildDetailedPricingResult(usage, model, result, serviceTier)
      }

      this.logDetailedPricingFallback(model, usage, result)

      return this.buildLegacyCostResult(usage, model, serviceTier, {
        usedFallbackPricing: true,
      })
    }

    return this.buildLegacyCostResult(usage, model, serviceTier)
  }

  /**
   * 计算聚合使用量的费用
   * @param {Object} aggregatedUsage - 聚合使用量数据
   * @param {string} model - 模型名称
   * @returns {Object} 费用详情
   */
  static calculateAggregatedCost(aggregatedUsage, model = 'unknown') {
    const usage = {
      input_tokens: aggregatedUsage.inputTokens || aggregatedUsage.totalInputTokens || 0,
      output_tokens: aggregatedUsage.outputTokens || aggregatedUsage.totalOutputTokens || 0,
      cache_creation_input_tokens: aggregatedUsage.cacheCreateTokens || aggregatedUsage.totalCacheCreateTokens || 0,
      cache_read_input_tokens: aggregatedUsage.cacheReadTokens || aggregatedUsage.totalCacheReadTokens || 0,
    }

    // 如果有 ephemeral 拆分数据，构建 cache_creation 子对象
    const eph5m = aggregatedUsage.ephemeral5mTokens || aggregatedUsage.totalEphemeral5mTokens || 0
    const eph1h = aggregatedUsage.ephemeral1hTokens || aggregatedUsage.totalEphemeral1hTokens || 0
    if (eph5m > 0 || eph1h > 0) {
      usage.cache_creation = {
        ephemeral_5m_input_tokens: eph5m,
        ephemeral_1h_input_tokens: eph1h,
      }
    }

    return this.calculateCost(usage, model)
  }

  /**
   * 获取模型定价信息
   * @param {string} model - 模型名称
   * @returns {Object} 定价信息
   */
  static getModelPricing(model = 'unknown') {
    // 特殊处理：gpt-5.5 回退到 gpt-5（如果没有专门定价）
    if (model === 'gpt-5.5' && !MODEL_PRICING['gpt-5.5']) {
      const gpt5Pricing = MODEL_PRICING['gpt-5']
      if (gpt5Pricing) {
        console.log(`Using gpt-5 pricing as fallback for ${model}`)
        return gpt5Pricing
      }
    }
    // 特殊处理：gpt-5.6 系列（sol/terra/luna）在收录专门定价前回退到 gpt-5
    if (model.startsWith('gpt-5.6') && !MODEL_PRICING[model]) {
      const gpt5Pricing = MODEL_PRICING['gpt-5']
      if (gpt5Pricing) {
        console.log(`Using gpt-5 pricing as fallback for ${model}`)
        return gpt5Pricing
      }
    }
    return MODEL_PRICING[model] || MODEL_PRICING['unknown']
  }

  /**
   * 获取所有支持的模型和定价
   * @returns {Object} 所有模型定价
   */
  static getAllModelPricing() {
    return { ...MODEL_PRICING }
  }

  /**
   * 验证模型是否支持
   * @param {string} model - 模型名称
   * @returns {boolean} 是否支持
   */
  static isModelSupported(model) {
    return !!MODEL_PRICING[model]
  }

  /**
   * 格式化费用显示
   * @param {number} cost - 费用金额
   * @param {number} decimals - 小数位数
   * @returns {string} 格式化的费用字符串
   */

  // 从模型用量聚合桶解析费用（支持混合桶）
  // stats: tokens 合计 + realCostMicro/ratedCostMicro + costedRequests + costedXxxTokens
  // 返回 { real, rated, total, source: recorded|hybrid|recalculated, costs, formatted }
  static resolveModelStatsCost(stats, model = 'unknown') {
    const toInt = (v) => parseInt(v, 10) || 0
    const inputTokens = toInt(stats.inputTokens)
    const outputTokens = toInt(stats.outputTokens)
    const cacheCreateTokens = toInt(stats.cacheCreateTokens)
    const cacheReadTokens = toInt(stats.cacheReadTokens)
    const ephemeral5mTokens = toInt(stats.ephemeral5mTokens)
    const ephemeral1hTokens = toInt(stats.ephemeral1hTokens)
    const _requests = toInt(stats.requests)
    const realCostMicro = toInt(stats.realCostMicro)
    const ratedCostMicro = toInt(stats.ratedCostMicro)
    const costedRequests = toInt(stats.costedRequests)
    const costedInputTokens = toInt(stats.costedInputTokens)
    const costedOutputTokens = toInt(stats.costedOutputTokens)
    const costedCacheCreateTokens = toInt(stats.costedCacheCreateTokens)
    const costedCacheReadTokens = toInt(stats.costedCacheReadTokens)
    const costedEphemeral5mTokens = toInt(stats.costedEphemeral5mTokens)
    const costedEphemeral1hTokens = toInt(stats.costedEphemeral1hTokens)

    const recordedReal = realCostMicro / 1000000
    const recordedRated = ratedCostMicro > 0 ? ratedCostMicro / 1000000 : recordedReal
    const hasMicro = realCostMicro > 0 || ratedCostMicro > 0
    const _totalTokenSum = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
    const costedTokenSum =
      costedInputTokens +
      costedOutputTokens +
      costedCacheCreateTokens +
      costedCacheReadTokens +
      costedEphemeral5mTokens +
      costedEphemeral1hTokens

    const buildUsage = (input, output, cacheCreate, cacheRead, eph5m, eph1h) => {
      const usage = {
        input_tokens: Math.max(0, input),
        output_tokens: Math.max(0, output),
        cache_creation_input_tokens: Math.max(0, cacheCreate),
        cache_read_input_tokens: Math.max(0, cacheRead),
      }
      if (eph5m > 0 || eph1h > 0) {
        usage.cache_creation = {
          ephemeral_5m_input_tokens: Math.max(0, eph5m),
          ephemeral_1h_input_tokens: Math.max(0, eph1h),
        }
      }
      return usage
    }

    const pack = (real, rated, source, extra = {}) => ({
      real,
      rated,
      total: real,
      source,
      formatted: { total: this.formatCost(real) },
      pricing: extra.pricing || null,
      costs: {
        input: 0,
        output: 0,
        cacheCreate: 0,
        cacheWrite: 0,
        cacheRead: 0,
        ephemeral5m: 0,
        ephemeral1h: 0,
        total: real,
        real,
        rated,
        ...(extra.costs || {}),
      },
    })

    const fullRecalc = () => {
      const result = this.calculateCost(
        buildUsage(inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, ephemeral5mTokens, ephemeral1hTokens),
        model,
      )
      const { total } = result.costs
      return pack(total, total, 'recalculated', {
        pricing: result.pricing,
        costs: result.costs,
      })
    }

    // 有 costed 标记（含纯媒体：costedRequests>0 且 costed token 全 0）→ 拆未结算 token
    // 关键：历史文本无标记 + 新图片只写 micro/costedRequests → 不得整桶只认 micro
    if (costedRequests > 0 || costedTokenSum > 0) {
      let uncostedIn
      let uncostedOut
      let uncostedCc
      let uncostedCr
      let uncosted5m
      let uncosted1h

      if (costedTokenSum > 0) {
        // 有 token 台账：未结算 = 合计 − 已结算
        uncostedIn = Math.max(0, inputTokens - costedInputTokens)
        uncostedOut = Math.max(0, outputTokens - costedOutputTokens)
        uncostedCc = Math.max(0, cacheCreateTokens - costedCacheCreateTokens)
        uncostedCr = Math.max(0, cacheReadTokens - costedCacheReadTokens)
        uncosted5m = Math.max(0, ephemeral5mTokens - costedEphemeral5mTokens)
        uncosted1h = Math.max(0, ephemeral1hTokens - costedEphemeral1hTokens)
      } else {
        // 纯媒体等「已结算但 0 token」：桶内全部 token 都是升级前未标记历史
        uncostedIn = inputTokens
        uncostedOut = outputTokens
        uncostedCc = cacheCreateTokens
        uncostedCr = cacheReadTokens
        uncosted5m = ephemeral5mTokens
        uncosted1h = ephemeral1hTokens
      }

      const uncostedTokenSum = uncostedIn + uncostedOut + uncostedCc + uncostedCr
      let uncostedTotal = 0
      if (uncostedTokenSum > 0 || uncosted5m > 0 || uncosted1h > 0) {
        uncostedTotal = this.calculateCost(
          buildUsage(uncostedIn, uncostedOut, uncostedCc, uncostedCr, uncosted5m, uncosted1h),
          model,
        ).costs.total
      }

      const real = recordedReal + uncostedTotal
      const rated = recordedRated + uncostedTotal
      const source = uncostedTokenSum > 0 || uncosted5m > 0 || uncosted1h > 0 ? 'hybrid' : 'recorded'
      return pack(real, rated, source)
    }

    // 旧数据：只有 micro（当时 realCost>0 才写）→ 整桶按已存费用
    if (hasMicro) {
      return pack(recordedReal, recordedRated, 'recorded')
    }

    return fullRecalc()
  }

  static formatCost(cost, decimals = 6) {
    if (cost >= 1) {
      return `$${cost.toFixed(2)}`
    } else if (cost >= 0.001) {
      return `$${cost.toFixed(4)}`
    } else {
      return `$${cost.toFixed(decimals)}`
    }
  }

  /**
   * 计算费用节省（使用缓存的节省）
   * @param {Object} usage - 使用量数据
   * @param {string} model - 模型名称
   * @returns {Object} 节省信息
   */
  static calculateCacheSavings(usage, model = 'unknown') {
    const pricing = this.getModelPricing(model) // 已包含 gpt-5.5 回退逻辑
    const cacheReadTokens = usage.cache_read_input_tokens || 0

    // 如果这些token不使用缓存，需要按正常input价格计费
    const normalCost = (cacheReadTokens / 1000000) * pricing.input
    const cacheCost = (cacheReadTokens / 1000000) * pricing.cacheRead
    const savings = normalCost - cacheCost
    const savingsPercentage = normalCost > 0 ? (savings / normalCost) * 100 : 0

    return {
      normalCost,
      cacheCost,
      savings,
      savingsPercentage,
      formatted: {
        normalCost: this.formatCost(normalCost),
        cacheCost: this.formatCost(cacheCost),
        savings: this.formatCost(savings),
        savingsPercentage: `${savingsPercentage.toFixed(1)}%`,
      },
    }
  }
}
