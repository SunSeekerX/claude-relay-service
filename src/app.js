import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import bcrypt from 'bcryptjs'

import { config } from '../config/config.js'
import packageJson from '../package.json' with { type: 'json' }
import { logger } from './common/logger.js'
import { redis } from './infra/redis.js'
import { RedisKeys } from './infra/redis_key.js'
import { RedisLua } from './infra/redis_lua.js'
import { pricingService } from './modules/pricing/pricing_service.js'
import { cacheMonitor } from './common/cache_monitor.js'
import { getSafeMessage } from './common/error_sanitizer.js'
import * as migrations from './infra/migration_runner.js'
import { apiRoutes } from './modules/relay/relay_api_routes.js'
import { unifiedRoutes } from './modules/relay/relay_unified_routes.js'
import { router as adminRoutes } from './modules/admin/admin_routes.js'
import { router as webRoutes } from './modules/admin/admin_web_routes.js'
import { router as apiStatsRoutes } from './modules/admin/admin_api_stats_routes.js'
import { geminiRoutes } from './modules/relay/relay_gemini_routes.js'
import { router as openaiGeminiRoutes } from './modules/relay/relay_openai_gemini_routes.js'
import { router as standardGeminiRoutes } from './modules/relay/relay_standard_gemini_routes.js'
import { openaiClaudeRoutes } from './modules/relay/relay_openai_claude_routes.js'
import { openaiRoutes } from './modules/relay/relay_openai_routes.js'
import { router as droidRoutes } from './modules/relay/relay_droid_routes.js'
import { router as grokRoutes } from './modules/relay/relay_grok_routes.js'
import { router as userRoutes } from './modules/user/user_routes.js'
import { router as azureOpenaiRoutes } from './modules/relay/relay_azure_openai_routes.js'
import { router as webhookRoutes } from './modules/webhook/webhook_routes.js'
import { router as paymentRoutes } from './modules/payment/payment_routes.js'
import { router as paymentWebhookRoutes } from './modules/payment/payment_webhook_routes.js'
import { createOfficialAliasRouter } from './modules/relay/relay_official_aliases_routes.js'
import { initPaymentProviders } from './modules/payment/payment_providers.js'
import { browserFallbackMiddleware } from './infra/middleware_browser_fallback.js'
import { requestDecompress } from './infra/middleware_request_decompress.js'
import { getBannerEndpoints } from './common/startup_banner.js'
import { accountBalanceService } from './modules/account/account_balance_service.js'
import { registerAllProviders } from './modules/payment/payment_balance_providers.js'
import { modelService } from './modules/pricing/pricing_model_service.js'
import { costInitService } from './modules/pricing/pricing_cost_init_service.js'
import { weeklyClaudeCostInitService } from './modules/pricing/pricing_weekly_claude_cost_init_service.js'
import { claudeAccountService } from './modules/account/account_claude_service.js'
import { claudeConsoleAccountService } from './modules/account/account_claude_console_service.js'
import { bedrockAccountService } from './modules/account/account_bedrock_service.js'
import { costRankService } from './modules/pricing/pricing_cost_rank_service.js'
import { apiKeyIndexService } from './modules/apikey/apikey_index_service.js'
import { accountGroupService } from './modules/account/account_group_service.js'
import { proxyPoolService } from './modules/proxy/proxy_pool_service.js'
import { proxyWebSocketUpgrade } from './common/gateway_websocket_upgrade_proxy.js'
import { authenticateApiKeyForUpgrade } from './common/gateway_ws_api_key_auth.js'
import { unifiedOpenAIScheduler } from './modules/relay/relay_unified_openai_scheduler.js'
import * as openaiAccountService from './modules/account/account_openai_service.js'
import { apiKeyService } from './modules/apikey/apikey_service.js'
import { proxyResolver } from './modules/proxy/proxy_resolver.js'
import { createRequestDetailMeta } from './modules/relay/relay_request_detail_helper.js'
import { paymentOrderService } from './modules/payment/payment_order_service.js'
import { rateLimitCleanupService } from './modules/relay/relay_rate_limit_cleanup_service.js'
import { userMessageQueueService } from './modules/user/user_message_queue_service.js'
import { accountTestSchedulerService } from './modules/account/account_test_scheduler_service.js'
import { proxyHealthService } from './modules/proxy/proxy_health_service.js'
import * as authMod from './infra/middleware_auth.js'
import * as codexRealtime from './modules/relay/relay_codex_realtime.js'
import * as codexResponsesWs from './modules/relay/relay_codex_responses_ws.js'
import * as codexResponsesWsBridge from './modules/relay/relay_codex_responses_ws_bridge.js'
import { responsesWsSessionPool } from './modules/relay/relay_codex_responses_ws_pool.js'
import { env } from '../config/env.js'
import { initTranslatorRegistry } from './modules/relay/translator/relay_translator_index.js'
import { extractMultipartFormField } from './modules/relay/relay_multipart_form_field.js'

const pkgVersion = packageJson.version

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 业务时区当前时间 yyyy-MM-dd HH:mm:ss（读 config.system.timezoneOffset，与统计口径一致）
const formatBusinessTime = () => {
  const offsetHours = config.system?.timezoneOffset ?? 8
  const tzDate = new Date(Date.now() + offsetHours * 3600000)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${tzDate.getUTCFullYear()}-${pad(tzDate.getUTCMonth() + 1)}-${pad(tzDate.getUTCDate())} ` +
    `${pad(tzDate.getUTCHours())}:${pad(tzDate.getUTCMinutes())}:${pad(tzDate.getUTCSeconds())}`
  )
}

export class Application {
  constructor() {
    this.app = express()
    this.server = null
  }

  async initialize() {
    try {
      // 连接Redis
      logger.info('Connecting to Redis...')
      await redis.connect()
      logger.success('Redis connected successfully')

      // 跨协议转换注册表（openai/claude/gemini/responses）
      try {
        const translators = initTranslatorRegistry()
        logger.info(`Translator registry initialized entries=${translators.length}`)
      } catch (error) {
        logger.error('Translator registry init failed:', error)
        console.error(error)
      }

      // 版本门控数据迁移（global stats + cleanupSystemMetrics + migrated:version 水位）
      // 逐字复刻于 src/migrations/runner.js runVersionGated,语义不变
      await migrations.runVersionGated(redis)

      // 后台检查月份索引完整性（不阻塞启动）
      redis.ensureMonthlyMonthsIndex().catch((err) => {
        logger.error('月份索引检查失败:', err.message)
      })

      // 后台异步迁移 usage 索引（不阻塞启动）
      redis.migrateUsageIndex().catch((err) => {
        logger.error('Background usage index migration failed:', err)
      })

      // 迁移 alltime 模型统计（阻塞式，确保数据完整）
      // 用内部 marker system:migration:alltime_model_stats_v1 自管幂等,失败吞错 → 下次重试(自愈)。
      // 不纳入 migrations applied 台账:其"失败重试"语义强于台账"记了不再跑",接管会降级(见 migrations/registry.js 契约)
      await redis.migrateAlltimeModelStats()

      // 初始化账户余额查询服务（Provider 注册）
      try {
        registerAllProviders(accountBalanceService)
        logger.info('账户余额查询服务已初始化')
      } catch (error) {
        logger.error('账户余额查询服务初始化失败:', {
          error: error.message,
          stack: error.stack,
        })
      }

      // 初始化价格服务
      logger.info('Initializing pricing service...')
      await pricingService.initialize()

      // 初始化模型服务
      logger.info('Initializing model service...')
      await modelService.initialize()

      // 初始化缓存监控
      await this.initializeCacheMonitoring()

      // 初始化管理员凭据
      logger.info('Initializing admin credentials...')
      await this.initializeAdmin()

      // 安全启动：清理无效/伪造的管理员会话
      logger.info('Cleaning up invalid admin sessions...')
      await this.cleanupInvalidSessions()

      // 初始化费用数据
      logger.info('Checking cost data initialization...')
      const needsInit = await costInitService.needsInitialization()
      if (needsInit) {
        logger.info('Initializing cost data for all API Keys...')
        const result = await costInitService.initializeAllCosts()
        logger.info(`Cost initialization completed: ${result.processed} processed, ${result.errors} errors`)
      }

      // 启动回填：本周 Claude 周费用（用于 API Key 维度周限额）
      try {
        logger.info('Backfilling current-week Claude weekly cost...')
        await weeklyClaudeCostInitService.backfillCurrentWeekClaudeCosts()
      } catch (error) {
        logger.warn('Weekly Claude cost backfill failed (startup continues):', error.message)
      }

      // 初始化Claude账户会话窗口
      logger.info('Initializing Claude account session windows...')
      await claudeAccountService.initializeSessionWindows()

      // 初始化费用排序索引服务
      logger.info('Initializing cost rank service...')
      await costRankService.initialize()

      // 初始化 API Key 索引服务（用于分页查询优化）
      logger.info('Initializing API Key index service...')
      apiKeyIndexService.init(redis)
      await apiKeyIndexService.checkAndRebuild()

      // 确保账户分组反向索引存在（后台执行，不阻塞启动）
      accountGroupService.ensureReverseIndexes().catch((err) => {
        logger.error('Account group reverse index migration failed:', err)
      })

      // 初始化代理池（冷加载 L1 + Pub/Sub 订阅 + 统计写回）
      try {
        await proxyPoolService.start()
      } catch (error) {
        logger.error('Proxy pool init failed (startup continues):', error)
      }

      // 超早期拦截 /admin-next/ 请求 - 在所有中间件之前
      this.app.use((req, res, next) => {
        if (req.path === '/admin-next/' && req.method === 'GET') {
          logger.warn('INTERCEPTING /admin-next/ request at the very beginning!')
          const adminSpaPath = path.join(__dirname, '..', 'web', 'admin-spa', 'dist')
          const indexPath = path.join(adminSpaPath, 'index.html')

          if (fs.existsSync(indexPath)) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
            return res.sendFile(indexPath)
          } else {
            logger.error('index.html not found at:', indexPath)
            return res.status(404).send('index.html not found')
          }
        }
        next()
      })

      // 安全中间件
      this.app.use(
        helmet({
          contentSecurityPolicy: false, //允许内联样式和脚本
          crossOriginEmbedderPolicy: false,
        }),
      )

      // CORS
      if (config.web.enableCors) {
        this.app.use(cors())
      } else {
        this.app.use(authMod.corsMiddleware)
      }

      // 兜底中间件：处理Chrome插件兼容性（必须在认证之前）
      this.app.use(browserFallbackMiddleware)

      // 压缩 - 排除流式响应（SSE）
      this.app.use(
        compression({
          filter: (req, res) => {
            // 不压缩 Server-Sent Events
            if (res.getHeader('Content-Type') === 'text/event-stream') {
              return false
            }
            // 使用默认的压缩判断
            return compression.filter(req, res)
          },
        }),
      )

      // 全局速率限制（仅在生产环境启用）
      if (env.NODE_ENV === 'production') {
        this.app.use(authMod.globalRateLimit)
      }

      // 请求大小限制
      this.app.use(authMod.requestSizeLimit)

      // 请求日志（使用自定义logger而不是morgan）
      this.app.use(authMod.requestLogger)

      // 支付 webhook：必须在 body 解析前挂载，用原始字节验签（Stripe/支付宝/微信依赖原始 body）
      initPaymentProviders()
      this.app.use('/payment/webhook', express.raw({ type: '*/*', limit: '2mb' }), paymentWebhookRoutes)

      // 请求体解压：body-parser 只认 identity/gzip/deflate，zstd/br 需在其之前解开（Codex CLI 默认发 zstd）
      this.app.use(requestDecompress)

      // Realtime/Live 建连可能是 application/sdp 或 multipart，不能走 json 解析
      // Audio transcriptions/translations 的 multipart 文件也必须保留原始 body 才能透传上游
      this.app.use((req, res, next) => {
        const requestPath = req.path || ''
        const contentType = String(req.headers['content-type'] || '')
        const isRealtimeCreate =
          requestPath.includes('/realtime/calls') ||
          requestPath === '/v1/realtime' ||
          requestPath.startsWith('/v1/realtime/') ||
          requestPath === '/v1/live' ||
          requestPath.endsWith('/live')
        const isAudioMultipart =
          contentType.includes('multipart/form-data') &&
          (requestPath.includes('/audio/transcriptions') ||
            requestPath.includes('/audio/translations') ||
            requestPath.endsWith('/audio/transcriptions') ||
            requestPath.endsWith('/audio/translations'))
        if (!isRealtimeCreate && !isAudioMultipart) {
          return next()
        }
        return express.raw({ type: () => true, limit: '100mb' })(req, res, (err) => {
          if (err) {
            return next(err)
          }
          req.rawBody = req.body
          const ct = String(req.headers['content-type'] || '')
          if (isAudioMultipart) {
            // multipart 原样透传 rawBody；同时抽出 model 供选号/映射（boundary 取自 Content-Type）
            const modelFromForm = extractMultipartFormField(req.body, 'model', {
              contentType: ct || req.headers['content-type'] || '',
            })
            req.rawBody = req.body
            req.body = {
              _multipartRaw: true,
              ...(modelFromForm ? { model: modelFromForm } : {}),
            }
            return next()
          }
          if (ct.includes('application/json') && Buffer.isBuffer(req.body)) {
            try {
              req.body = JSON.parse(req.body.toString('utf8') || '{}')
            } catch (parseError) {
              // 保留 raw，标记失败
              req.body = { _rawParseError: true }
            }
          } else if (Buffer.isBuffer(req.body)) {
            req.body = { _sdpRaw: req.body }
          }
          return next()
        })
      })

      // 基础中间件
      this.app.use(
        express.json({
          limit: '100mb',
          verify: (req, res, buf, encoding) => {
            // 验证JSON格式
            if (buf && buf.length && !buf.toString(encoding || 'utf8').trim()) {
              throw new Error('Invalid JSON: empty body')
            }
          },
        }),
      )
      this.app.use(express.urlencoded({ extended: true, limit: '100mb' }))
      this.app.use(authMod.securityMiddleware)

      // 信任代理
      if (config.server.trustProxy) {
        this.app.set('trust proxy', 1)
      }

      // 调试中间件 - 拦截所有 /admin-next 请求
      this.app.use((req, res, next) => {
        if (req.path.startsWith('/admin-next')) {
          logger.info(
            `DEBUG: Incoming request - method: ${req.method}, path: ${req.path}, originalUrl: ${req.originalUrl}`,
          )
        }
        next()
      })

      // 新版管理界面静态文件服务（必须在其他路由之前）
      const adminSpaPath = path.join(__dirname, '..', 'web', 'admin-spa', 'dist')
      if (fs.existsSync(adminSpaPath)) {
        // 处理不带斜杠的路径，重定向到带斜杠的路径
        this.app.get('/admin-next', (req, res) => {
          res.redirect(301, '/admin-next/')
        })

        // 使用 all 方法确保捕获所有 HTTP 方法
        this.app.all('/admin-next/', (req, res) => {
          logger.info('HIT: /admin-next/ route handler triggered!')
          logger.info(`Method: ${req.method}, Path: ${req.path}, URL: ${req.url}`)

          if (req.method !== 'GET' && req.method !== 'HEAD') {
            return res.status(405).send('Method Not Allowed')
          }

          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
          res.sendFile(path.join(adminSpaPath, 'index.html'))
        })

        // 处理所有其他 /admin-next/*path 路径（但排除根路径）
        this.app.get('/admin-next/*path', (req, res) => {
          // 如果是根路径，跳过（应该由上面的路由处理）
          if (req.path === '/admin-next/') {
            logger.error('ERROR: /admin-next/ should not reach here!')
            return res.status(500).send('Route configuration error')
          }

          const requestPath = req.path.replace('/admin-next/', '')

          // 安全检查
          if (requestPath.includes('..') || requestPath.includes('//') || requestPath.includes('\\')) {
            return res.status(400).json({ error: 'Invalid path' })
          }

          // 检查是否为静态资源
          const filePath = path.join(adminSpaPath, requestPath)

          // 如果文件存在且是静态资源
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            // 设置缓存头
            if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
            } else if (filePath.endsWith('.html')) {
              res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
            }
            return res.sendFile(filePath)
          }

          // 如果是静态资源但文件不存在
          if (requestPath.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf)$/i)) {
            return res.status(404).send('Not found')
          }

          // 其他所有路径返回 index.html（SPA 路由）
          res.sendFile(path.join(adminSpaPath, 'index.html'))
        })

        logger.info('Admin SPA (next) static files mounted at /admin-next/')
      } else {
        logger.warn('Admin SPA dist directory not found, skipping /admin-next route')
      }

      // 路由
      this.app.use('/api', apiRoutes)
      this.app.use('/api', unifiedRoutes) //统一智能路由（支持 /v1/chat/completions 等）
      this.app.use('/claude', apiRoutes) ///claude 路由别名，与 /api 功能相同
      // Anthropic (Claude Code) 路由：按路径强制分流到 Gemini OAuth 账户
      // - /antigravity/api/v1/messages -> Antigravity OAuth
      // - /gemini-cli/api/v1/messages -> Gemini CLI OAuth
      this.app.use(
        '/antigravity/api',
        (req, res, next) => {
          req._anthropicVendor = 'antigravity'
          next()
        },
        apiRoutes,
      )
      this.app.use(
        '/gemini-cli/api',
        (req, res, next) => {
          req._anthropicVendor = 'gemini-cli'
          next()
        },
        apiRoutes,
      )
      this.app.use('/admin', adminRoutes)
      this.app.use('/users', userRoutes)
      this.app.use('/payment', paymentRoutes)
      // 使用 web 路由（包含 auth 和页面重定向）
      this.app.use('/web', webRoutes)
      this.app.use('/apiStats', apiStatsRoutes)
      // Gemini 路由：同时支持标准格式和原有格式
      this.app.use('/gemini', standardGeminiRoutes) //标准 Gemini API 格式路由
      this.app.use('/gemini', geminiRoutes) //保留原有路径以保持向后兼容
      this.app.use('/openai/gemini', openaiGeminiRoutes)
      this.app.use('/openai/claude', openaiClaudeRoutes)
      this.app.use('/openai', unifiedRoutes) //复用统一智能路由，支持 /openai/v1/chat/completions
      this.app.use('/openai', openaiRoutes) //Codex API 路由（/openai/responses, /openai/v1/responses）
      // Droid 路由：支持多种 Factory.ai 端点
      this.app.use('/droid', droidRoutes) //Droid (Factory.ai) API 转发
      this.app.use('/grok', grokRoutes) //Grok / xAI API 转发
      this.app.use('/azure', azureOpenaiRoutes)
      this.app.use('/admin/webhook', webhookRoutes)

      // 官方 CLI 路径并集别名（旧前缀全部保留兼容）
      // - /v1/messages | /v1/chat/completions | /v1/responses(+compact) | /v1/models
      // - /responses(+compact)
      // - /backend-api/codex/*
      // - /v1beta/*| /v1internal:*
      this.app.use(createOfficialAliasRouter())

      // 根路径重定向到新版管理界面
      this.app.get('/', (req, res) => {
        res.redirect('/admin-next/api-stats')
      })

      // 增强的健康检查端点
      this.app.get('/health', async (req, res) => {
        try {
          const timer = logger.timer('health-check')

          // 检查各个组件健康状态
          const [redisHealth, loggerHealth] = await Promise.all([this.checkRedisHealth(), this.checkLoggerHealth()])

          const memory = process.memoryUsage()

          // 获取版本号：优先使用环境变量，其次VERSION文件，再次package.json，最后使用默认值
          let version = env.APP_VERSION || env.VERSION
          if (!version) {
            try {
              const versionFile = path.join(__dirname, '..', 'VERSION')
              if (fs.existsSync(versionFile)) {
                version = fs.readFileSync(versionFile, 'utf8').trim()
              }
            } catch (error) {
              // 忽略错误，继续尝试其他方式
            }
          }
          if (!version) {
            try {
              version = pkgVersion
            } catch (error) {
              version = '1.0.0'
            }
          }

          const health = {
            status: 'healthy',
            service: 'claude-relay-service',
            version,
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: {
              used: `${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
              total: `${Math.round(memory.heapTotal / 1024 / 1024)}MB`,
              external: `${Math.round(memory.external / 1024 / 1024)}MB`,
            },
            components: {
              redis: redisHealth,
              logger: loggerHealth,
            },
            stats: logger.getStats(),
          }

          timer.end('completed')
          res.json(health)
        } catch (error) {
          logger.error('Health check failed:', { error: error.message, stack: error.stack })
          res.status(503).json({
            status: 'unhealthy',
            error: getSafeMessage(error),
            timestamp: new Date().toISOString(),
          })
        }
      })

      // 指标端点
      this.app.get('/metrics', async (req, res) => {
        try {
          const stats = await redis.getSystemStats()
          const metrics = {
            ...stats,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            timestamp: new Date().toISOString(),
          }

          res.json(metrics)
        } catch (error) {
          logger.error('Metrics collection failed:', error)
          res.status(500).json({ error: 'Failed to collect metrics' })
        }
      })

      // 404：管理面 code/msg；中转/其它面保持旧 {error,message}，禁止给协议客户端套管理信封
      this.app.use('/{*splat}', (req, res) => {
        const requestPath = (req.originalUrl || '').split('?')[0]
        const isManagement =
          requestPath.startsWith('/admin') ||
          requestPath.startsWith('/users') ||
          requestPath.startsWith('/web') ||
          requestPath.startsWith('/apiStats') ||
          (requestPath.startsWith('/payment') && !requestPath.startsWith('/payment/webhook'))
        if (isManagement) {
          return res.status(404).json({
            code: 404,
            msg: `Route ${req.originalUrl} not found`,
          })
        }
        return res.status(404).json({
          error: 'Not Found',
          message: `Route ${req.originalUrl} not found`,
        })
      })

      // 错误处理
      this.app.use(authMod.errorHandler)

      logger.success('Application initialized successfully')
    } catch (error) {
      logger.error('Application initialization failed:', error)
      throw error
    }
  }

  // 初始化管理员凭据（总是从 init.json 加载，确保数据一致性）
  async initializeAdmin() {
    try {
      const initFilePath = path.join(__dirname, '..', 'data', 'init.json')

      if (!fs.existsSync(initFilePath)) {
        logger.warn('No admin credentials found. Please run npm run setup first.')
        return
      }

      // 从 init.json 读取管理员凭据（作为唯一真实数据源）
      const initData = JSON.parse(fs.readFileSync(initFilePath, 'utf8'))

      // 将明文密码哈希化
      const saltRounds = 10
      const passwordHash = await bcrypt.hash(initData.adminPassword, saltRounds)

      // 存储到Redis（每次启动都覆盖，确保与 init.json 同步）
      const adminCredentials = {
        username: initData.adminUsername,
        passwordHash,
        createdAt: initData.initializedAt || new Date().toISOString(),
        lastLogin: null,
        updatedAt: initData.updatedAt || null,
      }

      await redis.setSession('admin_credentials', adminCredentials)

      logger.success('Admin credentials loaded from init.json (single source of truth)')
      logger.info(`Admin username: ${adminCredentials.username}`)
    } catch (error) {
      logger.error('Failed to initialize admin credentials:', {
        error: error.message,
        stack: error.stack,
      })
      throw error
    }
  }

  // 清理无效/伪造的管理员会话（安全启动检查）
  async cleanupInvalidSessions() {
    try {
      const client = redis.getClient()

      // 获取所有 session:*键
      const sessionKeys = await redis.scanKeys(RedisKeys.session.adminPattern)
      const dataList = await redis.batchHgetallChunked(sessionKeys)

      let validCount = 0
      let invalidCount = 0

      for (let i = 0; i < sessionKeys.length; i++) {
        const key = sessionKeys[i]
        // 跳过 admin_credentials（系统凭据）
        if (key === RedisKeys.session.adminCredentials) {
          continue
        }

        const sessionData = dataList[i]

        // 检查会话完整性：必须有 username 和 loginTime
        const hasUsername = !!sessionData?.username
        const hasLoginTime = !!sessionData?.loginTime

        if (!hasUsername || !hasLoginTime) {
          // 无效会话 - 可能是漏洞利用创建的伪造会话
          invalidCount++
          logger.security(`Removing invalid session: ${key} (username: ${hasUsername}, loginTime: ${hasLoginTime})`)
          await client.del(key)
        } else {
          validCount++
        }
      }

      if (invalidCount > 0) {
        logger.security(`Startup security check: Removed ${invalidCount} invalid sessions`)
      }

      logger.success(`Session cleanup completed: ${validCount} valid, ${invalidCount} invalid removed`)
    } catch (error) {
      // 清理失败不应阻止服务启动
      logger.error('Failed to cleanup invalid sessions:', error.message)
    }
  }

  // Redis健康检查
  async checkRedisHealth() {
    try {
      const start = Date.now()
      await redis.getClient().ping()
      const latency = Date.now() - start

      return {
        status: 'healthy',
        connected: redis.isConnected,
        latency: `${latency}ms`,
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        connected: false,
        error: error.message,
      }
    }
  }

  // Logger健康检查
  async checkLoggerHealth() {
    try {
      const health = logger.healthCheck()
      return {
        status: health.healthy ? 'healthy' : 'unhealthy',
        ...health,
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
      }
    }
  }

  // Codex Realtime：客户端 wss 升级到 CRS 后，隧道到上游 wss（call_id sideband）
  // 鉴权硬门 + 并发续租 + 上游 usage 嗅探计费 + 握手超时主动释放
  _setupRealtimeWebSocketProxy() {
    if (!this.server) {
      return
    }
    const writeSocketError = (socket, status, message) => {
      try {
        const body = message || ''
        socket.write(
          `HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        )
      } catch (_) {
        /*ignore */
      }
      try {
        socket.destroy()
      } catch (_) {
        /*ignore */
      }
    }

    this.server.on('upgrade', async (req, socket, head) => {
      let releaseAuth = async () => {}
      try {
        const host = req.headers.host || 'localhost'
        const url = new URL(req.url || '/', `http://${host}`)
        const pathname = url.pathname || ''
        const isResponsesWs = codexResponsesWs.isResponsesWebSocketPath(pathname)
        const isRealtimeWs = codexRealtime.isRealtimeWebSocketPath(pathname)

        if (!isRealtimeWs && !isResponsesWs) {
          writeSocketError(socket, 404, 'Not Found')
          return
        }

        const wsKind = isResponsesWs ? 'ResponsesWS' : 'RealtimeWS'

        // 租约到期强制断连：避免停续租后槽位蒸发、在线 WS 突破并发上限
        let forceCloseSocket = null
        const auth = await authenticateApiKeyForUpgrade(req, url, {
          requiredPermission: 'openai',
          // 与 codexRealtimeCall TTL(2h) 对齐，避免 5 分钟后槽位蒸发
          maxLifetimeMinutes: parseInt(env.CONCURRENCY_WS_MAX_LIFETIME_MINUTES, 10) || 120,
          onLeaseExpired: () => {
            logger.warn(`[${wsKind}] concurrency lease lifetime exceeded, force close`)
            try {
              if (typeof forceCloseSocket === 'function') {
                forceCloseSocket()
              } else {
                socket.destroy()
              }
            } catch (e) {
              console.error(e)
            }
          },
        })
        releaseAuth = auth.release || releaseAuth
        if (!auth.ok) {
          await releaseAuth()
          writeSocketError(socket, auth.status || 401, auth.message || 'Unauthorized')
          return
        }
        const apiKeyData = auth.keyData

        const callId = isRealtimeWs ? codexRealtime.extractCallIdFromWsRequest(pathname, url.searchParams) : null
        const sessionId =
          req.headers['session-id'] || req.headers['session_id'] || url.searchParams.get('session_id') || null
        // query/header 可能已带 model（握手阶段尽早用于选号）
        const handshakeModel =
          url.searchParams.get('model') || req.headers['x-model'] || req.headers['openai-model'] || null

        // Responses WS：env 强制 http_bridge 时可先于选号进入（bridge 内按首包 model 懒选号）
        if (isResponsesWs) {
          const envOnlyMode = codexResponsesWsBridge.resolveResponsesWsMode({})
          if (envOnlyMode === 'http_bridge') {
            logger.info(`[ResponsesWS] mode=http_bridge(env) key=${apiKeyData.id}`)
            await codexResponsesWsBridge.handleResponsesWebSocketHttpBridge(req, socket, head, {
              apiKeyData,
              releaseAuth,
              initialModel: handshakeModel,
            })
            return
          }
          // 默认 passthrough 且握手无 model：延迟选号，等首帧 response.create
          if (!handshakeModel && !callId && envOnlyMode !== 'http_bridge') {
            logger.info(`[ResponsesWS] mode=lazy-passthrough(no handshake model) key=${apiKeyData.id}`)
            // 计费/收尾与下方 passthrough 共用结构较重；此处最小闭环：懒选号 + 上游透传 + releaseAuth
            const usageAcc = codexRealtime.createRealtimeUsageAccumulator()
            const startedAt = Date.now()
            let billed = false
            let upgradedOk = false
            let lazyAccountId = null
            const finalizeBilling = async () => {
              if (billed) {
                return
              }
              billed = true
              if (!upgradedOk || !lazyAccountId) {
                return
              }
              try {
                const snap = usageAcc.snapshot()
                const durationMs = Math.max(0, Date.now() - startedAt)
                const model = snap.lastModel || 'gpt-5'
                const cyberEvent = snap.cyberPolicyEvent || snap.lastErrorEvent
                if (
                  cyberEvent &&
                  typeof codexResponsesWsBridge.isSessionCyberPolicyBlock === 'function' &&
                  codexResponsesWsBridge.isSessionCyberPolicyBlock(cyberEvent)
                ) {
                  logger.warn(
                    `[ResponsesWS] cyber policy hit on lazy-passthrough key=${apiKeyData.id} account=${lazyAccountId}`,
                  )
                  req._crsCyberPolicyBlocked = true
                }
                const tierUsages = Array.isArray(snap.tierUsages) && snap.tierUsages.length > 0 ? snap.tierUsages : null
                if (tierUsages) {
                  for (const tierUsage of tierUsages) {
                    const cacheRead = Math.max(0, Number(tierUsage.cache_read_input_tokens) || 0)
                    const cacheCreate = Math.max(0, Number(tierUsage.cache_creation_input_tokens) || 0)
                    const totalInput = Math.max(0, Number(tierUsage.input_tokens) || 0)
                    const usagePayload = {
                      input_tokens: Math.max(0, totalInput - cacheRead),
                      output_tokens: Math.max(0, Number(tierUsage.output_tokens) || 0),
                      cache_read_input_tokens: cacheRead,
                      cache_creation_input_tokens: cacheCreate,
                    }
                    if (
                      usagePayload.input_tokens <= 0 &&
                      usagePayload.output_tokens <= 0 &&
                      usagePayload.cache_read_input_tokens <= 0 &&
                      usagePayload.cache_creation_input_tokens <= 0
                    ) {
                      continue
                    }
                    await apiKeyService.recordUsage(
                      apiKeyData.id,
                      usagePayload,
                      tierUsage.lastModel || model,
                      lazyAccountId,
                      'openai',
                      tierUsage.serviceTier || null,
                      createRequestDetailMeta(req, {
                        stream: true,
                        statusCode: 101,
                        billingUsage: usagePayload,
                        requestBody: {
                          path: pathname,
                          durationMs,
                          wsKind,
                          lazy: true,
                          serviceTier: tierUsage.serviceTier || null,
                        },
                      }),
                    )
                  }
                } else if (durationMs >= 1000) {
                  const usagePayload = { input_tokens: 0, output_tokens: 0, request_count: 1 }
                  await apiKeyService.recordUsage(
                    apiKeyData.id,
                    usagePayload,
                    model,
                    lazyAccountId,
                    'openai',
                    null,
                    createRequestDetailMeta(req, {
                      stream: true,
                      statusCode: 101,
                      billingUsage: usagePayload,
                      requestBody: { path: pathname, durationMs, wsKind, lazy: true },
                    }),
                  )
                } else {
                  return
                }
              } catch (e) {
                console.error(e)
              }
            }
            await codexResponsesWsBridge.handleResponsesWebSocketLazyPassthrough(req, socket, head, {
              apiKeyData,
              releaseAuth: async () => {
                try {
                  await finalizeBilling()
                } catch (e) {
                  console.error(e)
                }
                await releaseAuth()
              },
              sessionId,
              onUpstreamTextMessage: (text) => {
                try {
                  // 仅上游帧可入账 usage
                  if (typeof usageAcc.ingestUpstreamText === 'function') {
                    usageAcc.ingestUpstreamText(text)
                  } else {
                    usageAcc.ingestText(text)
                  }
                } catch (e) {
                  console.error(e)
                }
              },
              onClientTextMessage: (text) => {
                try {
                  // 客户端只采 response.create 档位，禁止伪造 usage
                  // DEC_20260906_011816
                  if (typeof usageAcc.ingestClientText === 'function') {
                    usageAcc.ingestClientText(text)
                  }
                } catch (e) {
                  console.error(e)
                }
              },
              onUpgrade: ({ accountId, selfBilled = false } = {}) => {
                upgradedOk = true
                lazyAccountId = accountId
                // http_bridge 内 runOneTurn 已 recordUsage；外层不可再兜底记 request_count
                if (selfBilled === true) {
                  billed = true
                }
              },
            })
            return
          }
        }

        let accessToken
        let accountId
        let account
        let boundModel = handshakeModel
        try {
          if (callId) {
            const binding = await codexRealtime.getRealtimeCallBinding(callId)
            if (!binding || !binding.accountId) {
              await releaseAuth()
              writeSocketError(socket, 404, 'Realtime call not found or expired')
              return
            }
            if (!binding.apiKeyId || binding.apiKeyId !== apiKeyData.id) {
              logger.security(
                `[${wsKind}] call_id hijack blocked callId=${callId} key=${apiKeyData.id} owner=${binding.apiKeyId || '-'}`,
              )
              await releaseAuth()
              writeSocketError(socket, 403, 'Realtime call does not belong to this API key')
              return
            }
            ;({ accountId } = binding)
            boundModel = binding.model || boundModel
            account = await openaiAccountService.getAccount(accountId)
            if (!account) {
              throw new Error(`Bound realtime account ${accountId} not found`)
            }
            if (openaiAccountService.isTokenExpired(account) && account.refreshToken) {
              await openaiAccountService.refreshAccountToken(accountId)
              account = await openaiAccountService.getAccount(accountId)
            }
            accessToken = openaiAccountService.decrypt(account.accessToken)
          } else {
            const selected = await unifiedOpenAIScheduler.selectAccountForApiKey(
              apiKeyData,
              sessionId ? crypto.createHash('sha256').update(String(sessionId)).digest('hex') : null,
              // Responses/Realtime 握手尽量带 model，避免共享池选到不支持模型的账户
              boundModel,
            )
            ;({ accountId } = selected)
            if (selected.accountType && selected.accountType !== 'openai') {
              throw new Error(`${wsKind} requires OpenAI OAuth account`)
            }
            account = await openaiAccountService.getAccount(accountId)
            if (!account) {
              throw new Error('OpenAI account not found')
            }
            if (openaiAccountService.isTokenExpired(account) && account.refreshToken) {
              await openaiAccountService.refreshAccountToken(accountId)
              account = await openaiAccountService.getAccount(accountId)
            }
            accessToken = selected.accessToken || openaiAccountService.decrypt(account.accessToken)
          }

          if (!accessToken) {
            throw new Error(`Failed to resolve OpenAI accessToken for ${wsKind}`)
          }
        } catch (selectError) {
          console.error(selectError)
          await releaseAuth()
          writeSocketError(socket, 503, 'Service Unavailable')
          return
        }

        // 选号后才能读账户级 responsesWsMode（此前空对象导致账户配置永远无效）
        if (isResponsesWs) {
          const wsMode = codexResponsesWsBridge.resolveResponsesWsMode({ account })
          if (wsMode === 'http_bridge') {
            logger.info(`[ResponsesWS] mode=http_bridge(account) key=${apiKeyData.id} account=${accountId}`)
            await codexResponsesWsBridge.handleResponsesWebSocketHttpBridge(req, socket, head, {
              apiKeyData,
              releaseAuth,
              preselectedAccount: account,
              preselectedAccountId: accountId,
            })
            return
          }
        }

        const proxyResolution = proxyResolver.resolveAgent(account, 'codex')
        const isChatGptOAuth = Boolean(
          account?.accountId || account?.chatgptUserId || pathname.includes('/backend-api/'),
        )
        const targetUrl = isResponsesWs
          ? codexResponsesWs.resolveResponsesUpstreamWebSocketUrl({
              pathname,
              search: url.search || '',
              isChatGptOAuth,
            })
          : codexRealtime.resolveUpstreamWebSocketUrl({
              pathname,
              search: url.search || '',
              callId,
              isChatGptOAuth,
            })

        if (isResponsesWs && accountId) {
          responsesWsSessionPool.set(accountId, { targetUrl, isChatGptOAuth })
        }

        const headers = isResponsesWs
          ? codexResponsesWs.buildResponsesWebsocketUpstreamHeaders({
              accessToken,
              account,
              accountId,
              clientHeaders: req.headers,
            })
          : {
              authorization: `Bearer ${accessToken}`,
              'chatgpt-account-id': account?.accountId || account?.chatgptUserId || accountId,
              originator: req.headers.originator || 'codex_cli_rs',
              'session-id': req.headers['session-id'] || sessionId,
              'thread-id': req.headers['thread-id'],
              'user-agent': req.headers['user-agent'] || 'codex_cli_rs',
              'openai-alpha': req.headers['openai-alpha'] || 'quicksilver=v2',
            }

        // usage 嗅探 + 时长兜底计费（仅 101 升级成功后的会话可计费）
        // Responses WS 同样嗅探；无 token 事件时按时长兜底（与 Realtime 一致）
        const usageAcc = codexRealtime.createRealtimeUsageAccumulator()
        const startedAt = Date.now()
        let billed = false
        let upgradedOk = false

        const finalizeBilling = async () => {
          if (billed) {
            return
          }
          billed = true
          // 握手失败/超时/拒绝：不计费
          if (!upgradedOk) {
            logger.info(
              `[${wsKind}] skip billing (upgrade not established) key=${apiKeyData.id} callId=${callId || '-'}`,
            )
            return
          }
          try {
            const snap = usageAcc.snapshot()
            const durationMs = Math.max(0, Date.now() - startedAt)
            const durationSec = durationMs / 1000
            const model =
              snap.lastModel ||
              boundModel ||
              url.searchParams.get('model') ||
              (isResponsesWs ? 'gpt-5' : 'gpt-realtime')

            const cyberEvent = snap.cyberPolicyEvent || snap.lastErrorEvent
            if (
              isResponsesWs &&
              cyberEvent &&
              typeof codexResponsesWsBridge.isSessionCyberPolicyBlock === 'function' &&
              codexResponsesWsBridge.isSessionCyberPolicyBlock(cyberEvent)
            ) {
              logger.warn(`[${wsKind}] cyber policy hit on passthrough key=${apiKeyData.id} account=${accountId}`)
              req._crsCyberPolicyBlocked = true
            }

            const tierUsages = Array.isArray(snap.tierUsages) && snap.tierUsages.length > 0 ? snap.tierUsages : null
            let billedInputTokens = 0
            let billedOutputTokens = 0
            let billedCacheReadTokens = 0
            let billedEvents = 0
            if (tierUsages) {
              for (const tierUsage of tierUsages) {
                const cacheRead = Math.max(0, Number(tierUsage.cache_read_input_tokens) || 0)
                const cacheCreate = Math.max(0, Number(tierUsage.cache_creation_input_tokens) || 0)
                const totalInput = Math.max(0, Number(tierUsage.input_tokens) || 0)
                const usagePayload = {
                  input_tokens: Math.max(0, totalInput - cacheRead),
                  output_tokens: Math.max(0, Number(tierUsage.output_tokens) || 0),
                  cache_read_input_tokens: cacheRead,
                  cache_creation_input_tokens: cacheCreate,
                }
                if (
                  usagePayload.input_tokens <= 0 &&
                  usagePayload.output_tokens <= 0 &&
                  usagePayload.cache_read_input_tokens <= 0 &&
                  usagePayload.cache_creation_input_tokens <= 0
                ) {
                  continue
                }
                billedInputTokens += usagePayload.input_tokens
                billedOutputTokens += usagePayload.output_tokens
                billedCacheReadTokens += usagePayload.cache_read_input_tokens
                billedEvents += Number(tierUsage.eventCount) || 0
                await apiKeyService.recordUsage(
                  apiKeyData.id,
                  usagePayload,
                  tierUsage.lastModel || model,
                  accountId,
                  'openai',
                  tierUsage.serviceTier || null,
                  createRequestDetailMeta(req, {
                    stream: true,
                    statusCode: 101,
                    billingUsage: usagePayload,
                    requestBody: {
                      callId: callId || null,
                      path: pathname,
                      durationMs,
                      usageEvents: tierUsage.eventCount || snap.eventCount,
                      wsKind,
                      serviceTier: tierUsage.serviceTier || null,
                    },
                  }),
                )
              }
            } else if (durationSec >= 1) {
              // 无 token usage 时按时长兜底（仅已成功升级的会话）
              const usagePayload = {
                input_tokens: 0,
                output_tokens: 0,
                audio_input_seconds: isResponsesWs ? 0 : durationSec,
                ...(isResponsesWs ? { request_count: 1 } : {}),
              }
              await apiKeyService.recordUsage(
                apiKeyData.id,
                usagePayload,
                model,
                accountId,
                'openai',
                null,
                createRequestDetailMeta(req, {
                  stream: true,
                  statusCode: 101,
                  billingUsage: usagePayload,
                  requestBody: {
                    callId: callId || null,
                    path: pathname,
                    durationMs,
                    usageEvents: snap.eventCount,
                    wsKind,
                  },
                }),
              )
            } else {
              logger.info(
                `[${wsKind}] skip billing (no usage, short session) key=${apiKeyData.id} callId=${callId || '-'} durationMs=${durationMs}`,
              )
              return
            }

            try {
              if (typeof openaiAccountService.updateAccountUsage === 'function') {
                const tokenTotal = billedInputTokens + billedOutputTokens
                if (tokenTotal > 0) {
                  await openaiAccountService.updateAccountUsage(accountId, tokenTotal)
                }
              }
            } catch (accountUsageError) {
              console.error(accountUsageError)
            }

            logger.info(
              `[${wsKind}] billed key=${apiKeyData.id} account=${accountId} model=${model} events=${billedEvents || snap.eventCount} durationMs=${durationMs} tokensIn=${billedInputTokens} tokensOut=${billedOutputTokens} cacheRead=${billedCacheReadTokens}`,
            )
          } catch (billError) {
            console.error(billError)
            logger.error(`[${wsKind}] billing failed: ${billError.message}`)
          }
        }

        const releaseOnce = (() => {
          let done = false
          return async (err = null) => {
            if (done) {
              return
            }
            done = true
            try {
              await finalizeBilling()
            } catch (e) {
              console.error(e)
            }
            try {
              proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, err)
            } catch (reportError) {
              console.error(reportError)
            }
            await releaseAuth()
          }
        })()

        logger.info(
          `[${wsKind}] proxy upgrade ${pathname} callId=${callId || '-'} key=${apiKeyData.id} -> ${targetUrl}`,
        )

        forceCloseSocket = () => {
          try {
            socket.destroy()
          } catch (_) {
            /*ignore */
          }
        }

        proxyWebSocketUpgrade(req, socket, head, {
          targetUrl,
          headers,
          agent: proxyResolution.agent || null,
          handshakeTimeoutMs: 30000,
          // 禁止协商压缩扩展：压缩帧 RSV1 会导致 usage 嗅探失败并误按时长计费
          stripExtensions: true,
          onUpgrade: (upRes) => {
            upgradedOk = true
            // 原生 WS 101 响应头挂 req，供 request detail 上游 ID
            if (req && typeof req === 'object' && upRes && upRes.headers) {
              req._crsUpstreamHeaders = upRes.headers
              req._crsUpstreamRequestIdHeader =
                account?.upstreamRequestIdHeader || account?.extra?.upstreamRequestIdHeader || null
            }
          },
          onUpstreamTextMessage: (text) => {
            try {
              if (typeof usageAcc.ingestUpstreamText === 'function') {
                usageAcc.ingestUpstreamText(text)
              } else {
                usageAcc.ingestText(text)
              }
            } catch (e) {
              console.error(e)
            }
          },
          onClientToUpstreamText: (text) => {
            try {
              // 客户端只采 response.create 档位，禁止伪造 usage
              // DEC_20260906_011816
              if (typeof usageAcc.ingestClientText === 'function') {
                usageAcc.ingestClientText(text)
              }
            } catch (e) {
              console.error(e)
            }
            try {
              if (typeof codexResponsesWsBridge.rewriteClientWsTextForUpstream === 'function') {
                return codexResponsesWsBridge.rewriteClientWsTextForUpstream(text)
              }
            } catch (e) {
              console.error(e)
            }
            return text
          },
          onClose: (err) => {
            // DEC_20260905_194420 passthrough 路径补记会话级 cyber policy
            try {
              const snap = usageAcc.snapshot()
              const cyberEvent = snap.cyberPolicyEvent || snap.lastErrorEvent
              if (
                cyberEvent &&
                typeof codexResponsesWsBridge.isSessionCyberPolicyBlock === 'function' &&
                codexResponsesWsBridge.isSessionCyberPolicyBlock(cyberEvent)
              ) {
                logger.warn(`[${wsKind}] cyber policy hit on passthrough key=${apiKeyData.id} account=${accountId}`)
                req._crsCyberPolicyBlocked = true
              }
            } catch (e) {
              console.error(e)
            }
            releaseOnce(err).catch((e) => console.error(e))
          },
        })
      } catch (error) {
        console.error(error)
        logger.error('[CodexWS] upgrade failed:', error.message)
        try {
          await releaseAuth()
        } catch (releaseError) {
          console.error(releaseError)
        }
        writeSocketError(socket, 500, 'Internal Server Error')
      }
    })
  }

  async start() {
    try {
      await this.initialize()

      this.server = this.app.listen(config.server.port, config.server.host, () => {
        const { port } = config.server
        // 依实际监听地址推导 Local / Network（对齐 llysc 输出契约，明确标注而非无差别罗列）
        const { local, networks } = getBannerEndpoints(config.server.host)
        const routes = [
          { label: 'Web interface', path: '/admin-next/api-stats' },
          { label: 'API endpoint', path: '/api/v1/messages' },
          { label: 'Official aliases', path: '/v1/*| /backend-api/codex/*| /v1beta/*' },
          { label: 'Admin API', path: '/admin' },
          { label: 'Health check', path: '/health' },
          { label: 'Metrics', path: '/metrics' },
        ]

        logger.start(`Claude Relay Service started on ${config.server.host}:${port}`)
        logger.info(`- APP_ENV: ${config.server.nodeEnv || env.NODE_ENV || 'development'}`)
        logger.info(`- Locale: ${new Date().toString()}`)
        logger.info(`- 业务时区: ${formatBusinessTime()}`)
        for (const route of routes) {
          logger.info(`${route.label}:`)
          if (local) {
            logger.info(`- Local: http://${local}:${port}${route.path}`)
          }
          // 多网卡逐条标注 Network，用户自行识别物理网卡/Docker/WSL/VPN
          for (const host of networks) {
            logger.info(`- Network: http://${host}:${port}${route.path}`)
          }
        }
      })

      const serverTimeout = 600000 //默认10分钟
      this.server.timeout = serverTimeout
      this.server.keepAliveTimeout = serverTimeout + 5000 //keepAlive 稍长一点
      logger.info(`Server timeout set to ${serverTimeout}ms (${serverTimeout / 1000}s)`)

      // Codex Realtime sideband WebSocket 升级代理
      this._setupRealtimeWebSocketProxy()

      // 定期清理任务
      this.startCleanupTasks()

      // 优雅关闭
      this.setupGracefulShutdown()
    } catch (error) {
      logger.error('Failed to start server:', error)
      process.exit(1)
    }
  }

  // 初始化缓存监控
  async initializeCacheMonitoring() {
    try {
      logger.info('Initializing cache monitoring...')

      // 注册各个服务的缓存实例
      const services = [
        { name: 'claudeAccount', service: claudeAccountService },
        {
          name: 'claudeConsole',
          service: claudeConsoleAccountService,
        },
        { name: 'bedrockAccount', service: bedrockAccountService },
      ]

      // 注册已加载的服务缓存
      for (const { name, service } of services) {
        if (service && (service._decryptCache || service.decryptCache)) {
          const cache = service._decryptCache || service.decryptCache
          cacheMonitor.registerCache(`${name}_decrypt`, cache)
          logger.info(`Registered ${name} decrypt cache for monitoring`)
        }
      }

      // 初始化时打印一次统计
      setTimeout(() => {
        const stats = cacheMonitor.getGlobalStats()
        logger.info(`Cache System - Registered: ${stats.cacheCount} caches`)
      }, 5000)

      logger.success('Cache monitoring initialized')
    } catch (error) {
      logger.error('Failed to initialize cache monitoring:', error)
      // 不阻止应用启动
    }
  }

  startCleanupTasks() {
    // 每小时清理一次过期数据
    setInterval(async () => {
      try {
        logger.info('Starting scheduled cleanup...')

        const [expiredKeys, errorAccounts] = await Promise.all([
          apiKeyService.cleanupExpiredKeys(),
          claudeAccountService.cleanupErrorAccounts(),
          claudeAccountService.cleanupTempErrorAccounts(), //新增：清理临时错误账户
        ])

        await redis.cleanup()

        logger.success(`Cleanup completed: ${expiredKeys} expired keys, ${errorAccounts} error accounts reset`)
      } catch (error) {
        logger.error('Cleanup task failed:', error)
      }
    }, config.system.cleanupInterval)

    logger.info(`Cleanup tasks scheduled every ${config.system.cleanupInterval / 1000 / 60} minutes`)

    // 支付订单过期扫描 + 实例预留对账：每 5 分钟
    // 1) expire：关单前主动 query 上游，已付则补单（防丢单），未付才 expired
    // 2) reconcile：清实例当日额度 hash 里的孤儿/终态残留预留
    setInterval(
      async () => {
        try {
          await paymentOrderService.expireTimedOutOrders()
        } catch (error) {
          logger.error('[payment] expire orders task failed:', error)
        }
        try {
          await paymentOrderService.reconcileInstanceDailyReservations()
        } catch (error) {
          logger.error('[payment] reconcile instance reservations task failed:', error)
        }
      },
      5 * 60 * 1000,
    )

    // 启动限流状态自动清理服务
    // 每5分钟检查一次过期的限流状态，确保账号能及时恢复调度
    const cleanupIntervalMinutes = config.system.rateLimitCleanupInterval || 5 //默认5分钟
    rateLimitCleanupService.start(cleanupIntervalMinutes)
    logger.info(`Rate limit cleanup service started (checking every ${cleanupIntervalMinutes} minutes)`)

    // 启动并发计数自动清理任务（Phase 1 修复：解决并发泄漏问题）
    // 每分钟主动清理所有过期的并发项，不依赖请求触发
    setInterval(async () => {
      try {
        const keys = await redis.scanKeys(RedisKeys.concurrency.pattern)
        if (keys.length === 0) {
          return
        }

        const now = Date.now()
        let totalCleaned = 0
        let legacyCleaned = 0

        // 使用 Lua 脚本批量清理所有过期项
        for (const key of keys) {
          // 跳过已知非 Sorted Set 类型的键（这些键有各自的清理逻辑）
          // - concurrency:queue:stats:*是 Hash 类型
          // - concurrency:queue:wait_times:*是 List 类型
          // - concurrency:queue:*(不含stats/wait_times) 是 String 类型
          if (
            key.startsWith(RedisKeys.concurrency.queueStatsPrefix) ||
            key.startsWith(RedisKeys.concurrency.queueWaitTimesPrefix) ||
            (key.startsWith(RedisKeys.concurrency.queuePrefix) &&
              !key.includes(':stats:') &&
              !key.includes(':wait_times:'))
          ) {
            continue
          }

          try {
            // 使用原子 Lua 脚本：先检查类型，再执行清理
            // 返回值：0 = 正常清理无删除，1 = 清理后删除空键，-1 = 遗留键已删除
            const result = await redis.client.eval(RedisLua.concurrency.cleanupExpiredZset, 1, key, now)
            if (result === 1) {
              totalCleaned++
            } else if (result === -1) {
              legacyCleaned++
            }
          } catch (error) {
            logger.error(`Failed to clean concurrency key ${key}:`, error)
          }
        }

        if (totalCleaned > 0) {
          logger.info(`Concurrency cleanup: cleaned ${totalCleaned} expired keys`)
        }
        if (legacyCleaned > 0) {
          logger.warn(`Concurrency cleanup: removed ${legacyCleaned} legacy keys (wrong type)`)
        }
      } catch (error) {
        logger.error('Concurrency cleanup task failed:', error)
      }
    }, 60000) //每分钟执行一次

    logger.info('Concurrency cleanup task started (running every 1 minute)')

    // 启动用户消息队列服务
    // 先清理服务重启后残留的锁，防止旧锁阻塞新请求
    userMessageQueueService.cleanupStaleLocks().then(() => {
      // 然后启动定时清理任务
      userMessageQueueService.startCleanupTask()
    })

    // 清理服务重启后残留的并发排队计数器
    // 多实例部署时建议关闭此开关，避免新实例启动时清空其他实例的队列计数
    // 可通过 DELETE /admin/concurrency/queue 接口手动清理
    const clearQueuesOnStartup = env.CLEAR_CONCURRENCY_QUEUES_ON_STARTUP !== 'false'
    if (clearQueuesOnStartup) {
      redis.clearAllConcurrencyQueues().catch((error) => {
        logger.error('Error clearing concurrency queues on startup:', error)
      })
    } else {
      logger.info('Skipping concurrency queue cleanup on startup (CLEAR_CONCURRENCY_QUEUES_ON_STARTUP=false)')
    }

    // 启动账户定时测试调度器
    // 根据配置定期测试账户连通性并保存测试历史
    const accountTestSchedulerEnabled =
      env.ACCOUNT_TEST_SCHEDULER_ENABLED !== 'false' && config.accountTestScheduler?.enabled !== false
    if (accountTestSchedulerEnabled) {
      accountTestSchedulerService.start()
      logger.info('Account test scheduler service started')
    } else {
      logger.info('Account test scheduler service disabled')
    }

    // 启动代理池健康检查服务（分布式选主，仅 leader 实例执行）
    proxyHealthService.start()
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      logger.info(`Received ${signal}, starting graceful shutdown...`)

      if (this.server) {
        this.server.close(async () => {
          logger.info('HTTP server closed')

          // 清理 pricing service 的文件监听器
          try {
            pricingService.cleanup()
            logger.info('Pricing service cleaned up')
          } catch (error) {
            logger.error('Error cleaning up pricing service:', error)
          }

          // 清理 model service 的文件监听器
          try {
            modelService.cleanup()
            logger.info('Model service cleaned up')
          } catch (error) {
            logger.error('Error cleaning up model service:', error)
          }

          // 停止限流清理服务
          try {
            rateLimitCleanupService.stop()
            logger.info('Rate limit cleanup service stopped')
          } catch (error) {
            logger.error('Error stopping rate limit cleanup service:', error)
          }

          // 停止用户消息队列清理服务
          try {
            userMessageQueueService.stopCleanupTask()
            logger.info('User message queue service stopped')
          } catch (error) {
            logger.error('Error stopping user message queue service:', error)
          }

          // 停止费用排序索引服务
          try {
            costRankService.shutdown()
            logger.info('Cost rank service stopped')
          } catch (error) {
            logger.error('Error stopping cost rank service:', error)
          }

          // 停止账户定时测试调度器
          try {
            accountTestSchedulerService.stop()
            logger.info('Account test scheduler service stopped')
          } catch (error) {
            logger.error('Error stopping account test scheduler service:', error)
          }

          // 停止 API Key 索引周期对账定时器
          try {
            apiKeyIndexService.stopPeriodicDriftScan()
            logger.info('API Key index drift scan stopped')
          } catch (error) {
            logger.error('Error stopping API Key index drift scan:', error)
          }

          // 停止代理池服务
          try {
            proxyHealthService.stop()
            proxyPoolService.stop()
            logger.info('Proxy pool services stopped')
          } catch (error) {
            logger.error('Error stopping proxy pool services:', error)
          }

          // 清理所有并发计数（Phase 1 修复：防止重启泄漏）
          try {
            logger.info('Cleaning up all concurrency counters...')
            const keys = await redis.scanKeys(RedisKeys.concurrency.pattern)
            if (keys.length > 0) {
              await redis.batchDelChunked(keys)
              logger.info(`Cleaned ${keys.length} concurrency keys`)
            } else {
              logger.info('No concurrency keys to clean')
            }
          } catch (error) {
            logger.error('Error cleaning up concurrency counters:', error)
            // 不阻止退出流程
          }

          try {
            await redis.disconnect()
            logger.info('Redis disconnected')
          } catch (error) {
            logger.error('Error disconnecting Redis:', error)
          }

          logger.success('Graceful shutdown completed')
          process.exit(0)
        })

        // 强制关闭超时
        setTimeout(() => {
          logger.warn('Forced shutdown due to timeout')
          process.exit(1)
        }, 10000)
      } else {
        process.exit(0)
      }
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))

    // 处理未捕获异常
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error)
      shutdown('uncaughtException')
    })

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection at:', promise, 'reason:', reason)
      shutdown('unhandledRejection')
    })
  }
}

// 启动应用（ESM: 直接执行入口时跑 bootstrap）
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  const app = new Application()
  app.start().catch((error) => {
    logger.error('Application startup failed:', error)
    process.exit(1)
  })
}
