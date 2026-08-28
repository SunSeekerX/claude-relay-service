import express from 'express'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { requestDetailService } from './relay_request_detail_service.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, notFound } from '../../common/http_result.js'
export const router = express.Router()

router.get(
  '/request-details',
  authenticateAdmin,
  asyncRoute('Failed to list request details', async (req) => requestDetailService.listRequestDetails(req.query || {})),
)

router.get(
  '/request-details/body-preview-stats',
  authenticateAdmin,
  asyncRoute('Failed to get request body preview stats', async () => requestDetailService.getRequestBodyPreviewStats()),
)

router.post(
  '/request-details/body-preview-purge',
  authenticateAdmin,
  asyncRoute('Failed to purge request body previews', async () => {
    const data = await requestDetailService.purgeRequestBodySnapshots()
    return ok(data, '清理完毕')
  }),
)

router.get(
  '/request-details/:requestId',
  authenticateAdmin,
  asyncRoute('Failed to get request detail', async (req) => {
    const data = await requestDetailService.getRequestDetail(req.params.requestId)
    if (!data.record) {
      throw notFound('Request detail not found')
    }
    return data
  }),
)
