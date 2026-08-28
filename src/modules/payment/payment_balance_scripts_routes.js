import express from 'express'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { parseObjectBody } from '../../common/parse_body.js'
import { balanceScriptService } from './payment_balance_script_service.js'
export const router = express.Router()

// 获取全部脚本配置列表
router.get(
  '/balance-scripts',
  authenticateAdmin,
  asyncRoute('Failed to list balance scripts', async () => balanceScriptService.listConfigs()),
)

// 获取单个脚本配置
router.get(
  '/balance-scripts/:name',
  authenticateAdmin,
  asyncRoute('Failed to get balance script', async (req) => {
    const { name } = req.params
    return balanceScriptService.getConfig(name || 'default')
  }),
)

// 保存脚本配置
router.put(
  '/balance-scripts/:name',
  authenticateAdmin,
  asyncRoute('Failed to save balance script', async (req) => {
    const { name } = req.params
    return balanceScriptService.saveConfig(name || 'default', parseObjectBody(req.body, '余额脚本配置'))
  }),
)

// 测试脚本（不落库）
router.post(
  '/balance-scripts/:name/test',
  authenticateAdmin,
  asyncRoute('Failed to test balance script', async (req) => {
    const { name } = req.params
    return balanceScriptService.testScript(name || 'default', parseObjectBody(req.body, '余额脚本测试'))
  }),
)
