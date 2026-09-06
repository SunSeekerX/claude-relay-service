import express from 'express'
import { logger } from '../../common/logger.js'
import { redis } from '../../infra/redis.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, notFound } from '../../common/http_result.js'
import { z, parseBody } from '../../common/parse_body.js'
import { proxyPoolService } from './proxy_pool_service.js'
import { proxyHealthService } from './proxy_health_service.js'
import { maskProxyUrl, validateProxyUrl } from './proxy_pool_core.js'
// 代理池管理路由 — 代理/分组 CRUD、健康检查、质量检测、看板
// 挂载于 /admin/proxy-pool
// URL 规则与 proxy_pool_core.validateProxyUrl 同一套正则，禁止 schema 过松导致 service 抛普通 Error→500

const proxyUrlSchema = z
  .string()
  .min(1)
  .refine((value) => validateProxyUrl(value), {
    message: 'expect http/https/socks4/socks5://[user:pass@]host:port',
  })

const createProxyBodySchema = z.object({
  url: proxyUrlSchema,
  name: z.string().optional(),
  baseWeight: z.coerce.number().min(0).max(100).optional(),
  groupIds: z.array(z.string()).optional(),
})

const updateProxyBodySchema = z
  .object({
    url: proxyUrlSchema.optional(),
    name: z.string().optional(),
    baseWeight: z.coerce.number().min(0).max(100).optional(),
    groupIds: z.array(z.string()).optional(),
    status: z.coerce.number().int().optional(),
  })
  .passthrough()

const createProxyGroupBodySchema = z
  .object({
    name: z.string().min(1),
  })
  .passthrough()

const updateProxyGroupBodySchema = z.object({}).passthrough()

// settings 细节仍由 service normalizeProxyPoolSettings 校验；此处只保证是对象
const proxySettingsBodySchema = z.record(z.any())

const parseCreateProxyBody = (body) => parseBody(createProxyBodySchema, body, '创建代理')
const parseUpdateProxyBody = (body) => parseBody(updateProxyBodySchema, body, '更新代理')
const parseCreateProxyGroupBody = (body) => parseBody(createProxyGroupBodySchema, body, '创建代理分组')
const parseUpdateProxyGroupBody = (body) => parseBody(updateProxyGroupBodySchema, body, '更新代理分组')
const parseProxySettingsBody = (body) => parseBody(proxySettingsBodySchema, body, '代理池设置')

export const router = express.Router()

// 脱敏代理 url（隐藏认证信息）用于响应展示
// name 也过一遍：历史数据或手填可能把含凭据的完整 url 落到 name，maskProxyUrl 对非 URL 字符串原样返回，普通名字不受影响
const sanitizeProxyForResponse = (proxyConfig) => ({
  ...proxyConfig,
  name: maskProxyUrl(proxyConfig.name),
  url: maskProxyUrl(proxyConfig.url),
})

// 删除代理/分组时，全平台扫描清理所有引用账户的 proxyGroupId/proxyId 字段，避免悬空绑定
const clearAccountBindings = async (kind, id) => {
  const cleared = await redis.clearProxyBindingFromAllAccounts(kind, id)
  if (cleared > 0) {
    logger.info(`[ProxyPool] cleared ${cleared} account binding(s) on ${kind}=${id} deletion`)
  }
}

// === 代理 CRUD ===

// 列出全部代理（附运行时状态 + 质量 + 出口IP）
router.get(
  '/proxies',
  authenticateAdmin,
  asyncRoute('Failed to list proxies', async () => {
    const rows = await proxyPoolService.listProxiesWithRuntime()
    return rows.map((row) => ({
      ...sanitizeProxyForResponse(row),
      states: row.states,
      quality: row.quality,
      exitInfo: row.exitInfo,
    }))
  }),
)

// 创建代理
router.post(
  '/proxies',
  authenticateAdmin,
  asyncRoute('Failed to create proxy', async (req) => {
    const input = parseCreateProxyBody(req.body)
    const proxyConfig = await proxyPoolService.createProxy(input)
    return sanitizeProxyForResponse(proxyConfig)
  }),
)

// 更新代理
router.put(
  '/proxies/:id',
  authenticateAdmin,
  asyncRoute('Failed to update proxy', async (req) => {
    const input = parseUpdateProxyBody(req.body)
    const proxyConfig = await proxyPoolService.updateProxy(req.params.id, input)
    return sanitizeProxyForResponse(proxyConfig)
  }),
)

// 删除代理
router.delete(
  '/proxies/:id',
  authenticateAdmin,
  asyncRoute('Failed to delete proxy', async (req) => {
    await clearAccountBindings('proxy', req.params.id)
    await proxyPoolService.deleteProxy(req.params.id)
    return ok()
  }),
)

// 立即对单个代理做健康检查
router.post(
  '/proxies/:id/health-check',
  authenticateAdmin,
  asyncRoute('Failed to health-check proxy', async (req) => {
    const proxyConfig = proxyPoolService.getProxyConfig(req.params.id)
    if (!proxyConfig) {
      throw notFound('Proxy not found')
    }
    return proxyHealthService.checkProxy(proxyConfig)
  }),
)

// 立即对单个代理做质量检测（5 项 + 出口IP）
router.post(
  '/proxies/:id/quality-check',
  authenticateAdmin,
  asyncRoute('Failed to quality-check proxy', async (req) => proxyHealthService.checkProxyQuality(req.params.id)),
)

// 健康检查历史
router.get(
  '/proxies/:id/health-history',
  authenticateAdmin,
  asyncRoute('Failed to get proxy health history', async (req) => redis.getProxyHealthHistory(req.params.id, 50)),
)

// === 分组 CRUD ===

router.get(
  '/groups',
  authenticateAdmin,
  asyncRoute('Failed to list proxy groups', async () =>
    proxyPoolService.getGroupsList().map((group) => ({
      ...group,
      memberCount: proxyPoolService.getGroupMembers(group.id).length,
    })),
  ),
)

router.post(
  '/groups',
  authenticateAdmin,
  asyncRoute('Failed to create proxy group', async (req) =>
    proxyPoolService.createGroup(parseCreateProxyGroupBody(req.body)),
  ),
)

router.put(
  '/groups/:id',
  authenticateAdmin,
  asyncRoute('Failed to update proxy group', async (req) =>
    proxyPoolService.updateGroup(req.params.id, parseUpdateProxyGroupBody(req.body)),
  ),
)

router.delete(
  '/groups/:id',
  authenticateAdmin,
  asyncRoute('Failed to delete proxy group', async (req) => {
    await clearAccountBindings('group', req.params.id)
    await proxyPoolService.deleteGroup(req.params.id)
    return ok()
  }),
)

// === 概览看板 ===

router.get(
  '/overview',
  authenticateAdmin,
  asyncRoute('Failed to get proxy overview', async () => {
    const configs = proxyPoolService.getAllProxyConfigs()
    // 健康/不健康口径只统计已启用代理，与列表页一致（禁用代理单独归类，不计入健康统计）
    const enabledConfigs = configs.filter((proxyConfig) => proxyConfig.status === 1)
    const healthy = enabledConfigs.filter((proxyConfig) => proxyConfig.isHealthy).length
    const enabled = enabledConfigs.length
    return {
      total: configs.length,
      enabled,
      healthy,
      unhealthy: enabled - healthy,
      groups: proxyPoolService.getGroupsList().length,
      routeVersion: proxyPoolService.localVersion,
    }
  }),
)

// === 全局设置（健康检查 / 熔断 / 慢启动调优参数） ===

router.get(
  '/settings',
  authenticateAdmin,
  asyncRoute('Failed to get proxy pool settings', async () => proxyPoolService.getSettings()),
)

router.put(
  '/settings',
  authenticateAdmin,
  asyncRoute('Failed to update proxy pool settings', async (req) => {
    const input = parseProxySettingsBody(req.body)
    const effective = await proxyPoolService.applySettings(input)
    proxyHealthService.reconfigure()
    return effective
  }),
)
