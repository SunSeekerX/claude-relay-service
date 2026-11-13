import { apiKeyService } from '../apikey/apikey_service.js'
import { grokAccountService } from '../account/account_grok_service.js'
import { logger } from '../../common/logger.js'
import { requestDetailService } from './relay_request_detail_service.js'
import {
  buildTokenUsagePayload,
  createRequestDetailMeta,
  normalizeOpenAITokenUsage,
} from './relay_request_detail_helper.js'

export const recordGrokSpeechUsage = async (req, keyData, account, data, streaming, result) => {
  await grokAccountService.updateAccountUsage(account.id).catch((error) => {
    logger.warn('Failed to update Grok speech last-used time', { error, accountId: account.id })
  })
  const model = streaming ? 'grok-stt-streaming' : 'grok-stt'
  const duration = data?.duration
  const validDuration = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
  const usage = data?.usage
  const hasTokens =
    usage && ['input_tokens', 'output_tokens'].some((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
  const meta = createRequestDetailMeta(req, {
    ...result,
    stream: streaming,
    requestBody: { model, transport: streaming ? 'websocket' : 'http' },
    billingUsage: validDuration ? { audio_input_seconds: duration } : null,
  })
  // DEC_20261111_193038 Missing upstream metering is captured without estimated charges.
  if (!validDuration && !hasTokens) {
    return requestDetailService.captureUnmeteredRequest(req, {
      apiKeyId: keyData.id,
      accountId: account.id,
      accountType: 'grok',
      result: { ...meta, model, errorCode: meta.errorCode ?? 'upstream_usage_missing' },
    })
  }
  return apiKeyService.recordUsage(
    keyData.id,
    buildTokenUsagePayload({ ...normalizeOpenAITokenUsage(usage ?? {}), rawUsage: usage }),
    model,
    account.id,
    'grok',
    null,
    meta,
  )
}
