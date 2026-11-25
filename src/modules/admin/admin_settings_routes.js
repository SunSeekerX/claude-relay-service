import express from 'express'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok } from '../../common/http_result.js'
import { adminLoginSettingsService } from './admin_login_settings_service.js'
import { apiKeyQuickAdjustSettingsService } from '../apikey/apikey_quick_adjust_settings_service.js'

export const router = express.Router()

router.get(
  '/login-settings',
  authenticateAdmin,
  asyncRoute('Failed to get admin login settings', async () => adminLoginSettingsService.getSettings()),
)
router.put(
  '/login-settings',
  authenticateAdmin,
  asyncRoute('Failed to save admin login settings', async (req) =>
    ok(await adminLoginSettingsService.saveSettings(req.body, req.admin.username), '登录设置已保存'),
  ),
)
router.get(
  '/api-key-quick-adjust-settings',
  authenticateAdmin,
  asyncRoute('Failed to get API Key quick adjust settings', async () => apiKeyQuickAdjustSettingsService.getSettings()),
)
router.put(
  '/api-key-quick-adjust-settings',
  authenticateAdmin,
  asyncRoute('Failed to save API Key quick adjust settings', async (req) =>
    ok(await apiKeyQuickAdjustSettingsService.saveSettings(req.body, req.admin.username), '快捷调整设置已保存'),
  ),
)
