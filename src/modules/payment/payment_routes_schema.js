// 支付管理/用户写接口 zod schema

import { z, parseBody, objectBodySchema } from '../../common/parse_body.js'

export const paymentConfigBodySchema = objectBodySchema

export const paymentPlanBodySchema = objectBodySchema

export const createPaymentSessionBodySchema = z.object({
  apiKey: z.string().min(1, '缺少 apiKey'),
})

export const paymentTokenBodySchema = z.object({
  token: z.string().min(1, '缺少 token'),
})

export const createOrderBodySchema = z.object({
  token: z.string().min(1, '缺少 token'),
  paymentType: z.string().min(1, '缺少 paymentType'),
  planId: z.string().optional(),
  customQuota: z.coerce.number().positive().optional(),
})

export const listOrdersBodySchema = z.object({
  token: z.string().min(1, '缺少 token'),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export const orderActionBodySchema = z.object({
  token: z.string().min(1, '缺少 token'),
})

export const manualCompleteBodySchema = z.object({
  reason: z.string().optional(),
  tradeNo: z.string().optional(),
})

export const refundResolveBodySchema = z.object({
  outcome: z.string().min(1, '缺少 outcome'),
})

export const providerBodySchema = objectBodySchema

export const quotaLimitsBodySchema = z.object({
  enabled: z.boolean().optional(),
  maxExpiryDays: z.coerce.number().optional(),
  maxTotalCostLimit: z.coerce.number().optional(),
})

export const createQuotaCardBodySchema = z.object({
  type: z.string().min(1, 'type is required'),
  quotaAmount: z.coerce.number().optional(),
  timeAmount: z.coerce.number().optional(),
  timeUnit: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
  note: z.string().optional(),
  count: z.coerce.number().int().min(1).optional().default(1),
  codePrefix: z.string().optional(),
})

export const toggleQuotaCardBodySchema = z.object({
  enabled: z.boolean(),
})

export const revokeRedemptionBodySchema = z.object({
  reason: z.string().optional(),
})

export const extendExpiryBodySchema = z.object({
  amount: z.coerce.number().positive('amount must be a positive number'),
  unit: z.string().optional().default('days'),
})

export const parsePaymentConfigBody = (body) => parseBody(paymentConfigBodySchema, body, '支付配置')
export const parsePaymentPlanBody = (body) => parseBody(paymentPlanBodySchema, body, '充值商品')
export const parseCreatePaymentSessionBody = (body) => parseBody(createPaymentSessionBodySchema, body, '支付会话')
export const parsePaymentTokenBody = (body) => parseBody(paymentTokenBodySchema, body, '支付凭证')
export const parseCreateOrderBody = (body) => parseBody(createOrderBodySchema, body, '下单')
export const parseListOrdersBody = (body) => parseBody(listOrdersBodySchema, body, '订单查询')
export const parseOrderActionBody = (body) => parseBody(orderActionBodySchema, body, '订单操作')
export const parseManualCompleteBody = (body) => parseBody(manualCompleteBodySchema, body, '手工补单')
export const parseRefundResolveBody = (body) => parseBody(refundResolveBodySchema, body, '退款裁决')
export const parseProviderBody = (body) => parseBody(providerBodySchema, body, '渠道实例')
export const parseQuotaLimitsBody = (body) => parseBody(quotaLimitsBodySchema, body, '额度卡上限')
export const parseCreateQuotaCardBody = (body) => parseBody(createQuotaCardBodySchema, body, '创建额度卡')
export const parseToggleQuotaCardBody = (body) => parseBody(toggleQuotaCardBodySchema, body, '额度卡启停')
export const parseRevokeRedemptionBody = (body) => parseBody(revokeRedemptionBodySchema, body, '撤销核销')
export const parseExtendExpiryBody = (body) => parseBody(extendExpiryBodySchema, body, '延长有效期')
