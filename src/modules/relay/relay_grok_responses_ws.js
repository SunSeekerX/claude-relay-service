import {
  acceptWebSocketEndpoint,
  encodeWsClientText,
  encodeWsClientPong,
  encodeWsClientClose
} from '../../common/gateway_ws_endpoint.js'
import {
  createWsFrameSniffer,
  parseWsClientMessage
} from '../../common/gateway_ws_frame_sniffer.js'
import { connectWebSocketUpstream } from '../../common/gateway_ws_upstream.js'
import { authenticateApiKeyForUpgrade } from '../../common/gateway_ws_api_key_auth.js'
import {
  buildClientError,
  buildWebSocketClientError,
  summarizeErrorForLog
} from '../../common/client_error_builder.js'
import { logger } from '../../common/logger.js'
import * as xaiHelper from '../../common/xai_helper.js'
import { grokScheduler } from './relay_grok_scheduler.js'
import { grokAccountService } from '../account/account_grok_service.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { pickGrokPassthroughHeaders } from './relay_header_filter.js'
import { createResponsesWsBilling } from './relay_responses_ws_billing.js'
import { assertModelAccess } from './relay_model_access.js'
import { isResponsesRateLimitError } from './relay_responses_stream_state.js'

export const isGrokResponsesWebSocketPath = (path) =>
  ['/grok/responses', '/grok/v1/responses'].includes(path)

export const handleGrokResponsesWebSocket = async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const auth = await authenticateApiKeyForUpgrade(req, url, {
    requiredPermission: 'grok',
    acquireConcurrency: false
  })
  if (!auth.ok) {
    socket.end(`HTTP/1.1 ${auth.status} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    return
  }
  let account = null
  let currentModel = null
  let upstream = null
  let resolution = null
  let closed = false
  let queue = Promise.resolve()
  let queuedBytes = 0
  let queuedCount = 0
  let endpoint = null
  const connectionAbort = new AbortController()
  const billing = createResponsesWsBilling({
    req,
    apiKeyData: auth.keyData,
    accountType: 'grok',
    requiredPermission: 'grok',
    onLeaseExpired: () => endpoint.close(1011, 'concurrency lease expired'),
    validateAccount: (model, keyData, options) =>
      grokScheduler.assertAccountForWebSocket(keyData, account.id, model, options),
    onTerminal: async (event) => {
      const error = event.response?.error ?? event.error
      if (
        isResponsesRateLimitError(error) &&
        account.disableAutoProtection !== true &&
        account.disableAutoProtection !== 'true'
      ) {
        const seconds = Number(error.resets_in_seconds)
        await grokAccountService.markAccountRateLimited(
          account.id,
          Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 60
        )
      }
    }
  })
  const sendError = (error) => {
    endpoint.sendText(JSON.stringify(buildWebSocketClientError(error)))
  }
  const close = async (error = null) => {
    if (closed) {
      return
    }
    closed = true
    connectionAbort.abort()
    upstream?.destroy()
    try {
      await queue
      await billing.close()
    } catch (closeError) {
      logger.error('Grok WebSocket billing close failed', closeError)
    } finally {
      if (resolution) {
        proxyResolver.report(resolution.proxyId, resolution.contextKey, error)
      }
      await auth.release()
    }
  }
  const closeUpstream = (error = null) => {
    if (closed) {
      return
    }
    const incomplete = billing.hasActiveTurns()
    if (error || incomplete) {
      sendError(
        error ??
          Object.assign(new Error('Upstream closed before a terminal response event'), {
            code: 'upstream_stream_incomplete'
          })
      )
    }
    close(error).catch((closeError) => logger.error('Grok WebSocket close failed', closeError))
    endpoint.close(error || incomplete ? 1011 : 1000, 'upstream closed')
  }
  const connect = async (model) => {
    account = await grokScheduler.selectAccount(auth.keyData, model, null, {
      deferGroupAdmission: true
    })
    account = await grokAccountService.ensureFreshToken(account.id)
    const token = account.authType === 'apikey' ? account.apiKey : account.accessToken
    const headers = { ...pickGrokPassthroughHeaders(req.headers), authorization: `Bearer ${token}` }
    if (account.authType === 'oauth') {
      Object.assign(headers, xaiHelper.buildCliIdentityHeaders())
    }
    if (account.userAgent ?? req.headers['user-agent']) {
      headers['User-Agent'] = account.userAgent ?? req.headers['user-agent']
    }
    resolution = proxyResolver.resolveAgent(account, 'grok')
    const connection = await connectWebSocketUpstream({
      targetUrl: xaiHelper.buildResponsesUrl(grokAccountService.getUpstreamBaseUrl(account)),
      headers,
      agent: resolution.agent,
      signal: connectionAbort.signal
    })
    if (closed) {
      connection.socket.destroy()
      return
    }
    upstream = connection.socket
    billing.setAccount(account.id)
    req._crsUpstreamHeaders = connection.headers
    req._crsUpstreamRequestIdHeader =
      account.upstreamRequestIdHeader ?? account.extra?.upstreamRequestIdHeader ?? null
    const sniffer = createWsFrameSniffer({
      onTextMessage: (text) => {
        billing.ingestUpstreamText(text)
        const event = JSON.parse(text)
        const error = event.response?.error ?? event.error
        if (error) {
          const result = buildClientError({
            statusCode: event.status ?? (isResponsesRateLimitError(error) ? 429 : 502),
            protocol: 'openai',
            upstreamBody: { error }
          })
          text = JSON.stringify(
            event.response
              ? { ...event, response: { ...event.response, error: result.body.error } }
              : { ...event, status: result.statusCode, ...result.body }
          )
        }
        if (!endpoint.sendText(text)) {
          upstream.pause()
        }
      },
      onPing: (payload) => upstream.write(encodeWsClientPong(payload)),
      onParseError: (error) => closeUpstream(error),
      onCloseFrame: (payload) => {
        upstream.end(encodeWsClientClose(payload))
        closeUpstream()
      }
    })
    upstream.on('data', sniffer.push)
    upstream.on('error', closeUpstream)
    upstream.on('close', () => closeUpstream())
    upstream.on('drain', () => {
      if (!closed && queuedCount === 0) {
        socket.resume()
      }
    })
    socket.on('drain', () => upstream?.resume())
    if (connection.head.length) {
      sniffer.push(connection.head)
    }
  }
  endpoint = acceptWebSocketEndpoint(req, socket, head, {
    label: 'grok-responses',
    onTextMessage: (text) => {
      const bytes = Buffer.byteLength(text)
      if (queuedCount >= 64 || queuedBytes + bytes > 16 * 1024 * 1024) {
        sendError(
          Object.assign(new Error('Too many queued WebSocket requests'), {
            statusCode: 429,
            code: 'rate_limit_exceeded'
          })
        )
        return
      }
      queuedBytes += bytes
      queuedCount += 1
      socket.pause()
      queue = queue
        .then(async () => {
          if (closed) {
            return
          }
          const message = parseWsClientMessage(text)
          const model = message.model ?? currentModel
          if (message.type !== 'response.create' || !model) {
            throw Object.assign(new Error('Grok requires response.create with model'), {
              statusCode: 400
            })
          }
          assertModelAccess(auth.keyData, model)
          if (!upstream) {
            await connect(model)
          }
          if (closed) {
            return
          }
          const admission = await billing.beforeClientText(text)
          if (closed) {
            return
          }
          billing.ingestClientText(text)
          currentModel = model
          upstream.write(
            encodeWsClientText(JSON.stringify({ ...message, model: admission.upstreamModel }))
          )
        })
        .catch((error) => {
          logger.error('Grok WebSocket request failed', {
            error: summarizeErrorForLog(error),
            accountId: account?.id
          })
          if (!closed) {
            sendError(error)
          }
        })
        .finally(() => {
          queuedBytes -= bytes
          queuedCount -= 1
          if (!closed && queuedCount === 0 && !upstream?.writableNeedDrain) {
            socket.resume()
          }
        })
    },
    onClose: () => {
      close().catch((error) => logger.error('Grok WebSocket close failed', error))
    }
  })
  if (!endpoint) {
    await auth.release()
  }
}
