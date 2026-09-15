import { redis } from '../../infra/redis.js'
import { logger } from '../../common/logger.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { GROK_MEDIA_FALLBACK_PRICING } from './pricing_grok_media_pricing.js'

// DEC_20260912_232856 Grok 媒体单价用 Redis 覆盖层，设置页可改，覆盖硬编码兜底
// DEC_20260913_005550 保存用 WATCH+版本 CAS；Pub/Sub 失效各实例 L1，避免并发覆盖与延迟生效

const ALLOWED_FLAT_FIELDS = [
  'input_cost_per_image',
  'output_cost_per_image',
  'input_cost_per_video_per_second',
  'output_cost_per_video_per_second',
  'input_cost_per_request',
  'input_cost_per_query',
]

const ALLOWED_TIER_FIELDS = ['xai_image_output_tiers', 'xai_video_output_tiers']
const MAX_SAVE_ATTEMPTS = 5

const toNonNegNumber = (value, fieldName) => {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`${fieldName} must be a non-negative number`)
  }
  return num
}

const deepClone = (value) => JSON.parse(JSON.stringify(value))

class GrokMediaPricingOverlayService {
  constructor() {
    this.CONFIG_KEY = RedisKeys.system.grokMediaPricing
    this.CHANGED_CHANNEL = RedisKeys.system.grokMediaPricingChangedChannel
    this.cached = null
    // 最近一次成功加载的覆盖层；TTL 过期或 Pub/Sub 失效后仍可用于同步计费，避免回落内置价错账
    this.lastKnown = null
    this.cacheExpiry = 0
    // Pub/Sub 负责跨实例即时失效；TTL 仅触发后台刷新
    this.CACHE_TTL = 5 * 1000
    this.subRedis = null
    this.subscribed = false
    this.refreshing = null
  }

  getBuiltinDefaults() {
    return deepClone(GROK_MEDIA_FALLBACK_PRICING)
  }

  getEmptyOverlay() {
    return {
      models: {},
      updatedAt: null,
      updatedBy: null,
    }
  }

  _invalidateLocalCache() {
    this.cached = null
    this.cacheExpiry = 0
    // 保留 lastKnown，同步计费在后台重载完成前仍用旧覆盖价，避免短暂回落内置价
  }

  _rememberOverlay(overlay) {
    this.cached = overlay
    this.lastKnown = overlay
    this.cacheExpiry = Date.now() + this.CACHE_TTL
  }

  // 解析 Redis 原文。
  // DEC_20260913_153908 非法 JSON/结构损坏均抛错，禁止记成空覆盖层冲掉 lastKnown；
  // 仅 key 不存在（raw 空）才返回空覆盖层。
  _parseOverlayRaw(raw) {
    if (!raw) {
      return this.getEmptyOverlay()
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      const parseError = new Error('invalid grok media pricing JSON in Redis')
      parseError.code = 'INVALID_OVERLAY_JSON'
      parseError.cause = error
      throw parseError
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const parseError = new Error('invalid grok media pricing structure in Redis')
      parseError.code = 'INVALID_OVERLAY_JSON'
      throw parseError
    }
    // models 必须是普通对象；缺失/null/数组/字符串均视为结构损坏
    if (
      !Object.prototype.hasOwnProperty.call(parsed, 'models') ||
      !parsed.models ||
      typeof parsed.models !== 'object' ||
      Array.isArray(parsed.models)
    ) {
      const parseError = new Error('invalid grok media pricing models field in Redis')
      parseError.code = 'INVALID_OVERLAY_JSON'
      throw parseError
    }
    return {
      models: parsed.models,
      updatedAt: parsed.updatedAt || null,
      updatedBy: parsed.updatedBy || null,
    }
  }

  async getOverlay() {
    try {
      if (this.cached && Date.now() < this.cacheExpiry) {
        return this.cached
      }

      const client = redis.getClientSafe()
      const raw = await client.get(this.CONFIG_KEY)
      const overlay = this._parseOverlayRaw(raw)
      this._rememberOverlay(overlay)
      return overlay
    } catch (error) {
      logger.error('获取 Grok 媒体计费覆盖层失败:', error)
      // 读失败/坏 JSON 时保留 lastKnown，避免把有效覆盖价永久换成空配置导致欠费
      if (this.lastKnown) {
        return this.lastKnown
      }
      return this.getEmptyOverlay()
    }
  }

  // 返回「内置兜底 + overlay」合并后的有效价表，以及元数据
  async getEffectiveConfig() {
    const overlay = await this.getOverlay()
    const builtin = this.getBuiltinDefaults()
    const models = {}

    for (const [name, pricing] of Object.entries(builtin)) {
      const override = overlay.models?.[name]
      models[name] = override ? this._mergeModelPricing(pricing, override) : deepClone(pricing)
    }

    return {
      models,
      builtin: this.getBuiltinDefaults(),
      overlay: overlay.models || {},
      updatedAt: overlay.updatedAt,
      updatedBy: overlay.updatedBy,
    }
  }

  async getEffectiveModelPricing(modelName) {
    if (!modelName || !GROK_MEDIA_FALLBACK_PRICING[modelName]) {
      return null
    }
    const overlay = await this.getOverlay()
    const builtin = GROK_MEDIA_FALLBACK_PRICING[modelName]
    const override = overlay.models?.[modelName]
    return override ? this._mergeModelPricing(builtin, override) : deepClone(builtin)
  }

  // 同步读取覆盖价。
  // DEC_20260913_153908 过期不回落内置价：继续用 lastKnown/cached，并后台刷新
  getEffectiveModelPricingSync(modelName) {
    if (!modelName || !GROK_MEDIA_FALLBACK_PRICING[modelName]) {
      return null
    }
    const builtin = GROK_MEDIA_FALLBACK_PRICING[modelName]
    const overlay = this.cached || this.lastKnown
    if (overlay) {
      if (!this.cached || Date.now() >= this.cacheExpiry) {
        this._refreshInBackground()
      }
      const override = overlay.models?.[modelName]
      return override ? this._mergeModelPricing(builtin, override) : deepClone(builtin)
    }
    // 冷启动尚未 warmCache：回落内置，并触发后台加载
    this._refreshInBackground()
    return deepClone(builtin)
  }

  _refreshInBackground() {
    if (this.refreshing) {
      return
    }
    this.refreshing = this.getOverlay()
      .catch((error) => {
        logger.warn('[GrokMediaPricing] background refresh failed')
        console.error(error)
      })
      .finally(() => {
        this.refreshing = null
      })
  }

  async saveOverlay(input, updatedBy = 'admin') {
    const models = this._sanitizeModels(input?.models)
    // DEC_20260913_153908 强制带 baseUpdatedAt（可为 null 表示空配置），禁止跳过版本校验
    if (!Object.prototype.hasOwnProperty.call(input || {}, 'baseUpdatedAt')) {
      const error = new Error('baseUpdatedAt is required')
      error.code = 'BAD_REQUEST'
      throw error
    }
    const baseUpdatedAt = input.baseUpdatedAt || null

    const txClient = redis.getClientSafe().duplicate()
    try {
      for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
        await txClient.watch(this.CONFIG_KEY)
        const raw = await txClient.get(this.CONFIG_KEY)
        let current
        try {
          current = this._parseOverlayRaw(raw)
        } catch (error) {
          // 坏 JSON：CAS 侧视为空，便于管理员用 baseUpdatedAt=null 覆盖修复
          logger.warn('[GrokMediaPricing] corrupt overlay during save, treating as empty for CAS')
          console.error(error)
          current = this.getEmptyOverlay()
        }

        if ((current.updatedAt || null) !== baseUpdatedAt) {
          await txClient.unwatch()
          const error = new Error('Grok 媒体计费已被其他会话更新，请重新加载后再保存')
          error.code = 'CONFLICT'
          throw error
        }

        const payload = {
          models,
          updatedAt: new Date().toISOString(),
          updatedBy,
        }
        const result = await txClient.multi().set(this.CONFIG_KEY, JSON.stringify(payload)).exec()
        if (result === null) {
          continue
        }

        this._rememberOverlay(payload)
        await this._publishChanged(payload.updatedAt)
        logger.info(
          `[GrokMediaPricing] overlay saved by ${updatedBy}, models=${Object.keys(models).join(',') || '(empty)'}`,
        )
        return this.getEffectiveConfig()
      }

      const error = new Error('保存 Grok 媒体计费失败：并发冲突过多，请重试')
      error.code = 'CONFLICT'
      throw error
    } finally {
      txClient.disconnect()
    }
  }

  async resetOverlay(updatedBy = 'admin', baseUpdatedAt = undefined) {
    // DEC_20260913_153908 重置也必须带版本，禁止无 CAS 删除
    if (baseUpdatedAt === undefined) {
      const error = new Error('baseUpdatedAt is required')
      error.code = 'BAD_REQUEST'
      throw error
    }
    const expectedUpdatedAt = baseUpdatedAt || null

    const txClient = redis.getClientSafe().duplicate()
    try {
      for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
        await txClient.watch(this.CONFIG_KEY)
        const raw = await txClient.get(this.CONFIG_KEY)
        let current
        try {
          current = this._parseOverlayRaw(raw)
        } catch (error) {
          logger.warn('[GrokMediaPricing] corrupt overlay during reset, treating as empty for CAS')
          console.error(error)
          current = this.getEmptyOverlay()
        }

        if ((current.updatedAt || null) !== expectedUpdatedAt) {
          await txClient.unwatch()
          const error = new Error('Grok 媒体计费已被其他会话更新，请重新加载后再重置')
          error.code = 'CONFLICT'
          throw error
        }

        const result = await txClient.multi().del(this.CONFIG_KEY).exec()
        if (result === null) {
          continue
        }

        const empty = this.getEmptyOverlay()
        this._rememberOverlay(empty)
        await this._publishChanged(new Date().toISOString())
        logger.info(`[GrokMediaPricing] overlay reset by ${updatedBy}`)
        return this.getEffectiveConfig()
      }

      const error = new Error('重置 Grok 媒体计费失败：并发冲突过多，请重试')
      error.code = 'CONFLICT'
      throw error
    } finally {
      txClient.disconnect()
    }
  }

  async _publishChanged(updatedAt) {
    try {
      const client = redis.getClient()
      if (!client) {
        return
      }
      await client.publish(this.CHANGED_CHANNEL, JSON.stringify({ updatedAt: updatedAt || null, at: Date.now() }))
    } catch (error) {
      logger.warn('[GrokMediaPricing] publish changed failed')
      console.error(error)
    }
  }

  _subscribePubSub() {
    if (this.subscribed) {
      return
    }
    try {
      const client = redis.getClient()
      if (!client) {
        return
      }
      this.subRedis = client.duplicate()
      this.subRedis.on('error', (error) => logger.error('[GrokMediaPricing] pub/sub error:', error))
      this.subRedis.subscribe(this.CHANGED_CHANNEL, (error) => {
        if (error) {
          logger.error('[GrokMediaPricing] pub/sub subscribe failed:', error)
        }
      })
      this.subRedis.on('message', (channel) => {
        if (channel === this.CHANGED_CHANNEL) {
          this._invalidateLocalCache()
          this.getOverlay().catch((error) => {
            logger.warn('[GrokMediaPricing] reload after pub/sub failed')
            console.error(error)
          })
        }
      })
      this.subscribed = true
    } catch (error) {
      logger.error('[GrokMediaPricing] pub/sub setup failed:', error)
    }
  }

  // 启动或保存后预热，让同步计费路径读到覆盖；并订阅跨实例失效
  async warmCache() {
    this._subscribePubSub()
    await this.getOverlay()
  }

  _mergeModelPricing(builtin, override) {
    const merged = deepClone(builtin)
    for (const field of ALLOWED_FLAT_FIELDS) {
      if (override[field] !== undefined) {
        merged[field] = override[field]
      }
    }
    for (const field of ALLOWED_TIER_FIELDS) {
      if (override[field] && typeof override[field] === 'object') {
        merged[field] = {
          ...(merged[field] || {}),
          ...override[field],
        }
      }
    }
    return merged
  }

  _sanitizeModels(modelsInput) {
    if (modelsInput === undefined || modelsInput === null) {
      return {}
    }
    if (typeof modelsInput !== 'object' || Array.isArray(modelsInput)) {
      throw new Error('models must be an object')
    }

    const allowedNames = new Set(Object.keys(GROK_MEDIA_FALLBACK_PRICING))
    const cleaned = {}

    for (const [name, raw] of Object.entries(modelsInput)) {
      if (!allowedNames.has(name)) {
        throw new Error(`unknown grok media model: ${name}`)
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`invalid pricing for ${name}`)
      }

      const entry = {}
      for (const field of ALLOWED_FLAT_FIELDS) {
        if (raw[field] !== undefined && raw[field] !== null && raw[field] !== '') {
          entry[field] = toNonNegNumber(raw[field], `${name}.${field}`)
        }
      }
      for (const field of ALLOWED_TIER_FIELDS) {
        if (raw[field] === undefined || raw[field] === null) {
          continue
        }
        if (typeof raw[field] !== 'object' || Array.isArray(raw[field])) {
          throw new Error(`${name}.${field} must be an object`)
        }
        const tiers = {}
        for (const [tierKey, tierValue] of Object.entries(raw[field])) {
          if (tierValue === undefined || tierValue === null || tierValue === '') {
            continue
          }
          tiers[String(tierKey)] = toNonNegNumber(tierValue, `${name}.${field}.${tierKey}`)
        }
        if (Object.keys(tiers).length > 0) {
          entry[field] = tiers
        }
      }

      if (Object.keys(entry).length > 0) {
        cleaned[name] = entry
      }
    }

    return cleaned
  }
}

export const grokMediaPricingOverlayService = new GrokMediaPricingOverlayService()
