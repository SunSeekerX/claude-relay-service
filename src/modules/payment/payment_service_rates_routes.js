import express from 'express'
import { serviceRatesService } from './payment_service_rates_service.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { badRequest } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'
/**
 * 服务倍率配置管理路由
 */
export const router = express.Router()

// 获取服务倍率配置
router.get(
  '/service-rates',
  authenticateAdmin,
  asyncRoute('Failed to get service rates', async () => serviceRatesService.getRates()),
)

// 更新服务倍率配置
router.put(
  '/service-rates',
  authenticateAdmin,
  asyncRoute('Failed to update service rates', async (req) => {
    const body = parseObjectBody(req.body, '服务倍率')
    const { rates, baseService } = body
    if (!rates || typeof rates !== 'object') {
      throw badRequest('rates is required and must be an object')
    }
    const updatedBy = req.session?.username || 'admin'
    return serviceRatesService.saveRates({ rates, baseService }, updatedBy)
  }),
)

// 获取可用服务列表
router.get(
  '/service-rates/services',
  authenticateAdmin,
  asyncRoute('Failed to get available services', async () => serviceRatesService.getAvailableServices()),
)
