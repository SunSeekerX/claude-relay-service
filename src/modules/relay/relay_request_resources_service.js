import { requestResourcesConfig } from '../../../config/request_resources.js'
import { redis } from '../../infra/redis.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { createRequestResourceBudget } from '../../infra/middleware_request_resources.js'
import { parseBody, z } from '../../common/parse_body.js'
import { logger } from '../../common/logger.js'

const MIB = 1024 * 1024
const limitsSchema = z
  .object({
    maxRequests: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    maxInflightBodyMiB: z
      .number()
      .int()
      .nonnegative()
      .max(Math.floor(Number.MAX_SAFE_INTEGER / MIB)),
  })
  .strict()
const recordSchema = limitsSchema.extend({
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
})

export class RelayRequestResourcesService {
  constructor() {
    this.budget = createRequestResourceBudget(requestResourcesConfig)
    this.config = {
      maxRequests: 0,
      maxInflightBodyMiB: 0,
      version: 0,
      updatedAt: null,
      updatedBy: null,
    }
    this.subscriber = null
    this.syncTimer = null
  }

  _apply(config) {
    if (config.version < this.config.version) {
      return
    }
    this.config = config
    this.budget.setLimits({
      maxRequests: config.maxRequests,
      maxInflightBodyBytes: config.maxInflightBodyMiB * MIB,
    })
  }

  async reload() {
    const raw = await redis.getClientSafe().hgetall(RedisKeys.relayRequestResources.config)
    const config = Object.keys(raw).length
      ? recordSchema.parse({
          maxRequests: Number(raw.maxRequests),
          maxInflightBodyMiB: Number(raw.maxInflightBodyMiB),
          version: Number(raw.version),
          updatedAt: raw.updatedAt,
          updatedBy: raw.updatedBy,
        })
      : { maxRequests: 0, maxInflightBodyMiB: 0, version: 0, updatedAt: null, updatedBy: null }
    this._apply(config)
    return this.getSnapshot()
  }

  getSnapshot() {
    return { config: { ...this.config }, status: this.budget.status() }
  }

  async save(value, updatedBy) {
    const limits = parseBody(limitsSchema, value, '实例资源保护')
    const record = { ...limits, updatedAt: new Date().toISOString(), updatedBy }
    const results = await redis
      .getClientSafe()
      .multi()
      .hset(RedisKeys.relayRequestResources.config, record)
      .hincrby(RedisKeys.relayRequestResources.config, 'version', 1)
      .exec()
    for (const [error] of results) {
      if (error) {
        throw error
      }
    }
    const version = results[1][1]
    this._apply({ ...record, version })
    try {
      await redis.getClientSafe().publish(RedisKeys.relayRequestResources.changedChannel, String(version))
    } catch (error) {
      logger.warn('Request resource config saved; cross-process notification failed', error)
    }
    logger.info('Request resource config updated', { ...record, version })
    return this.getSnapshot()
  }

  async start() {
    if (this.subscriber) {
      return
    }
    const reload = () => this.reload().catch((error) => logger.error('Request resource config reload failed', error))
    this.subscriber = redis.getClientSafe().duplicate()
    this.subscriber.on('error', (error) => logger.error('Request resource config subscription failed', error))
    this.subscriber.on('ready', reload)
    this.subscriber.on('message', (channel) => {
      if (channel === RedisKeys.relayRequestResources.changedChannel) {
        reload()
      }
    })
    try {
      await this.subscriber.subscribe(RedisKeys.relayRequestResources.changedChannel)
      await this.reload()
      this.syncTimer = setInterval(reload, requestResourcesConfig.syncIntervalMs)
      this.syncTimer.unref()
    } catch (error) {
      this.stop()
      throw error
    }
  }

  stop() {
    clearInterval(this.syncTimer)
    this.syncTimer = null
    this.subscriber?.removeAllListeners()
    this.subscriber?.disconnect()
    this.subscriber = null
  }
}

export const relayRequestResourcesService = new RelayRequestResourcesService()
