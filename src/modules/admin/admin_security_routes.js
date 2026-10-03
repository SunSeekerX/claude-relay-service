import express from 'express'
import { redis } from '../../infra/redis.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'

export const router = express.Router()

router.get(
  '/security-events',
  authenticateAdmin,
  asyncRoute('Failed to list security events', async (req) => {
    const pageNumber = Math.max(Number.parseInt(req.query.page, 10) || 1, 1)
    const pageSize = Math.min(Math.max(Number.parseInt(req.query.pageSize, 10) || 50, 1), 200)
    const client = redis.getClientSafe()
    const totalRecords = await client.llen(RedisKeys.adminLogin.events)
    const totalPages = totalRecords > 0 ? Math.ceil(totalRecords / pageSize) : 0
    const currentPage = totalPages > 0 ? Math.min(pageNumber, totalPages) : 1
    const start = (currentPage - 1) * pageSize
    const raw = totalRecords > 0 ? await client.lrange(RedisKeys.adminLogin.events, start, start + pageSize - 1) : []
    const records = raw.map((item) => {
      try {
        return JSON.parse(item)
      } catch {
        return { at: null, ip: 'unknown', blocked: false }
      }
    })
    return {
      records,
      pagination: {
        currentPage,
        pageSize,
        totalRecords,
        totalPages,
        hasNextPage: totalPages > 0 && currentPage < totalPages,
        hasPreviousPage: totalPages > 0 && currentPage > 1,
      },
    }
  }),
)
