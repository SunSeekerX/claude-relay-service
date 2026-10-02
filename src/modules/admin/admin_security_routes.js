import express from 'express'
import { redis } from '../../infra/redis.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'

export const router = express.Router()

router.get(
  '/security-events',
  authenticateAdmin,
  asyncRoute('Failed to list security events', async () => {
    const raw = await redis.getClientSafe().lrange(RedisKeys.adminLogin.events, 0, 199)
    return raw.map((item) => {
      try {
        return JSON.parse(item)
      } catch {
        return { at: null, ip: 'unknown', blocked: false }
      }
    })
  }),
)
