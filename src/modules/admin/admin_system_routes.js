import { fileURLToPath } from 'node:url'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import { claudeCodeHeadersService } from '../relay/relay_claude_code_headers_service.js'
import { claudeAccountService } from '../account/account_claude_service.js'
import { redis } from '../../infra/redis.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { logger } from '../../common/logger.js'
import { config } from '../../../config/config.js'
import { pricingService } from '../pricing/pricing_service.js'
import { modelService } from '../pricing/pricing_model_service.js'
import { initTranslatorRegistry, listTranslators } from '../relay/translator/relay_translator_index.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, badRequest, notFound } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const router = express.Router()

// === Claude Code Headers 管理 ===

// 获取所有 Claude Code headers
router.get(
  '/claude-code-headers',
  authenticateAdmin,
  asyncRoute('Failed to get Claude Code headers', async () => {
    const allHeaders = await claudeCodeHeadersService.getAllAccountHeaders()

    // 获取所有 Claude 账号信息
    const accounts = await claudeAccountService.getAllAccounts()
    const accountMap = {}
    accounts.forEach((account) => {
      accountMap[account.id] = account.name
    })

    // 格式化输出
    return Object.entries(allHeaders).map(([accountId, data]) => ({
      accountId,
      accountName: accountMap[accountId] || 'Unknown',
      version: data.version,
      userAgent: data.headers['user-agent'],
      updatedAt: data.updatedAt,
      headers: data.headers,
    }))
  }),
)

// 清除指定账号的 Claude Code headers
router.delete(
  '/claude-code-headers/:accountId',
  authenticateAdmin,
  asyncRoute('Failed to clear Claude Code headers', async (req) => {
    const { accountId } = req.params
    await claudeCodeHeadersService.clearAccountHeaders(accountId)
    return ok(undefined, `Claude Code headers cleared for account ${accountId}`)
  }),
)

// === 系统更新检查 ===

// 版本比较函数
const compareVersions = function compareVersions(current, latest) {
  const parseVersion = (v) => {
    const parts = v.split('.').map(Number)
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
    }
  }

  const currentV = parseVersion(current)
  const latestV = parseVersion(latest)

  if (currentV.major !== latestV.major) {
    return currentV.major - latestV.major
  }
  if (currentV.minor !== latestV.minor) {
    return currentV.minor - latestV.minor
  }
  return currentV.patch - latestV.patch
}

router.get(
  '/check-updates',
  authenticateAdmin,
  asyncRoute('Failed to check for updates', async (req) => {
    // 读取当前版本
    const versionPath = path.join(__dirname, '../../../VERSION')
    let currentVersion = '1.0.0'
    try {
      currentVersion = fs.readFileSync(versionPath, 'utf8').trim()
    } catch (err) {
      logger.warn('Could not read VERSION file:', err.message)
    }

    try {
      // 从缓存获取
      const cacheKey = 'version_check_cache'
      const cached = await redis.getClient().get(cacheKey)

      if (cached && !req.query.force) {
        const cachedData = JSON.parse(cached)
        const cacheAge = Date.now() - cachedData.timestamp

        // 缓存有效期1小时
        if (cacheAge < 3600000) {
          // 实时计算 hasUpdate，不使用缓存的值
          const hasUpdate = compareVersions(currentVersion, cachedData.latest) < 0

          return {
            current: currentVersion,
            latest: cachedData.latest,
            hasUpdate, // 实时计算，不用缓存
            releaseInfo: cachedData.releaseInfo,
            cached: true,
          }
        }
      }

      // 请求 GitHub API
      // 自维护 fork:更新检查指向本仓库 release,避免升级到本版本后被上游版本号误报"有更新"
      const githubRepo = 'SunSeekerX/claude-relay-service'
      const response = await axios.get(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Claude-Relay-Service',
        },
        timeout: 10000,
      })

      const release = response.data
      const latestVersion = release.tag_name.replace(/^v/, '')

      // 比较版本
      const hasUpdate = compareVersions(currentVersion, latestVersion) < 0

      const releaseInfo = {
        name: release.name,
        body: release.body,
        publishedAt: release.published_at,
        htmlUrl: release.html_url,
      }

      // 缓存结果；hasUpdate 每次实时计算，不进缓存
      await redis.getClient().set(
        cacheKey,
        JSON.stringify({
          latest: latestVersion,
          releaseInfo,
          timestamp: Date.now(),
        }),
        'EX',
        3600,
      ) // 1小时过期

      return {
        current: currentVersion,
        latest: latestVersion,
        hasUpdate,
        releaseInfo,
        cached: false,
      }
    } catch (error) {
      // 改进错误日志记录
      const errorDetails = {
        message: error.message || 'Unknown error',
        code: error.code,
        response: error.response
          ? {
              status: error.response.status,
              statusText: error.response.statusText,
              data: error.response.data,
            }
          : null,
        request: error.request ? 'Request was made but no response received' : null,
      }

      logger.error('Failed to check for updates:', errorDetails.message)

      // 处理 404 错误 - 仓库或版本不存在
      if (error.response && error.response.status === 404) {
        return {
          current: currentVersion,
          latest: currentVersion,
          hasUpdate: false,
          releaseInfo: {
            name: 'No releases found',
            body: 'The GitHub repository has no releases yet.',
            publishedAt: new Date().toISOString(),
            htmlUrl: '#',
          },
          warning: 'GitHub repository has no releases',
        }
      }

      // 如果是网络错误，尝试返回缓存的数据
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
        const cacheKey = 'version_check_cache'
        const cached = await redis.getClient().get(cacheKey)

        if (cached) {
          const cachedData = JSON.parse(cached)
          // 实时计算 hasUpdate
          const hasUpdate = compareVersions(currentVersion, cachedData.latest) < 0

          return {
            current: currentVersion,
            latest: cachedData.latest,
            hasUpdate, // 实时计算
            releaseInfo: cachedData.releaseInfo,
            cached: true,
            warning: 'Using cached data due to network error',
          }
        }
      }

      // 其他错误返回当前版本信息
      return {
        current: currentVersion,
        latest: currentVersion,
        hasUpdate: false,
        releaseInfo: {
          name: 'Update check failed',
          body: `Unable to check for updates: ${error.message || 'Unknown error'}`,
          publishedAt: new Date().toISOString(),
          htmlUrl: '#',
        },
        error: true,
        warning: error.message || 'Failed to check for updates',
      }
    }
  }),
)

// === OEM 设置管理 ===

// 获取OEM设置（公开接口，用于显示）
// 无 authenticateAdmin：登录页也需访问
router.get(
  '/oem-settings',
  asyncRoute('Failed to get OEM settings', async () => {
    const client = redis.getClient()
    const oemSettings = await client.get('oem:settings')

    // 默认设置
    const defaultSettings = {
      siteName: 'Claude Relay Service',
      siteIcon: '',
      siteIconData: '', // Base64编码的图标数据
      showAdminButton: true, // 是否显示管理后台按钮
      apiStatsNotice: {
        enabled: false,
        title: '',
        content: '',
      },
      updatedAt: new Date().toISOString(),
    }

    let settings = defaultSettings
    if (oemSettings) {
      try {
        settings = { ...defaultSettings, ...JSON.parse(oemSettings) }
      } catch (err) {
        logger.warn('Failed to parse OEM settings, using defaults:', err.message)
      }
    }

    // 添加 LDAP 启用状态到响应中
    return {
      ...settings,
      ldapEnabled: config.ldap && config.ldap.enabled === true,
    }
  }),
)

// 更新OEM设置
router.put(
  '/oem-settings',
  authenticateAdmin,
  asyncRoute('Failed to update OEM settings', async (req) => {
    const { siteName, siteIcon, siteIconData, showAdminButton, apiStatsNotice } = parseObjectBody(req.body, 'OEM 设置')

    // 验证输入
    if (!siteName || typeof siteName !== 'string' || siteName.trim().length === 0) {
      throw badRequest('Site name is required')
    }

    // 站点名会用于浏览器标题、页面头部和日志，收敛内部换行/连续空白为单个空格，避免多行注入日志与显示异常
    const normalizedSiteName = siteName.replace(/\s+/g, ' ').trim()

    if (normalizedSiteName.length > 100) {
      throw badRequest('Site name must be less than 100 characters')
    }

    // 验证图标数据大小（如果是base64）
    if (siteIconData && siteIconData.length > 500000) {
      // 约375KB
      throw badRequest('Icon file must be less than 350KB')
    }

    // 验证图标URL（如果提供）
    if (siteIcon && !siteIconData) {
      // 简单验证URL格式
      try {
        new URL(siteIcon)
      } catch (err) {
        throw badRequest('Invalid icon URL format')
      }
    }

    const settings = {
      siteName: normalizedSiteName,
      siteIcon: (siteIcon || '').trim(),
      siteIconData: (siteIconData || '').trim(), // Base64数据
      showAdminButton: showAdminButton !== false, // 默认为true
      apiStatsNotice: {
        enabled: apiStatsNotice?.enabled === true,
        title: (apiStatsNotice?.title || '').trim().slice(0, 100),
        content: (apiStatsNotice?.content || '').trim().slice(0, 2000),
      },
      updatedAt: new Date().toISOString(),
    }

    const client = redis.getClient()
    await client.set('oem:settings', JSON.stringify(settings))

    logger.info(`OEM settings updated: ${normalizedSiteName}`)

    return ok(settings, 'OEM settings updated successfully')
  }),
)

// === Claude Code 版本管理 ===

router.get(
  '/claude-code-version',
  authenticateAdmin,
  asyncRoute('Failed to get User-Agent information', async () => {
    const CACHE_KEY = RedisKeys.claudeCode.userAgentDaily

    // 获取缓存的统一User-Agent
    const unifiedUserAgent = await redis.client.get(CACHE_KEY)
    const ttl = unifiedUserAgent ? await redis.client.ttl(CACHE_KEY) : 0

    return {
      userAgent: unifiedUserAgent,
      isActive: !!unifiedUserAgent,
      ttlSeconds: ttl,
      lastUpdated: unifiedUserAgent ? new Date().toISOString() : null,
    }
  }),
)

// 清除统一Claude Code User-Agent缓存
router.post(
  '/claude-code-version/clear',
  authenticateAdmin,
  asyncRoute('Failed to clear cache', async () => {
    const CACHE_KEY = RedisKeys.claudeCode.userAgentDaily

    // 删除缓存的统一User-Agent
    await redis.client.del(CACHE_KEY)

    logger.info(`Admin manually cleared unified Claude Code User-Agent cache`)

    return ok(undefined, 'Unified User-Agent cache cleared successfully')
  }),
)

// === 模型价格管理 ===

// 获取生效模型价格（内部完整计费模型优先覆盖种子）
router.get(
  '/models/pricing',
  authenticateAdmin,
  asyncRoute('Failed to get model pricing', async () => {
    if (!pricingService.pricingData || Object.keys(pricingService.pricingData).length === 0) {
      await pricingService.loadPricingData()
    }
    const data = pricingService.getEffectivePricingData() || {}
    // meta 随价表一并放入 data 会污染模型名 key；价表本身作为 data，meta 作为并列字段
    // 前端现用 response.data 取价表 map，故返回价表本体；meta 若需要可走 status 接口
    return data
  }),
)

// 获取价格服务状态(含当前生效的数据源)
router.get(
  '/models/pricing/status',
  authenticateAdmin,
  asyncRoute('Failed to get pricing status', async () => {
    // 先解析:管理端可能在别处改过源,状态回显必须是最新生效值
    await pricingService.resolveSource()
    return pricingService.getStatus()
  }),
)

// 保存模型定价数据源。pricingUrl 留空 = 恢复默认源
router.put(
  '/models/pricing/source',
  authenticateAdmin,
  asyncRoute('Failed to update pricing source', async (req) => {
    try {
      const { pricingUrl, hashUrl } = parseObjectBody(req.body, '定价数据源')
      return await pricingService.setSource({ pricingUrl, hashUrl })
    } catch (error) {
      console.error(error)
      throw badRequest(error.message)
    }
  }),
)

// 从当前数据源立即拉取定价文件(改源后无需重启)。
// 注意与 POST /models/import 区分:本接口只更新价格数据,不改模型目录
router.post(
  '/models/pricing/pull',
  authenticateAdmin,
  asyncRoute('Failed to import pricing', async () => {
    const result = await pricingService.forceUpdate()
    const status = pricingService.getStatus()
    if (!result.success) {
      throw badRequest(result.message || 'Failed to import pricing')
    }
    return ok({ modelCount: status.modelCount, source: status.source }, result.message)
  }),
)

// 强制刷新价格数据
router.post(
  '/models/pricing/refresh',
  authenticateAdmin,
  asyncRoute('Failed to refresh pricing', async () => {
    const result = await pricingService.forceUpdate()
    if (!result.success) {
      throw badRequest(result.message || 'Failed to refresh pricing')
    }
    return ok(undefined, result.message)
  }),
)

// === 模型目录导入（从定价源导入模型） ===

// 列出定价源里可导入的模型（定价有、目录还没有的对话类模型）
router.get(
  '/models/importable',
  authenticateAdmin,
  asyncRoute('Failed to list importable models', async () => {
    if (!pricingService.pricingData || Object.keys(pricingService.pricingData).length === 0) {
      await pricingService.loadPricingData()
    }
    // 含 Grok 媒体兜底等 effective 条目，否则列表可见却无法导入
    const models = modelService.listImportableModels(pricingService.getEffectivePricingData())
    return { models, total: models.length }
  }),
)

// 导入选中的模型到目录
router.post(
  '/models/import',
  authenticateAdmin,
  asyncRoute('Failed to import models', async (req) => {
    try {
      const { models } = parseObjectBody(req.body, '导入模型')
      if (!pricingService.pricingData || Object.keys(pricingService.pricingData).length === 0) {
        await pricingService.loadPricingData()
      }
      return await modelService.importModels(models, pricingService.getEffectivePricingData())
    } catch (error) {
      console.error(error)
      throw badRequest(error.message)
    }
  }),
)

// 移除已导入的模型（内置模型不可移除）
router.delete(
  '/models/import',
  authenticateAdmin,
  asyncRoute('Failed to remove imported models', async (req) => {
    try {
      const { models } = parseObjectBody(req.body, '移除导入模型')
      return await modelService.removeImportedModels(models)
    } catch (error) {
      console.error(error)
      throw badRequest(error.message)
    }
  }),
)

// 已导入的内部模型列表（含完整计费数据摘要）
router.get(
  '/models/imported',
  authenticateAdmin,
  asyncRoute('Failed to list imported models', async () => {
    const models = modelService.listInternalModels()
    return { models, total: models.length }
  }),
)

// 单个内部模型详情（完整记录，供编辑回填）
router.get(
  '/models/internal/:name',
  authenticateAdmin,
  asyncRoute('Failed to get internal model', async (req) => {
    const model = modelService.getInternalModel(req.params.name)
    if (!model) {
      throw notFound('内部模型不存在')
    }
    return model
  }),
)

// 从种子构建完整内部模型预览（不落库，供「加入内部」弹窗预填，保证分段/多模态完整）
router.post(
  '/models/internal/from-seed',
  authenticateAdmin,
  asyncRoute('Failed to build from seed', async (req) => {
    try {
      const { name, asCopy } = parseObjectBody(req.body, '从种子构建模型')
      if (!pricingService.pricingData || Object.keys(pricingService.pricingData).length === 0) {
        await pricingService.loadPricingData()
      }
      // 与价表展示同源：种子 + Grok 兜底 + 已有内部覆盖
      return modelService.buildFromSeed(name, pricingService.getEffectivePricingData(), {
        asCopy: !!asCopy,
      })
    } catch (error) {
      console.error(error)
      throw badRequest(error.message)
    }
  }),
)

// 创建内部完整计费模型（手工）
router.post(
  '/models/internal',
  authenticateAdmin,
  asyncRoute('Failed to create internal model', async (req) => {
    try {
      return await modelService.createInternalModel(parseObjectBody(req.body, '创建内部模型'))
    } catch (error) {
      console.error(error)
      throw badRequest(error.message)
    }
  }),
)

// 整模保存/替换内部计费模型（完整数据，不是字段覆盖）
router.put(
  '/models/internal/:name',
  authenticateAdmin,
  asyncRoute('Failed to save internal model', async (req) => {
    try {
      const body = { ...parseObjectBody(req.body, '保存内部模型'), name: req.params.name }
      return await modelService.saveInternalModel(body)
    } catch (error) {
      console.error(error)
      throw badRequest(error.message)
    }
  }),
)

// 跨协议转换注册表（只读，供管理端展示）
router.get(
  '/translator-registry',
  authenticateAdmin,
  asyncRoute('Failed to list translator registry', async () => {
    initTranslatorRegistry()
    const entries = listTranslators()
    // 官方 CLI 路径并集 + 当前实现状态（扫缺口用）
    const protocolSurface = [
      {
        protocol: 'claude-messages',
        source: 'claude-code / ANTHROPIC_BASE_URL',
        paths: ['POST /v1/messages', 'POST /v1/messages/count_tokens', 'GET /v1/models (anthropic-version)'],
        status: 'covered',
        note: '根路径官方别名 + /api /claude 前缀',
      },
      {
        protocol: 'codex-responses-http',
        source: 'codex-rs wire_api=responses HTTP/SSE',
        paths: [
          'POST /v1/responses',
          'POST /v1/responses/compact',
          'POST /backend-api/codex/responses',
          'POST /backend-api/codex/responses/compact',
          'GET /backend-api/codex/models',
        ],
        status: 'covered',
        note: '官方别名 + /openai 前缀',
      },
      {
        protocol: 'codex-responses-ws',
        source: 'codex-rs responses_websockets + CLIProxyAPI',
        paths: [
          'GET upgrade /v1/responses',
          'GET upgrade /backend-api/codex/responses',
          'GET upgrade /openai/v1/responses',
        ],
        status: 'covered',
        note: '默认 passthrough 上游 WSS；CODEX_RESPONSES_WS_MODE=http_bridge 走 HTTP/SSE 桥 + tool repair',
      },
      {
        protocol: 'codex-realtime',
        source: 'codex-rs realtime/live',
        paths: [
          'POST /v1/realtime/calls',
          'POST /v1/live',
          'WS /v1/realtime/*',
          'WS /v1/live/*',
          'WS /backend-api/codex/{call_id}',
        ],
        status: 'covered',
        note: '建连 HTTP + sideband WS 透传',
      },
      {
        protocol: 'gemini-v1beta',
        source: 'gemini-cli generativelanguage',
        paths: [
          'POST /v1beta/models/:m:generateContent',
          'POST /v1beta/models/:m:streamGenerateContent',
          'POST /v1beta/models/:m:countTokens',
          'POST /v1beta/interactions',
        ],
        status: 'covered',
        note: '根路径 + /gemini 前缀',
      },
      {
        protocol: 'gemini-v1internal',
        source: 'gemini-cli cloudcode-pa CODE_ASSIST',
        paths: [
          'POST /v1internal:loadCodeAssist',
          'POST /v1internal:onboardUser',
          'POST /v1internal:generateContent',
          'POST /v1internal:streamGenerateContent',
          'POST /v1internal:countTokens',
        ],
        status: 'covered',
        note: 'Code Assist OAuth 主路径',
      },
      {
        protocol: 'grok-xai',
        source: 'grok-build / api.x.ai',
        paths: [
          'POST /grok/v1/chat/completions',
          'POST /grok/v1/responses',
          'POST /grok/v1/images/*',
          'POST /grok/v1/videos/*',
        ],
        status: 'covered-prefixed',
        note: '故意不挂根 /v1/*，避免与 unified chat 抢路由；客户端 base=/grok',
      },
    ]
    return {
      entries,
      protocolSurface,
      counts: {
        total: entries.length,
        good: entries.filter((entry) => entry.quality === 'good').length,
        fair: entries.filter((entry) => entry.quality === 'fair').length,
        discouraged: entries.filter((entry) => entry.quality === 'discouraged').length,
      },
    }
  }),
)
