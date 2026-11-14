import express from 'express'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { relayRequestResourcesService } from './relay_request_resources_service.js'

export const router = express.Router()

router.get(
  '/relay-request-resources',
  authenticateAdmin,
  asyncRoute('Failed to load request resource settings', () => relayRequestResourcesService.reload()),
)
router.put(
  '/relay-request-resources',
  authenticateAdmin,
  asyncRoute('Failed to save request resource settings', (req) =>
    relayRequestResourcesService.save(req.body, req.admin.username),
  ),
)
