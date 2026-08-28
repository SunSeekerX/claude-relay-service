import express from 'express'
import { quotaCardService } from './payment_quota_card_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { badRequest, notFound } from '../../common/http_result.js'
import {
  parseQuotaLimitsBody,
  parseCreateQuotaCardBody,
  parseToggleQuotaCardBody,
  parseRevokeRedemptionBody,
  parseExtendExpiryBody,
} from './payment_routes_schema.js'
/**
 * 额度卡/时间卡管理路由
 */
export const router = express.Router()

// 获取额度卡上限配置
router.get(
  '/quota-cards/limits',
  authenticateAdmin,
  asyncRoute('Failed to get quota card limits', async () => quotaCardService.getLimitsConfig()),
)

// 更新额度卡上限配置
router.put(
  '/quota-cards/limits',
  authenticateAdmin,
  asyncRoute('Failed to save quota card limits', async (req) => {
    const input = parseQuotaLimitsBody(req.body)
    return quotaCardService.saveLimitsConfig(input)
  }),
)

// 获取额度卡列表
router.get(
  '/quota-cards',
  authenticateAdmin,
  asyncRoute('Failed to get quota cards', async (req) => {
    const { status, type, search, limit = 100, offset = 0 } = req.query
    return quotaCardService.getAllCards({
      status,
      type,
      search,
      limit: parseInt(limit),
      offset: parseInt(offset),
    })
  }),
)

// 获取额度卡统计
router.get(
  '/quota-cards/stats',
  authenticateAdmin,
  asyncRoute('Failed to get quota card stats', async () => quotaCardService.getCardStats()),
)

// 获取单个额度卡详情
router.get(
  '/quota-cards/:id',
  authenticateAdmin,
  asyncRoute('Failed to get quota card', async (req) => {
    const card = await quotaCardService.getCardById(req.params.id)
    if (!card) {
      throw notFound('Card not found')
    }
    return card
  }),
)

// 创建额度卡
router.post(
  '/quota-cards',
  authenticateAdmin,
  asyncRoute('Failed to create quota card', async (req) => {
    const input = parseCreateQuotaCardBody(req.body)
    const batchCount = input.count
    if (batchCount > quotaCardService.MAX_BATCH_COUNT) {
      throw badRequest(`count must not exceed ${quotaCardService.MAX_BATCH_COUNT}`)
    }

    const createdBy = req.session?.username || 'admin'
    const options = {
      type: input.type,
      quotaAmount: parseFloat(input.quotaAmount || 0),
      timeAmount: parseInt(input.timeAmount || 0),
      timeUnit: input.timeUnit || 'days',
      expiresAt: input.expiresAt,
      note: input.note,
      codePrefix: input.codePrefix,
      createdBy,
    }

    if (batchCount > 1) {
      return quotaCardService.createCardsBatch(options, batchCount)
    }
    return quotaCardService.createCard(options)
  }),
)

// 删除未使用的额度卡
router.delete(
  '/quota-cards/:id',
  authenticateAdmin,
  asyncRoute('Failed to delete quota card', async (req) => quotaCardService.deleteCard(req.params.id)),
)

// 启用/禁用未使用的额度卡
router.post(
  '/quota-cards/:id/toggle',
  authenticateAdmin,
  asyncRoute('Failed to toggle quota card status', async (req) => {
    const { enabled } = parseToggleQuotaCardBody(req.body)
    return quotaCardService.setCardEnabled(req.params.id, enabled)
  }),
)

// 获取核销记录列表
router.get(
  '/redemptions',
  authenticateAdmin,
  asyncRoute('Failed to get redemptions', async (req) => {
    const { userId, apiKeyId, search, limit = 100, offset = 0 } = req.query
    return quotaCardService.getRedemptions({
      userId,
      apiKeyId,
      search,
      limit: parseInt(limit),
      offset: parseInt(offset),
    })
  }),
)

// 撤销核销
router.post(
  '/redemptions/:id/revoke',
  authenticateAdmin,
  asyncRoute('Failed to revoke redemption', async (req) => {
    const { reason } = parseRevokeRedemptionBody(req.body)
    const revokedBy = req.session?.username || 'admin'
    return quotaCardService.revokeRedemption(req.params.id, revokedBy, reason)
  }),
)

// 延长有效期
router.post(
  '/api-keys/:id/extend-expiry',
  authenticateAdmin,
  asyncRoute('Failed to extend expiry', async (req) => {
    const input = parseExtendExpiryBody(req.body)
    return apiKeyService.extendExpiry(req.params.id, parseInt(input.amount), input.unit || 'days', {
      restoreActiveOnExtend: true,
      operator: req.admin?.username || 'admin',
      operatorType: 'admin',
    })
  }),
)
