import express from 'express'
import { redis } from '../../infra/redis.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'

export const router = express.Router()

const parseTaskMember = (member) => {
  const value = String(member || '')
  const separator = value.indexOf(':')
  if (separator <= 0) {
    return null
  }
  return { apiKeyId: value.slice(0, separator), requestId: value.slice(separator + 1) }
}

router.get(
  '/grok-video-tasks',
  authenticateAdmin,
  asyncRoute('Failed to list Grok video tasks', async (req) => {
    const client = redis.getClientSafe()
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200)
    const members = await client.zrevrange(RedisKeys.session.grokVideoTaskIndex, 0, limit * 3 - 1)
    const records = []
    const candidates = []
    for (const member of members) {
      const parsed = parseTaskMember(member)
      if (!parsed) {
        continue
      }
      if (req.query.apiKeyId && req.query.apiKeyId !== parsed.apiKeyId) {
        continue
      }
      candidates.push(parsed)
      if (candidates.length >= limit) {
        break
      }
    }
    const pipeline = client.pipeline()
    for (const parsed of candidates) {
      pipeline.hgetall(RedisKeys.session.grokVideoTask(parsed.apiKeyId, parsed.requestId))
    }
    const results = await pipeline.exec()
    for (const [error, task] of results) {
      if (error) {
        continue
      }
      if (!task?.requestId) {
        continue
      }
      if (req.query.status && req.query.status !== task.status) {
        continue
      }
      records.push({ ...task, reservedCost: Number(task.reservedCost || 0), actualCost: Number(task.actualCost || 0) })
    }
    return { records, limit }
  }),
)

router.get(
  '/grok-video-tasks/:apiKeyId/:requestId',
  authenticateAdmin,
  asyncRoute('Failed to get Grok video task', async (req) => {
    const task = await redis
      .getClientSafe()
      .hgetall(RedisKeys.session.grokVideoTask(req.params.apiKeyId, req.params.requestId))
    return task?.requestId ? task : null
  }),
)
