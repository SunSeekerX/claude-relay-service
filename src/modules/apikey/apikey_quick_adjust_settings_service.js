import { redis } from '../../infra/redis.js'
import { RedisKeys, LIMITS } from '../../infra/redis_key.js'
import { parseBody, z } from '../../common/parse_body.js'
import { logger } from '../../common/logger.js'

const presets = (schema) =>
  z
    .array(schema)
    .max(LIMITS.apiKeyQuickAdjustPresets)
    .refine((values) => new Set(values).size === values.length, '快捷值不能重复')

const settingsSchema = z.object({
  costPresets: presets(
    z
      .number()
      .finite()
      .positive()
      .max(Number.MAX_SAFE_INTEGER / 100)
      .multipleOf(0.01),
  ),
  extendPresets: presets(z.number().int().min(1).max(36500)),
})

export const apiKeyQuickAdjustSettingsService = {
  async getSettings() {
    const raw = await redis.getClientSafe().get(RedisKeys.apiKey.quickAdjustSettings)
    return raw === null
      ? { costPresets: [10, 50, 100, 200, 300, 500, 1000], extendPresets: [7, 30, 90, 180, 365] }
      : parseBody(settingsSchema, JSON.parse(raw), 'API Key 快捷调整设置')
  },

  async saveSettings(value, updatedBy) {
    const settings = parseBody(settingsSchema, value, 'API Key 快捷调整设置')
    await redis.getClientSafe().set(RedisKeys.apiKey.quickAdjustSettings, JSON.stringify(settings))
    logger.info('API Key quick adjust settings updated', { updatedBy, ...settings })
    return settings
  },
}
