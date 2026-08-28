import express from 'express'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute, SEND_RAW } from '../../common/route_handler.js'
import { badRequest, HttpError } from '../../common/http_result.js'
import { logger } from '../../common/logger.js'
import { parseObjectBody } from '../../common/parse_body.js'
import * as migrationService from './account_migration_service.js'
/**
 * Admin Routes - Account Migration (import/export)
 * GET 导出：校验失败走信封；成功 zip/json 原样文件（SEND_RAW）
 * POST import/inspect：JSON 信封
 */

export const router = express.Router()

const VALID_FORMATS = ['crs', 'sub2api', 'cliproxyapi']

const toBool = (value) => value === true || value === 'true'

// 导出账户
router.get(
  '/accounts/export',
  authenticateAdmin,
  asyncRoute('Account export failed', async (req, res) => {
    const format = String(req.query.format || 'crs').toLowerCase()
    if (!VALID_FORMATS.includes(format)) {
      throw badRequest(`invalid format: ${format}`)
    }
    const ids =
      typeof req.query.ids === 'string' && req.query.ids.trim()
        ? req.query.ids
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null
    if (!toBool(req.query.include_secrets)) {
      throw new HttpError(400, 'Set include_secrets=true to export secrets', {
        reason: 'include_secrets_required',
      })
    }

    const result = await migrationService.exportAccounts({ format, ids })

    if (result.kind === 'empty') {
      throw new HttpError(400, '没有可导出的账户（所选账户均不支持该格式或读取失败）', {
        reason: 'no_exportable_accounts',
        data: {
          skipped: result.skipped || [],
          readErrors: result.readErrors || [],
        },
      })
    }

    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
    if (result.skipped && result.skipped.length > 0) {
      res.setHeader('X-Export-Skipped-Count', String(result.skipped.length))
      logger.warn(`Account export skipped ${result.skipped.length} account(s): ${JSON.stringify(result.skipped)}`)
    }
    if (result.readErrors && result.readErrors.length > 0) {
      res.setHeader('X-Export-Read-Errors-Count', String(result.readErrors.length))
      logger.warn(
        ` Account export read errors on ${result.readErrors.length} account(s): ${JSON.stringify(result.readErrors)}`,
      )
    }

    if (result.kind === 'zip') {
      res.setHeader('Content-Type', 'application/zip')
      res.send(result.buffer)
      return SEND_RAW
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.send(JSON.stringify(result.payload, null, 2))
    return SEND_RAW
  }),
)

// 导入预检
router.post(
  '/accounts/import/inspect',
  authenticateAdmin,
  asyncRoute('Account import inspect failed', async (req) => {
    const { filename, contentBase64 } = parseObjectBody(req.body, '导入账户预检')
    if (!contentBase64) {
      throw badRequest('contentBase64 is required')
    }
    return migrationService.inspectImport({ filename, contentBase64 })
  }),
)

// 执行导入
router.post(
  '/accounts/import',
  authenticateAdmin,
  asyncRoute('Account import failed', async (req) => {
    const { filename, contentBase64, options } = parseObjectBody(req.body, '导入账户')
    if (!contentBase64) {
      throw badRequest('contentBase64 is required')
    }
    const result = await migrationService.importAccounts({ filename, contentBase64, options })
    logger.info(
      ` Account import done: format=${result.format} created=${result.created} updated=${result.updated} skipped=${result.skipped} failed=${result.failed}`,
    )
    return result
  }),
)
