import { config } from '../../../config/config.js'
import { redis } from '../../infra/redis.js'
import { RedisKeys, TTL } from '../../infra/redis_key.js'
import { parseBody, z } from '../../common/parse_body.js'
import { unauthorized } from '../../common/http_result.js'
import { logger } from '../../common/logger.js'

const settingsSchema = z.object({ sessionTimeoutHours: z.number().int().min(1).max(8760).nullable() })

export const adminLoginSettingsService = {
  async getSettings() {
    const raw = await redis.getClientSafe().get(RedisKeys.adminLogin.settings)
    return raw === null ? { sessionTimeoutHours: null } : parseBody(settingsSchema, JSON.parse(raw), '管理员登录设置')
  },

  async saveSettings(value, updatedBy) {
    const settings = parseBody(settingsSchema, value, '管理员登录设置')
    await redis.getClientSafe().set(RedisKeys.adminLogin.settings, JSON.stringify(settings))
    logger.info('Admin login settings updated', { updatedBy, ...settings })
    return settings
  },

  async newSessionFields() {
    const { sessionTimeoutHours } = await this.getSettings()
    return sessionTimeoutHours === null ? {} : { sessionTimeoutSeconds: TTL.adminSessionHours(sessionTimeoutHours) }
  },
}

// 未设置覆盖值的会话继续沿用现有登录/刷新 TTL 和鉴权续期行为。
export const adminSessionIssuePolicy = (session) =>
  session.sessionTimeoutSeconds === undefined
    ? { ttlSeconds: config.security.adminSessionTimeout, expiresIn: config.security.adminSessionTimeout }
    : { ttlSeconds: Number(session.sessionTimeoutSeconds), expiresIn: Number(session.sessionTimeoutSeconds) * 1000 }

export const adminSessionActivitySeconds = (session) =>
  session.sessionTimeoutSeconds === undefined ? TTL.adminSession : Number(session.sessionTimeoutSeconds)

export const assertAdminSessionActive = async (token, session, checkDefaultInactivity = false) => {
  if (!session || Object.keys(session).length === 0) {
    throw unauthorized('Session expired or invalid')
  }
  if (!session.username || !session.loginTime) {
    await redis.deleteSession(token)
    throw unauthorized('Session data corrupted or incomplete')
  }
  const custom = session.sessionTimeoutSeconds !== undefined
  if (!custom && !checkDefaultInactivity) {
    return
  }
  const seconds = adminSessionActivitySeconds(session)
  const lastActivity = Date.parse(session.lastActivity ?? session.loginTime)
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < TTL.adminSessionHours(1) ||
    seconds > TTL.adminSessionHours(8760) ||
    !Number.isFinite(lastActivity) ||
    Date.now() - lastActivity > seconds * 1000
  ) {
    await redis.deleteSession(token)
    throw unauthorized('Admin session has expired due to inactivity')
  }
}
