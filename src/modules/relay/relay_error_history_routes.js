import express from 'express'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { badRequest, ok } from '../../common/http_result.js'
import { parseDateTimeQuery } from '../../common/date_time.js'
import * as upstreamErrorHelper from './relay_upstream_error_helper.js'
export const router = express.Router()

const parseOptionalTime = (value, fieldName) => {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const date = parseDateTimeQuery(value)
  if (!date) {
    throw badRequest(`${fieldName} must be a valid datetime`)
  }
  return date.toISOString()
}

router.get(
  '/accounts/:accountType/:accountId/error-history',
  authenticateAdmin,
  asyncRoute('Failed to get error history', async (req) => {
    const { accountType, accountId } = req.params
    const offset = parseInt(req.query.offset, 10) || 0
    const limit = parseInt(req.query.limit, 10) || 50
    const startTime = parseOptionalTime(req.query.startTime, 'startTime')
    const endTime = parseOptionalTime(req.query.endTime, 'endTime')
    if (startTime && endTime && Date.parse(startTime) > Date.parse(endTime)) {
      throw badRequest('startTime must be <= endTime')
    }
    return upstreamErrorHelper.getErrorHistory(accountType, accountId, {
      offset,
      limit,
      startTime,
      endTime,
    })
  }),
)

router.delete(
  '/accounts/:accountType/:accountId/error-history',
  authenticateAdmin,
  asyncRoute('Failed to clear error history', async (req) => {
    const { accountType, accountId } = req.params
    await upstreamErrorHelper.clearErrorHistory(accountType, accountId)
    return ok()
  }),
)
