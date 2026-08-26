import express from 'express'
import { router as apiKeysRoutes } from '../apikey/apikey_routes.js'
import { router as accountGroupsRoutes } from '../account/account_groups_routes.js'
import { router as claudeAccountsRoutes } from '../account/account_claude_routes.js'
import { router as claudeConsoleAccountsRoutes } from '../account/account_claude_console_routes.js'
import { router as ccrAccountsRoutes } from '../account/account_ccr_routes.js'
import { router as bedrockAccountsRoutes } from '../account/account_bedrock_routes.js'
import { router as geminiAccountsRoutes } from '../account/account_gemini_routes.js'
import { router as geminiApiAccountsRoutes } from '../account/account_gemini_api_routes.js'
import { router as openaiAccountsRoutes } from '../account/account_openai_routes.js'
import { router as azureOpenaiAccountsRoutes } from '../account/account_azure_openai_routes.js'
import { router as openaiResponsesAccountsRoutes } from '../account/account_openai_responses_routes.js'
import { router as droidAccountsRoutes } from '../account/account_droid_routes.js'
import { router as grokAccountsRoutes } from '../account/account_grok_routes.js'
import { router as dashboardRoutes } from './admin_dashboard_routes.js'
import { router as usageStatsRoutes } from './admin_usage_stats_routes.js'
import { router as accountBalanceRoutes } from '../account/account_balance_routes.js'
import { router as systemRoutes } from './admin_system_routes.js'
import { router as concurrencyRoutes } from '../relay/relay_concurrency_routes.js'
import { router as claudeRelayConfigRoutes } from '../relay/relay_claude_relay_config_routes.js'
import { router as testModelConfigRoutes } from '../relay/relay_test_model_config_routes.js'
import { router as syncRoutes } from './admin_sync_routes.js'
import { router as accountsMigrationRoutes } from '../account/account_migration_routes.js'
import { router as serviceRatesRoutes } from '../payment/payment_service_rates_routes.js'
import { router as quotaCardsRoutes } from '../payment/payment_quota_cards_routes.js'
import { router as errorHistoryRoutes } from '../relay/relay_error_history_routes.js'
import { router as requestDetailsRoutes } from '../relay/relay_request_details_routes.js'
import { router as proxiesRoutes } from '../proxy/proxy_routes.js'
import { router as paymentAdminRoutes } from '../payment/payment_admin_routes.js'
/**
 * Admin Routes - 主入口文件
 * 导入并挂载所有子路由模块
 */

export const router = express.Router()

// 导入所有子路由

// 挂载所有子路由
// 使用完整路径的模块（直接挂载到根路径）
router.use('/', apiKeysRoutes)
router.use('/', claudeAccountsRoutes)
router.use('/', claudeConsoleAccountsRoutes)
router.use('/', geminiApiAccountsRoutes)
router.use('/', azureOpenaiAccountsRoutes)
router.use('/', openaiResponsesAccountsRoutes)
router.use('/', droidAccountsRoutes)
router.use('/', grokAccountsRoutes)
router.use('/', dashboardRoutes)
router.use('/', usageStatsRoutes)
router.use('/', accountBalanceRoutes)
router.use('/', systemRoutes)
router.use('/', concurrencyRoutes)
router.use('/', claudeRelayConfigRoutes)
router.use('/', testModelConfigRoutes)
router.use('/', syncRoutes)
router.use('/', accountsMigrationRoutes)
router.use('/', serviceRatesRoutes)
router.use('/', quotaCardsRoutes)
router.use('/', errorHistoryRoutes)
router.use('/', requestDetailsRoutes)
router.use('/', paymentAdminRoutes)

// 使用相对路径的模块（需要指定基础路径前缀）
router.use('/account-groups', accountGroupsRoutes)
router.use('/proxy-pool', proxiesRoutes)
router.use('/ccr-accounts', ccrAccountsRoutes)
router.use('/bedrock-accounts', bedrockAccountsRoutes)
router.use('/gemini-accounts', geminiAccountsRoutes)
router.use('/openai-accounts', openaiAccountsRoutes)
