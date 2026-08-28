// 代理池管理写接口 zod schema
// URL 规则与 proxy_pool_core.validateProxyUrl 同一套正则，禁止 schema 过松导致 service 抛普通 Error→500

import { z, parseBody } from '../../common/parse_body.js'
import { validateProxyUrl } from './proxy_pool_core.js'

const proxyUrlSchema = z
  .string()
  .min(1)
  .refine((value) => validateProxyUrl(value), {
    message: 'expect http/https/socks4/socks5://[user:pass@]host:port',
  })

export const createProxyBodySchema = z.object({
  url: proxyUrlSchema,
  name: z.string().optional(),
  baseWeight: z.coerce.number().min(0).max(100).optional(),
  groupIds: z.array(z.string()).optional(),
})

export const updateProxyBodySchema = z
  .object({
    url: proxyUrlSchema.optional(),
    name: z.string().optional(),
    baseWeight: z.coerce.number().min(0).max(100).optional(),
    groupIds: z.array(z.string()).optional(),
    status: z.coerce.number().int().optional(),
  })
  .passthrough()

export const createProxyGroupBodySchema = z
  .object({
    name: z.string().min(1),
  })
  .passthrough()

export const updateProxyGroupBodySchema = z.object({}).passthrough()

// settings 细节仍由 service normalizeProxyPoolSettings 校验；此处只保证是对象
export const proxySettingsBodySchema = z.record(z.any())

export const parseCreateProxyBody = (body) => parseBody(createProxyBodySchema, body, '创建代理')
export const parseUpdateProxyBody = (body) => parseBody(updateProxyBodySchema, body, '更新代理')
export const parseCreateProxyGroupBody = (body) => parseBody(createProxyGroupBodySchema, body, '创建代理分组')
export const parseUpdateProxyGroupBody = (body) => parseBody(updateProxyGroupBodySchema, body, '更新代理分组')
export const parseProxySettingsBody = (body) => parseBody(proxySettingsBodySchema, body, '代理池设置')
