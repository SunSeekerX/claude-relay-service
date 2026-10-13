import crypto from 'node:crypto'
import { logger } from '../../common/logger.js'
import { parseWsClientMessage } from '../../common/gateway_ws_frame_sniffer.js'
import { validateWsApiKey, acquireWsTurnConcurrency } from '../../common/gateway_ws_api_key_auth.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import * as openaiAccountService from '../account/account_openai_service.js'
import { createRealtimeUsageAccumulator } from './relay_codex_realtime.js'
import { assertModelAccess } from './relay_model_access.js'
import {
  ResponsesStreamState,
  hasReportedTokenUsage,
  isResponsesTerminalEvent
} from './relay_responses_stream_state.js'
import {
  normalizeOpenAITokenUsage,
  buildTokenUsagePayload,
  createRequestDetailMeta
} from './relay_request_detail_helper.js'
import { requestDetailService } from './relay_request_detail_service.js'

export const createResponsesWsBilling = ({
  req,
  apiKeyData,
  accountType = 'openai',
  requiredPermission = 'openai',
  initialModel = null,
  onLeaseExpired = null,
  validateAccount = null,
  onTerminal = null
}) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  let accountId = null
  let accountValidator = validateAccount
  let selfBilled = false
  let pending = Promise.resolve()
  let billingError = null
  let closing = false
  const turnsByStream = new Map()
  const modelsByStream = new Map()
  const acceptedModelsByStream = new Map()
  const responseContexts = new Map()

  const recordTurn = async (entry, event) => {
    if (selfBilled || !accountId) {
      return
    }
    const turns = turnsByStream.get(entry.streamId) ?? []
    let index = turns.findIndex((turn) =>
      entry.responseId ? turn.responseId === entry.responseId : !turn.responseId
    )
    if (index === -1 && entry.responseId) {
      index = turns.findIndex((turn) => !turn.responseId)
    }
    const turn = index >= 0 ? turns.splice(index, 1)[0] : null
    if (turns.length === 0) {
      turnsByStream.delete(entry.streamId)
    }
    const inheritedModel =
      turns.at(-1)?.model ?? acceptedModelsByStream.get(entry.streamId) ?? initialModel
    if (inheritedModel) {
      modelsByStream.set(entry.streamId, inheritedModel)
    }
    const state = new ResponsesStreamState({ model: entry.model })
    state.observe(event)
    const result = state.finish()
    const requestId = entry.responseId ?? crypto.randomUUID()
    const meta = createRequestDetailMeta(req, {
      ...result,
      requestId,
      requestStartedAt: turn?.startedAt ?? Date.now(),
      groupCostHoldGroupId: turn?.keyData?.groupCostHoldGroupId ?? null,
      groupCostHoldMeta: turn?.keyData?.groupCostHoldMeta ?? null,
      stream: true,
      billingDedupId: crypto
        .createHash('sha256')
        .update([apiKeyData.id, accountId, requestId].join(':'))
        .digest('hex'),
      throwOnBillingFailure: true,
      requestBody: { model: entry.model, stream_id: entry.streamId, transport: 'websocket' }
    })
    try {
      try {
        await onTerminal?.(event, entry)
      } catch (error) {
        logger.error('Failed to update WebSocket upstream account state', { error, accountId })
      }
      if (entry.warmup) {
        return
      }
      const reportedTokens = hasReportedTokenUsage(entry.rawUsage)
      const reportedGrokCost =
        accountType === 'grok' &&
        Boolean(
          entry.rawUsage &&
          ((entry.rawUsage.cost_in_usd_ticks !== undefined &&
            entry.rawUsage.cost_in_usd_ticks !== null) ||
            entry.rawUsage.server_side_tool_usage_details)
        )
      if (!reportedTokens && !reportedGrokCost) {
        await requestDetailService.captureUnmeteredRequest(req, {
          apiKeyId: apiKeyData.id,
          accountId,
          accountType,
          result: { ...meta, model: entry.model }
        })
        return
      }
      if (!reportedTokens) {
        meta.errorCode = meta.errorCode ?? 'token_usage_missing'
        meta.errorMessage = meta.errorMessage ?? 'Upstream reported charges without token usage'
      }
      const usage = normalizeOpenAITokenUsage(entry.rawUsage)
      const costs = await apiKeyService.recordUsage(
        apiKeyData.id,
        buildTokenUsagePayload({ ...usage, rawUsage: entry.rawUsage }),
        entry.model,
        accountId,
        accountType,
        entry.serviceTier,
        meta
      )
      if (turn?.keyData) {
        turn.keyData.groupCostHoldGroupId = null
        turn.keyData.groupCostHoldMeta = null
      }
      if (!costs.duplicate && accountType === 'openai') {
        await openaiAccountService
          .updateAccountUsage(accountId, usage.totalInputTokens + usage.outputTokens)
          .catch((error) => {
            logger.error('Failed to update WebSocket account usage', { error, accountId })
          })
      }
      if (turn?.transferred && !closing) {
        const auth = await validateWsApiKey(req, url, requiredPermission)
        if (!auth.ok) {
          onLeaseExpired?.()
          throw Object.assign(new Error(auth.message), { statusCode: auth.status, code: auth.code })
        }
        Object.assign(turn.keyData, auth.keyData, {
          groupCostHoldGroupId: null,
          groupCostHoldMeta: null
        })
        try {
          await accountValidator?.(entry.model, turn.keyData)
        } catch (error) {
          onLeaseExpired?.()
          throw error
        }
      }
    } finally {
      if (turn && !turn.transferred) {
        await turn.release()
      }
    }
  }

  const accumulator = createRealtimeUsageAccumulator({
    terminalOnly: true,
    retainUsage: false,
    onUsage: (entry, event) => {
      pending = pending
        .then(() => recordTurn(entry, event))
        .catch((error) => {
          billingError = error
          logger.error('Responses WebSocket turn billing failed', {
            error,
            accountId,
            responseId: entry.responseId
          })
        })
    }
  })

  const flush = async () => {
    await pending
    if (billingError) {
      throw Object.assign(new Error('WebSocket billing unavailable'), {
        statusCode: 503,
        code: 'billing_unavailable'
      })
    }
  }

  const beforeClientText = async (text) => {
    if (closing) {
      throw Object.assign(new Error('WebSocket closed'), { statusCode: 503 })
    }
    const message = parseWsClientMessage(text)
    if (!['response.create', 'response.append', 'response.steer'].includes(message.type)) {
      return
    }
    await flush()
    if (accumulator.snapshot().cyberPolicyEvent) {
      throw Object.assign(new Error('Session blocked by cyber policy; start a new session'), {
        statusCode: 403,
        code: 'session_blocked_by_cyber_policy'
      })
    }
    const auth = await validateWsApiKey(req, url, requiredPermission)
    if (!auth.ok) {
      throw Object.assign(new Error(auth.message), { statusCode: auth.status, code: auth.code })
    }
    const steering = message.type === 'response.steer'
    const parent = steering ? responseContexts.get(message.previous_response_id) : null
    if (steering && !parent) {
      throw Object.assign(new Error('Response not found on this connection'), {
        statusCode: 400,
        code: 'response_not_found'
      })
    }
    const streamId = steering
      ? parent.streamId
      : (message.stream_id ?? message.response?.stream_id ?? null)
    if (
      streamId !== null &&
      (typeof streamId !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(streamId))
    ) {
      throw Object.assign(new Error('Invalid stream_id'), {
        statusCode: 400,
        code: 'invalid_stream_id'
      })
    }
    if (accountType === 'grok' && (streamId !== null || steering)) {
      throw Object.assign(new Error('Unsupported Grok WebSocket event'), {
        statusCode: 400,
        code: 'invalid_request_error'
      })
    }
    if (
      streamId !== null &&
      !modelsByStream.has(streamId) &&
      [...modelsByStream.keys()].filter((key) => key !== null).length >= 32
    ) {
      throw Object.assign(new Error('WebSocket stream limit reached'), {
        statusCode: 400,
        code: 'websocket_stream_limit_reached'
      })
    }
    const model = steering
      ? parent.model
      : (message.response?.model ?? message.model ?? modelsByStream.get(streamId) ?? initialModel)
    let upstreamModel = model
    assertModelAccess(auth.keyData, model)
    const cachedModel = acceptedModelsByStream.get(streamId) ?? initialModel
    const inheritsModel =
      !steering && message.model === undefined && message.response?.model === undefined
    if (inheritsModel && !cachedModel) {
      throw Object.assign(new Error('Specify model until the first response.created event'), {
        statusCode: 400,
        code: 'invalid_request_error'
      })
    }
    const possibleInheritedModels = inheritsModel
      ? new Set([
          cachedModel,
          ...(turnsByStream.get(streamId) ?? [])
            .filter((turn) => !turn.terminal)
            .map((turn) => turn.model)
        ])
      : new Set()
    for (const candidate of possibleInheritedModels) {
      assertModelAccess(auth.keyData, candidate)
    }
    if (steering) {
      await accountValidator?.(model, auth.keyData, { deferGroupAdmission: true })
    }
    if (!steering) {
      if ([...turnsByStream.values()].reduce((count, turns) => count + turns.length, 0) >= 64) {
        throw Object.assign(new Error('Too many pending WebSocket turns'), {
          statusCode: 429,
          code: 'rate_limit_exceeded'
        })
      }
      const warmup = message.generate === false || message.response?.generate === false
      const lease = await acquireWsTurnConcurrency(auth.keyData, {
        onLeaseExpired,
        acquireConcurrency: !warmup
      })
      if (!lease.ok) {
        throw Object.assign(new Error(lease.message), {
          statusCode: lease.status,
          code: lease.code
        })
      }
      try {
        for (const candidate of possibleInheritedModels) {
          if (candidate !== model) {
            await accountValidator?.(candidate, auth.keyData, { deferGroupAdmission: true })
          }
        }
        upstreamModel = (await accountValidator?.(model, auth.keyData)) ?? model
        if (closing) {
          throw Object.assign(new Error('WebSocket closed'), { statusCode: 503 })
        }
      } catch (error) {
        await lease.release()
        throw error
      }
      const turns = turnsByStream.get(streamId) ?? []
      turns.push({
        startedAt: Date.now(),
        release: lease.release,
        responseId: null,
        model,
        streamId,
        transferred: false,
        terminal: false,
        warmup,
        keyData: auth.keyData
      })
      turnsByStream.set(streamId, turns)
    }
    modelsByStream.set(streamId, model)
    return { model, upstreamModel }
  }

  const ingestUpstreamText = (text) => {
    const parsed = JSON.parse(text)
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      const streamId = event.stream_id ?? null
      const turns = turnsByStream.get(streamId) ?? []
      if (event.type === 'response.created') {
        const turn = turns.find((item) => !item.responseId)
        if (turn) {
          turn.responseId = event.response.id
          acceptedModelsByStream.set(streamId, turn.model)
          responseContexts.set(turn.responseId, turn)
          while (responseContexts.size > 128) {
            responseContexts.delete(responseContexts.keys().next().value)
          }
        }
      }
      if (isResponsesTerminalEvent(event.type)) {
        const turn = event.response?.id
          ? responseContexts.get(event.response.id)
          : turns.find((item) => !item.responseId)
        if (turn) {
          turn.terminal = true
        }
      }
      if (
        event.type === 'response.incomplete' &&
        event.response?.incomplete_details?.reason === 'steered'
      ) {
        const turn = responseContexts.get(event.response.id)
        if (turn && turns.includes(turn) && !turn.transferred) {
          turn.transferred = true
          turns.splice(turns.indexOf(turn) + 1, 0, {
            ...turn,
            responseId: null,
            startedAt: Date.now(),
            transferred: false,
            terminal: false
          })
        }
      }
    }
    accumulator.ingestUpstreamText(text)
  }

  const close = async () => {
    closing = true
    try {
      await flush()
    } finally {
      for (const turns of turnsByStream.values()) {
        for (const turn of turns) {
          try {
            if (!turn.warmup) {
              await requestDetailService.captureUnmeteredRequest(req, {
                apiKeyId: apiKeyData.id,
                accountId,
                accountType,
                result: {
                  requestId: turn.responseId ?? crypto.randomUUID(),
                  requestStartedAt: turn.startedAt,
                  model: turn.model,
                  statusCode: 502,
                  stream: true,
                  errorCode: 'upstream_stream_incomplete',
                  errorMessage: 'WebSocket closed before a terminal response event'
                }
              })
            }
          } catch (error) {
            logger.error('Failed to capture unfinished WebSocket turn', { error, accountId })
          } finally {
            if (!turn.transferred) {
              await turn
                .release()
                .catch((error) => logger.error('Failed to release WebSocket turn', error))
            }
          }
        }
      }
      turnsByStream.clear()
    }
  }

  return {
    beforeClientText,
    ingestClientText: (text) => {
      const message = parseWsClientMessage(text)
      const source = message.response ?? message
      const streamId = message.stream_id ?? source.stream_id ?? null
      accumulator.ingestClientText(
        JSON.stringify({
          ...message,
          ...source,
          model: modelsByStream.get(streamId) ?? initialModel,
          stream_id: streamId
        })
      )
    },
    ingestUpstreamText,
    snapshot: accumulator.snapshot,
    flush,
    close,
    hasActiveTurns: () =>
      [...turnsByStream.values()].some((turns) => turns.some((turn) => !turn.terminal)),
    setAccount: (id, billed = false, validator = accountValidator) => {
      accountId = id
      selfBilled = billed
      accountValidator = validator
    }
  }
}
