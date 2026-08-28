import express from 'express'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { badRequest, notFound, HttpError } from '../../common/http_result.js'
import { paymentConfig } from './payment_config.js'
import { planRepository } from './payment_plan_repository.js'
import { orderRepository } from './payment_order_repository.js'
import { providerRepository } from './payment_provider_repository.js'
import { paymentOrderService } from './payment_order_service.js'
import {
  parsePaymentConfigBody,
  parsePaymentPlanBody,
  parseManualCompleteBody,
  parseRefundResolveBody,
  parseProviderBody,
} from './payment_routes_schema.js'
// 管理端支付路由：全局配置 + 充值商品 CRUD + 订单管理 + 退款。逐端点 authenticateAdmin。

export const router = express.Router()

const asBadRequestIfValidation = (error) => {
  if (error?.message && error.message.startsWith('支付配置 ')) {
    throw badRequest(error.message)
  }
  throw error
}

// === 全局配置 ===
router.get(
  '/payment/config',
  authenticateAdmin,
  asyncRoute('[payment] get config error', async () => paymentConfig.getConfigStrict()),
)

router.put(
  '/payment/config',
  authenticateAdmin,
  asyncRoute('[payment] update config error', async (req) => {
    const input = parsePaymentConfigBody(req.body)
    try {
      return await paymentConfig.updateConfig(input, req.admin?.id || 'admin')
    } catch (error) {
      asBadRequestIfValidation(error)
    }
  }),
)

// === 充值商品 ===
router.get(
  '/payment/plans',
  authenticateAdmin,
  asyncRoute('[payment] list plans error', async () => planRepository.list()),
)

router.post(
  '/payment/plans',
  authenticateAdmin,
  asyncRoute('[payment] create plan error', async (req) => {
    try {
      return await planRepository.create(parsePaymentPlanBody(req.body))
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.put(
  '/payment/plans/:id',
  authenticateAdmin,
  asyncRoute('[payment] update plan error', async (req) => {
    try {
      return await planRepository.update(req.params.id, parsePaymentPlanBody(req.body))
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.delete(
  '/payment/plans/:id',
  authenticateAdmin,
  asyncRoute('[payment] delete plan error', async (req) => {
    try {
      return await planRepository.delete(req.params.id)
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

// === 订单管理 ===
router.get(
  '/payment/orders',
  authenticateAdmin,
  asyncRoute('[payment] list orders error', async (req) => {
    const offset = parseInt(req.query.offset || 0, 10)
    const limit = parseInt(req.query.limit || 20, 10)
    const status = req.query.status || ''
    return orderRepository.listAll({ offset, limit, status })
  }),
)

router.post(
  '/payment/orders/:id/verify',
  authenticateAdmin,
  asyncRoute('[payment] admin verify order error', async (req) => {
    try {
      return await paymentOrderService.verifyOrder(req.params.id)
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.post(
  '/payment/orders/:id/manual-complete',
  authenticateAdmin,
  asyncRoute('[payment] manual complete error', async (req) => {
    const input = parseManualCompleteBody(req.body)
    try {
      return await paymentOrderService.manualComplete(req.params.id, {
        operator: req.admin?.id || 'admin',
        reason: input.reason || '',
        tradeNo: input.tradeNo || '',
      })
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.post(
  '/payment/orders/:id/refund',
  authenticateAdmin,
  asyncRoute('[payment] refund order error', async (req) => {
    try {
      return await paymentOrderService.approveRefund(req.params.id, {
        operator: req.admin?.id || 'admin',
      })
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.post(
  '/payment/orders/:id/refund/resolve',
  authenticateAdmin,
  asyncRoute('[payment] resolve refund error', async (req) => {
    const input = parseRefundResolveBody(req.body)
    try {
      return await paymentOrderService.resolveRefundInDoubt(req.params.id, input.outcome, {
        operator: req.admin?.id || 'admin',
      })
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.get(
  '/payment/dashboard',
  authenticateAdmin,
  asyncRoute('[payment] dashboard error', async () => paymentOrderService.dashboard()),
)

router.get(
  '/payment/orders/:id/audit',
  authenticateAdmin,
  asyncRoute('[payment] audit error', async (req) => paymentOrderService.getAuditLog(req.params.id)),
)

// === 渠道实例 ===
router.get(
  '/payment/providers',
  authenticateAdmin,
  asyncRoute('[payment] list providers error', async (req) =>
    providerRepository.list({ providerKey: req.query.providerKey || '' }),
  ),
)

router.get(
  '/payment/providers/:id',
  authenticateAdmin,
  asyncRoute('[payment] get provider error', async (req) => {
    const provider = await providerRepository.getById(req.params.id, { withConfig: true })
    if (!provider) {
      throw notFound('Provider instance not found')
    }
    return provider
  }),
)

router.post(
  '/payment/providers',
  authenticateAdmin,
  asyncRoute('[payment] create provider error', async (req) => {
    try {
      return await providerRepository.create(parseProviderBody(req.body))
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.put(
  '/payment/providers/:id',
  authenticateAdmin,
  asyncRoute('[payment] update provider error', async (req) => {
    const { id } = req.params
    const patch = parseProviderBody(req.body)
    const SENSITIVE_FIELDS = ['config', 'refundEnabled', 'supportedTypes', 'enabled', 'providerKey']
    const touchedSensitive = SENSITIVE_FIELDS.filter((field) => patch[field] !== undefined)
    if (touchedSensitive.length > 0) {
      const activeOrders = await orderRepository.countActiveByProviderInstance(id, {
        includeCompleted: false,
      })
      if (activeOrders > 0) {
        throw new HttpError(
          409,
          `该渠道实例仍被 ${activeOrders} 个在途订单（待支付/已支付/退款中）引用，不能修改 ${touchedSensitive.join('、')}（会导致在途订单验签、查单或退款执行失败）。请改为新增实例并切新单，待在途订单全部结清后再修改旧实例。`,
          { reason: 'provider_instance_in_use' },
        )
      }
    }
    try {
      return await providerRepository.update(id, patch)
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.delete(
  '/payment/providers/:id',
  authenticateAdmin,
  asyncRoute('[payment] delete provider error', async (req) => {
    const { id } = req.params
    const provider = await providerRepository.getById(id)
    if (!provider) {
      throw notFound('Provider instance not found')
    }
    const activeOrders = await orderRepository.countActiveByProviderInstance(id)
    if (activeOrders > 0) {
      throw new HttpError(
        409,
        `该渠道实例仍被 ${activeOrders} 个未完结订单引用（待支付/已支付/退款中/已完成），删除会导致这些订单无法查单、验签或退款。请改为「禁用」该实例，或待相关订单全部终结后再删除。`,
        { reason: 'provider_instance_in_use' },
      )
    }
    try {
      return await providerRepository.delete(id)
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)
