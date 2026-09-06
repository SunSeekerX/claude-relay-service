import { logger } from '../../common/logger.js'
import { RedisKeys, LIMITS } from '../../infra/redis_key.js'
import * as modelPricingConvert from './pricing_model_pricing_convert.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let _redis = null
const getRedis = () => {
  if (!_redis) {
    _redis = require('../../infra/redis.js').redis
  }
  return _redis
}

/**
 * 模型服务
 * - 内置模型目录（/v1/models）
 * - 内部计费模型（从定价种子导入的完整模型数据，可编辑；有则计费优先）
 *
 * [人工决策-2026-08-24 20:52:04] 内部模型存完整记录（llysc 对齐的 pricing 结构），不是字段覆盖。
 * 外部 model_pricing.json 只作种子；计费/用户可见价：内部有完整 pricing 则用内部，否则回落种子。
 */
class ModelService {
  constructor() {
    this.supportedModels = this.getDefaultModels()
    // modelId -> 完整内部模型记录（或旧版瘦记录 {provider,mode,importedAt}）
    this.importedModels = new Map()
  }

  async initialize() {
    await this.loadImportedModels()

    const totalModels = Object.values(this.supportedModels).reduce((sum, config) => sum + config.models.length, 0)
    const billingCount = [...this.importedModels.values()].filter((record) =>
      modelPricingConvert.hasBillingPricing(record),
    ).length
    logger.success(
      `Model service initialized with ${totalModels} built-in + ${this.importedModels.size} internal models (${billingCount} with billing pricing)`,
    )
  }

  async loadImportedModels() {
    try {
      const client = getRedis().getClient()
      if (!client) {
        logger.warn('Redis 未连接，跳过内部模型目录加载')
        return
      }
      const stored = await client.hgetall(RedisKeys.importedModels)
      this.importedModels = new Map()
      for (const [modelId, raw] of Object.entries(stored || {})) {
        try {
          const parsed = JSON.parse(raw)
          // 兼容旧瘦记录：补 name，无 pricing 则不计费优先
          if (parsed && typeof parsed === 'object' && !parsed.name) {
            parsed.name = modelId
          }
          this.importedModels.set(modelId, parsed)
        } catch (error) {
          logger.warn(`内部模型条目解析失败，跳过 modelId=${modelId}`)
          console.error(error)
        }
      }
      logger.info(`已载入 ${this.importedModels.size} 个内部模型`)
    } catch (error) {
      logger.error('载入内部模型目录失败:', error)
      console.error(error)
    }
  }

  getDefaultModels() {
    return {
      claude: {
        provider: 'anthropic',
        description: 'Claude models from Anthropic',
        models: [
          'claude-opus-4-5-20251101',
          'claude-haiku-4-5-20251001',
          'claude-sonnet-4-5-20250929',
          'claude-opus-4-1-20250805',
          'claude-sonnet-4-20250514',
          'claude-opus-4-20250514',
          'claude-3-7-sonnet-20250219',
          'claude-3-5-sonnet-20241022',
          'claude-3-5-haiku-20241022',
          'claude-3-opus-20240229',
          'claude-3-haiku-20240307',
        ],
      },
      openai: {
        provider: 'openai',
        description: 'OpenAI GPT models',
        models: [
          'gpt-5.1-2025-11-13',
          'gpt-5.1-codex-mini',
          'gpt-5.1-codex',
          'gpt-5.1-codex-max',
          'gpt-5-2025-08-07',
          'gpt-5.3-codex',
          'gpt-5.3-codex-spark',
          'gpt-5.4',
          'gpt-5.4-pro',
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-5.6-luna',
          'gpt-6-astra',
          'gpt-6',
        ],
      },
      gemini: {
        provider: 'google',
        description: 'Google Gemini models',
        models: ['gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-flash'],
      },
    }
  }

  getBuiltInModelIds() {
    const builtIn = new Set()
    for (const config of Object.values(this.supportedModels)) {
      for (const modelId of config.models) {
        builtIn.add(modelId)
      }
    }
    return builtIn
  }

  getAllModels() {
    const models = []
    const now = Math.floor(Date.now() / 1000)
    const seen = new Set()

    for (const [_service, config] of Object.entries(this.supportedModels)) {
      for (const modelId of config.models) {
        seen.add(modelId)
        models.push({
          id: modelId,
          object: 'model',
          created: now,
          owned_by: config.provider,
        })
      }
    }

    for (const [modelId, meta] of this.importedModels) {
      if (seen.has(modelId)) {
        continue
      }
      seen.add(modelId)
      models.push({
        id: modelId,
        object: 'model',
        created: now,
        owned_by: meta.provider || 'imported',
      })
    }

    return models.sort((a, b) => {
      if (a.owned_by !== b.owned_by) {
        return a.owned_by.localeCompare(b.owned_by)
      }
      return a.id.localeCompare(b.id)
    })
  }

  getModelsByProvider(provider) {
    return this.getAllModels().filter((model) => model.owned_by === provider)
  }

  isModelSupported(modelId) {
    if (!modelId) {
      return false
    }
    return this.getAllModels().some((model) => model.id === modelId)
  }

  getModelProvider(modelId) {
    const model = this.getAllModels().find((item) => item.id === modelId)
    return model ? model.owned_by : null
  }

  // 取内部完整计费记录（无完整 pricing 返回 null，计费回落种子）
  getInternalBillingModel(modelName) {
    if (!modelName) {
      return null
    }
    let record = this.importedModels.get(modelName)
    if (!modelPricingConvert.hasBillingPricing(record)) {
      // 全名未命中时试 basename（兼容历史只存 basename 的内部模型）
      const base = modelPricingConvert.modelNameBasename(modelName)
      if (base && base !== modelName) {
        record = this.importedModels.get(base)
      }
    }
    if (!modelPricingConvert.hasBillingPricing(record)) {
      return null
    }
    return record
  }

  // 列出全部内部模型（含瘦记录），管理端用
  listInternalModels() {
    return [...this.importedModels.entries()]
      .map(([id, record]) => ({
        id,
        name: record.name || id,
        provider: record.provider || 'imported',
        mode: record.mode || 'chat',
        modelGroup: record.modelGroup || null,
        deprecationDate: record.deprecationDate || null,
        maxInputTokens: record.maxInputTokens ?? null,
        maxOutputTokens: record.maxOutputTokens ?? null,
        pricing: record.pricing || null,
        capabilities: record.capabilities || null,
        hasBilling: modelPricingConvert.hasBillingPricing(record),
        importedAt: record.importedAt || null,
        updatedAt: record.updatedAt || null,
      }))
      .sort((a, b) => {
        if (a.provider !== b.provider) {
          return a.provider.localeCompare(b.provider)
        }
        return a.id.localeCompare(b.id)
      })
  }

  getInternalModel(modelId) {
    let record = this.importedModels.get(modelId)
    if (!record) {
      const base = modelPricingConvert.modelNameBasename(modelId)
      if (base && base !== modelId) {
        record = this.importedModels.get(base)
      }
    }
    if (!record) {
      return null
    }
    return {
      id: modelId,
      name: record.name || modelId,
      provider: record.provider || 'imported',
      mode: record.mode || 'chat',
      modelGroup: record.modelGroup || null,
      deprecationDate: record.deprecationDate || null,
      maxInputTokens: record.maxInputTokens ?? null,
      maxOutputTokens: record.maxOutputTokens ?? null,
      pricing: record.pricing || null,
      capabilities: record.capabilities || null,
      metadata: record.metadata || null,
      hasBilling: modelPricingConvert.hasBillingPricing(record),
      importedAt: record.importedAt || null,
      updatedAt: record.updatedAt || null,
    }
  }

  /**
   * 可导入：种子里有、内部还没有完整计费数据的对话类模型。
   * 已有瘦记录（旧版只进目录）也算可导入，导入会升级为完整计费模型。
   */
  listImportableModels(pricingData) {
    const candidates = []

    for (const [modelId, meta] of Object.entries(pricingData || {})) {
      if (!meta || typeof meta !== 'object') {
        continue
      }
      if (!modelPricingConvert.isImportableMode(meta.mode)) {
        continue
      }
      const existing = this.importedModels.get(modelId)
      if (modelPricingConvert.hasBillingPricing(existing)) {
        continue
      }
      // 内置名也允许导入完整计费数据（覆盖仅目录语义，计费用内部）
      candidates.push({
        id: modelId,
        provider: modelPricingConvert.normalizeProvider(meta.litellm_provider),
        mode: meta.mode,
        maxTokens: meta.max_tokens || null,
        maxInputTokens: meta.max_input_tokens ?? null,
        inputCostPerToken: meta.input_cost_per_token ?? null,
        outputCostPerToken: meta.output_cost_per_token ?? null,
        upgrade: !!existing && !modelPricingConvert.hasBillingPricing(existing),
      })
    }

    return candidates.sort((a, b) => {
      if (a.provider !== b.provider) {
        return a.provider.localeCompare(b.provider)
      }
      return a.id.localeCompare(b.id)
    })
  }

  /**
   * 从定价种子导入完整模型数据（整模写入，不是字段覆盖）
   * 幂等：已有完整计费数据的跳过；瘦记录会被升级
   */
  async importModels(modelIds, pricingData) {
    if (!Array.isArray(modelIds) || modelIds.length === 0) {
      throw new Error('请至少选择一个模型')
    }

    const toWrite = {}
    const skipped = []
    const rejected = []
    const upgraded = []
    const now = new Date().toISOString()

    for (const modelId of new Set(modelIds)) {
      const trimmed = modelPricingConvert.cleanModelName(modelId)
      if (!trimmed) {
        continue
      }
      const meta = pricingData?.[trimmed] || pricingData?.[modelId]
      if (!meta) {
        skipped.push(trimmed)
        continue
      }
      if (!modelPricingConvert.isImportableMode(meta.mode)) {
        rejected.push(trimmed)
        continue
      }
      const existing = this.importedModels.get(trimmed)
      if (modelPricingConvert.hasBillingPricing(existing)) {
        skipped.push(trimmed)
        continue
      }

      const internal = modelPricingConvert.litellmToInternalModel(trimmed, meta)
      // 批量导入同样消毒 metadata，禁止外部价源敏感字段原样进 Redis
      internal.metadata = modelPricingConvert.sanitizeMetadataForStore(internal.metadata)
      internal.importedAt = existing?.importedAt || now
      internal.updatedAt = now
      toWrite[trimmed] = JSON.stringify(internal)
      if (existing && !modelPricingConvert.hasBillingPricing(existing)) {
        upgraded.push(trimmed)
      }
    }

    const writeCount = Object.keys(toWrite).length
    if (writeCount === 0) {
      const reason = rejected.length > 0 ? `（${rejected.length} 个非对话类模型被拒绝）` : ''
      return {
        imported: 0,
        skipped: skipped.length,
        rejected: rejected.length,
        upgraded: 0,
        message: `没有可导入的新模型${reason}`,
      }
    }

    const client = getRedis().getClientSafe()

    // 已有条目升级不增加条数
    const newKeys = Object.keys(toWrite).filter((key) => !this.importedModels.has(key))
    if (this.importedModels.size + newKeys.length > LIMITS.importedModels) {
      throw new Error(`导入后将超过模型目录上限 ${LIMITS.importedModels}（当前 ${this.importedModels.size}）`)
    }

    await client.hset(RedisKeys.importedModels, toWrite)
    await this.loadImportedModels()

    logger.info(
      `导入内部计费模型 ${writeCount} 个（升级 ${upgraded.length}），跳过 ${skipped.length}，拒收 ${rejected.length}`,
    )
    const rejectedNote = rejected.length > 0 ? `，拒收 ${rejected.length} 个非对话类模型` : ''
    const upgradeNote = upgraded.length > 0 ? `，升级 ${upgraded.length} 个旧目录项` : ''
    return {
      imported: writeCount,
      skipped: skipped.length,
      rejected: rejected.length,
      upgraded: upgraded.length,
      message: `导入 ${writeCount} 个完整计费模型，跳过 ${skipped.length} 个${upgradeNote}${rejectedNote}`,
    }
  }

  /**
   * 整模保存（创建或替换）。body 必须是完整内部模型，不是字段 patch。
   */
  async saveInternalModel(modelInput) {
    if (!modelInput || typeof modelInput !== 'object') {
      throw new Error('模型数据无效')
    }
    const name = modelPricingConvert.cleanModelName(modelInput.name || modelInput.id)
    if (!name) {
      throw new Error('模型名称不能为空')
    }
    if (!modelInput.pricing || typeof modelInput.pricing !== 'object') {
      throw new Error('pricing 不能为空，请提交完整模型数据')
    }
    // 校验数字字段，禁止 abc/NaN 抢占种子价
    const sanitizedPricing = modelPricingConvert.assertAndSanitizePricing(modelInput.pricing)

    const now = new Date().toISOString()
    const existing = this.importedModels.get(name)
    const record = {
      name,
      provider: modelInput.provider || existing?.provider || 'imported',
      mode: modelInput.mode || existing?.mode || 'chat',
      modelGroup: modelInput.modelGroup ?? existing?.modelGroup ?? null,
      deprecationDate: modelInput.deprecationDate ?? existing?.deprecationDate ?? null,
      maxInputTokens:
        modelInput.maxInputTokens !== undefined ? modelInput.maxInputTokens : (existing?.maxInputTokens ?? null),
      maxOutputTokens:
        modelInput.maxOutputTokens !== undefined ? modelInput.maxOutputTokens : (existing?.maxOutputTokens ?? null),
      // 整模替换 pricing / capabilities
      pricing: sanitizedPricing,
      capabilities: modelInput.capabilities ?? existing?.capabilities ?? {},
      metadata:
        modelInput.metadata !== undefined
          ? modelPricingConvert.sanitizeMetadataForStore(modelInput.metadata)
          : (existing?.metadata ?? null),
      hasBilling: true,
      importedAt: existing?.importedAt || now,
      updatedAt: now,
    }

    const client = getRedis().getClientSafe()
    if (!existing && this.importedModels.size + 1 > LIMITS.importedModels) {
      throw new Error(`超过模型目录上限 ${LIMITS.importedModels}`)
    }

    await client.hset(RedisKeys.importedModels, name, JSON.stringify(record))
    this.importedModels.set(name, record)
    logger.info(`保存内部计费模型 name=${name}`)
    return this.getInternalModel(name)
  }

  async createInternalModel(modelInput) {
    const name = modelPricingConvert.cleanModelName(modelInput?.name || modelInput?.id)
    if (!name) {
      throw new Error('模型名称不能为空')
    }
    if (this.importedModels.has(name) && modelPricingConvert.hasBillingPricing(this.importedModels.get(name))) {
      throw new Error(`模型已存在: ${name}`)
    }
    const base = modelPricingConvert.emptyInternalModel(name)
    return this.saveInternalModel({
      ...base,
      ...modelInput,
      name,
      pricing: modelInput?.pricing || base.pricing,
    })
  }

  /**
   * 从种子 LiteLLM 条目构建完整内部模型（不落库），供前端编辑弹窗预填。
   * 走 modelPricingConvert.litellmToInternalModel，保证分段/Priority/多模态不丢。
   */
  buildFromSeed(modelName, pricingData, { asCopy = false } = {}) {
    const trimmed = modelPricingConvert.cleanModelName(modelName)
    if (!trimmed) {
      throw new Error('模型名称不能为空')
    }
    const meta = pricingData?.[trimmed] || pricingData?.[modelName]
    if (!meta || typeof meta !== 'object') {
      throw new Error(`种子价表中没有模型: ${trimmed}`)
    }
    const internal = modelPricingConvert.litellmToInternalModel(trimmed, meta)
    if (asCopy) {
      internal.name = `${internal.name}-copy`
    }
    // 返回编辑器可用形态
    return {
      name: internal.name,
      provider: internal.provider,
      mode: internal.mode,
      modelGroup: internal.modelGroup,
      deprecationDate: internal.deprecationDate,
      maxInputTokens: internal.maxInputTokens,
      maxOutputTokens: internal.maxOutputTokens,
      pricing: internal.pricing,
      capabilities: internal.capabilities || {},
      metadata: modelPricingConvert.sanitizeMetadataForStore(internal.metadata || meta),
      hasBilling: true,
    }
  }

  async removeImportedModels(modelIds) {
    if (!Array.isArray(modelIds) || modelIds.length === 0) {
      throw new Error('请至少选择一个模型')
    }

    const targets = [...new Set(modelIds.map((id) => modelPricingConvert.cleanModelName(id)))].filter(
      (id) => id && this.importedModels.has(id),
    )

    if (targets.length === 0) {
      return { removed: 0, message: '没有可移除的内部模型' }
    }

    const client = getRedis().getClientSafe()
    await client.hdel(RedisKeys.importedModels, ...targets)
    await this.loadImportedModels()

    logger.info(`移除内部模型 ${targets.length} 个`)
    return { removed: targets.length, message: `已移除 ${targets.length} 个模型` }
  }

  getStatus() {
    const totalModels = Object.values(this.supportedModels).reduce((sum, config) => sum + config.models.length, 0)
    const billingCount = [...this.importedModels.values()].filter((record) =>
      modelPricingConvert.hasBillingPricing(record),
    ).length

    return {
      initialized: true,
      builtInModels: totalModels,
      importedModels: this.importedModels.size,
      internalBillingModels: billingCount,
      totalModels: this.getAllModels().length,
      providers: Object.keys(this.supportedModels),
    }
  }

  cleanup() {
    logger.debug('Model service cleanup (no-op)')
  }
}

export const modelService = new ModelService()
