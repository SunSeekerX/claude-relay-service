import express from 'express'
import { grokMediaPricingOverlayService } from '../pricing/pricing_grok_media_overlay_service.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { badRequest, conflict } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'

export const router = express.Router()

const mapOverlayError = (error) => {
  if (error?.code === 'CONFLICT') {
    throw conflict(error.message, { reason: 'GROK_MEDIA_PRICING_CONFLICT' })
  }
  if (error?.code === 'BAD_REQUEST') {
    throw badRequest(error.message, { reason: 'GROK_MEDIA_PRICING_BAD_REQUEST' })
  }
  throw error
}

router.get(
  '/grok-media-pricing',
  authenticateAdmin,
  asyncRoute('Failed to get grok media pricing', async () => {
    await grokMediaPricingOverlayService.warmCache()
    return grokMediaPricingOverlayService.getEffectiveConfig()
  }),
)

router.put(
  '/grok-media-pricing',
  authenticateAdmin,
  asyncRoute('Failed to update grok media pricing', async (req) => {
    const body = parseObjectBody(req.body, 'Grok 媒体计费')
    if (body.models === undefined) {
      throw badRequest('models is required')
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'baseUpdatedAt')) {
      throw badRequest('baseUpdatedAt is required')
    }
    const updatedBy = req.session?.username || 'admin'
    try {
      return await grokMediaPricingOverlayService.saveOverlay(
        {
          models: body.models,
          baseUpdatedAt: body.baseUpdatedAt,
        },
        updatedBy,
      )
    } catch (error) {
      mapOverlayError(error)
    }
  }),
)

router.post(
  '/grok-media-pricing/reset',
  authenticateAdmin,
  asyncRoute('Failed to reset grok media pricing', async (req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    if (!Object.prototype.hasOwnProperty.call(body, 'baseUpdatedAt')) {
      throw badRequest('baseUpdatedAt is required')
    }
    const updatedBy = req.session?.username || 'admin'
    try {
      return await grokMediaPricingOverlayService.resetOverlay(updatedBy, body.baseUpdatedAt)
    } catch (error) {
      mapOverlayError(error)
    }
  }),
)
