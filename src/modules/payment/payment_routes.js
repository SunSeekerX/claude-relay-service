import express from 'express'
import { asyncRoute } from '../../common/route_handler.js'
import { badRequest, unauthorized, notFound } from '../../common/http_result.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { planRepository } from './payment_plan_repository.js'
import { paymentConfig } from './payment_config.js'
import { paymentOrderService } from './payment_order_service.js'
import { paymentSession } from './payment_session.js'
import {
  parseCreatePaymentSessionBody,
  parsePaymentTokenBody,
  parseCreateOrderBody,
  parseListOrdersBody,
  parseOrderActionBody,
} from './payment_routes_schema.js'
// 用户支付路由：充值商品展示（公开只读，仅定价信息）+ 余额/下单/订单/查单/取消。
// 身份模型：首次用【完整 apiKey】换取短期会话 token（POST /session），之后所有涉及具体 key 的
// 操作只携带 token（绑定 keyId、滑动续期），避免明文 apiKey 在每个请求体反复上行。

export const router = express.Router()

const sessionInvalid = (msg) =>
  unauthorized(msg || '会话已失效，请重新验证 API Key', {
    reason: 'payment_session_invalid',
  })

// 用会话 token 解析持有的 keyId（token 由 /session 用完整 apiKey 换取）。
const resolveKeyId = async (token) => {
  const keyId = await paymentSession.resolve(token)
  if (!keyId) {
    throw sessionInvalid()
  }
  const status = await apiKeyService.validateKeyActiveById(keyId)
  if (!status.valid) {
    await paymentSession.revoke(token)
    throw sessionInvalid(status.error || 'API Key 不可用')
  }
  return { keyId, keyData: status.keyData }
}

const guardOrder = async (orderId, token) => {
  const { keyId } = await resolveKeyId(token)
  const order = await paymentOrderService.getOrder(orderId)
  if (!order || order.apiKeyId !== keyId) {
    throw notFound('订单不存在')
  }
  return { keyId, order }
}

// 公开：在售充值商品 + 配置
router.get(
  '/plans',
  asyncRoute('[payment] list plans error', async () => {
    const [plans, config] = await Promise.all([planRepository.list({ enabledOnly: true }), paymentConfig.getConfig()])
    return {
      enabled: config.enabled,
      allowCustomAmount: config.allowCustomAmount && config.customRatio > 0,
      customRatio: config.customRatio,
      enabledPaymentTypes: config.enabledPaymentTypes,
      plans,
    }
  }),
)

// 用完整 apiKey 换取会话 token
router.post(
  '/session',
  asyncRoute('[payment] issue session error', async (req) => {
    const { apiKey } = parseCreatePaymentSessionBody(req.body)
    const validation = await apiKeyService.validateApiKeyForStats(apiKey)
    if (!validation.valid) {
      throw unauthorized(validation.error || 'apiKey 无效')
    }
    const { token, expiresIn } = await paymentSession.issue(validation.keyData.id)
    return { token, expiresIn }
  }),
)

router.post(
  '/balance',
  asyncRoute('[payment] get balance error', async (req) => {
    const { token } = parsePaymentTokenBody(req.body)
    const { keyId, keyData } = await resolveKeyId(token)
    const balance = await paymentOrderService.getBalance(keyId)
    return { balance, billingMode: keyData.billingMode || 'postpaid' }
  }),
)

router.post(
  '/orders',
  asyncRoute('[payment] create order error', async (req) => {
    const input = parseCreateOrderBody(req.body)
    const { keyId } = await resolveKeyId(input.token)
    try {
      return await paymentOrderService.createOrder({
        apiKeyId: keyId,
        planId: input.planId,
        customQuota: input.customQuota,
        paymentType: input.paymentType,
      })
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.post(
  '/orders/query',
  asyncRoute('[payment] list orders error', async (req) => {
    const input = parseListOrdersBody(req.body)
    const { keyId } = await resolveKeyId(input.token)
    return paymentOrderService.listOrdersByApiKey(keyId, {
      offset: input.offset || 0,
      limit: input.limit || 20,
    })
  }),
)

router.post(
  '/orders/:id/get',
  asyncRoute('[payment] get order error', async (req) => {
    const { token } = parseOrderActionBody(req.body)
    const { order } = await guardOrder(req.params.id, token)
    return order
  }),
)

router.post(
  '/orders/:id/verify',
  asyncRoute('[payment] verify order error', async (req) => {
    const { token } = parseOrderActionBody(req.body)
    await guardOrder(req.params.id, token)
    return paymentOrderService.verifyOrder(req.params.id)
  }),
)

router.post(
  '/orders/:id/cancel',
  asyncRoute('[payment] cancel order error', async (req) => {
    const { token } = parseOrderActionBody(req.body)
    const { keyId } = await guardOrder(req.params.id, token)
    try {
      return await paymentOrderService.cancelOrder(req.params.id, keyId)
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)
