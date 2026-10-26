import express from 'express'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { redis } from '../../infra/redis.js'
import { asyncRoute } from '../../common/route_handler.js'
import { notFound } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'
import { ROUTE_FORMATS, ROUTE_PROVIDERS } from './relay_routing_contract.js'
import { getRouteTargets, saveRoute, getAccountSupportedModelDetails } from './relay_routing_service.js'
import { getAccountModelCatalog, syncAccountModelCatalog } from '../account/account_model_catalog_service.js'

export const router = express.Router()
router.use('/relay-routes', authenticateAdmin)
router.get(
  '/account-model-catalog/:type/:id/supported-models',
  authenticateAdmin,
  asyncRoute('Failed to load supported account models', async (req) => ({
    models: await getAccountSupportedModelDetails(req.params.type, req.params.id),
  })),
)
router.get(
  '/account-model-catalog/:type/:id',
  authenticateAdmin,
  asyncRoute('Failed to load account model catalog', async (req) =>
    getAccountModelCatalog(req.params.type, req.params.id),
  ),
)
router.post(
  '/account-model-catalog/:type/:id/sync',
  authenticateAdmin,
  asyncRoute('Failed to sync account model catalog', async (req) =>
    syncAccountModelCatalog(req.params.type, req.params.id),
  ),
)
router.get(
  '/relay-routes',
  asyncRoute('Failed to load relay routes', async () => ({
    routes: await redis.getRelayRoutes(),
    formats: ROUTE_FORMATS,
    providers: ROUTE_PROVIDERS,
  })),
)
router.get(
  '/relay-routes/targets/:provider',
  asyncRoute('Failed to load relay route targets', async (req) => getRouteTargets(req.params.provider)),
)
router.post(
  '/relay-routes',
  asyncRoute('Failed to create relay route', async (req) => saveRoute(parseObjectBody(req.body, '创建调用入口'))),
)
router.put(
  '/relay-routes/:code',
  asyncRoute('Failed to update relay route', async (req) =>
    saveRoute(parseObjectBody(req.body, '编辑调用入口'), req.params.code),
  ),
)
router.delete(
  '/relay-routes/:code',
  asyncRoute('Failed to delete relay route', async (req) => {
    if (!(await redis.deleteRelayRoute(req.params.code))) {
      throw notFound('入口不存在')
    }
    return { deleted: true }
  }),
)
