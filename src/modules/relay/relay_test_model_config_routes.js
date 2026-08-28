import express from 'express'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { testModelConfigService } from './relay_test_model_config_service.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, badRequest } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'
/**
 * 连通性测试默认模型配置 API 路由
 */

export const router = express.Router()

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

router.get(
  '/test-model-config',
  authenticateAdmin,
  asyncRoute('Failed to get test model config', async () => {
    const config = await testModelConfigService.getConfig()
    return { config }
  }),
)

router.put(
  '/test-model-config',
  authenticateAdmin,
  asyncRoute('Failed to update test model config', async (req) => {
    const { account, apikey } = parseObjectBody(req.body, '测试模型配置')
    if (account !== undefined && !isPlainObject(account)) {
      throw badRequest('account must be an object')
    }
    if (apikey !== undefined && !isPlainObject(apikey)) {
      throw badRequest('apikey must be an object')
    }
    const config = await testModelConfigService.updateConfig({ account, apikey }, req.admin?.username || 'unknown')
    return ok({ config }, 'Configuration updated successfully')
  }),
)
