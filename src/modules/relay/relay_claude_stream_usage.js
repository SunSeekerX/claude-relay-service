import { getRequestTimings } from '../../common/request_timing.js'
import { logger } from '../../common/logger.js'
import { requestDetailService } from './relay_request_detail_service.js'

export const createClaudeStreamFinalizer = ({
  state,
  usageCallback,
  clientRequest,
  accountId,
  accountType
}) => {
  let finalized = null
  return (transportError = null) => {
    if (finalized) {
      return finalized
    }
    const result = state.finish(transportError)
    const usage = state.getUsage()
    clientRequest?._crsRecordRelayResult?.({ ...result, hasUsage: Boolean(usage), final: true })
    if (clientRequest) {
      clientRequest._crsUsageDetailHandled = true
    }
    // DEC_20261013_223237 失败或截断按最后有效累计用量结算一次，未上报用量不估算。
    finalized = Promise.resolve().then(async () => {
      try {
        if (usage) {
          await usageCallback?.({ ...usage, accountId }, result)
        } else if (clientRequest) {
          await requestDetailService.captureUnmeteredRequest(clientRequest, {
            apiKeyId: clientRequest.apiKey?.id,
            accountId,
            accountType,
            result: { ...result, model: state.usage.model, stream: true }
          })
        }
      } catch (error) {
        logger.error('Failed to record Claude stream usage:', error)
      }
      logger.info('Claude stream finished', {
        requestId: clientRequest?.requestId,
        accountId,
        accountType,
        terminalType: state.terminalType,
        statusCode: result.statusCode,
        hasUsage: Boolean(usage),
        timings: getRequestTimings(clientRequest)
      })
      return result
    })
    return finalized
  }
}
