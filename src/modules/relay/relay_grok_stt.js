import axios from 'axios'
import { config } from '../../../config/config.js'
import {
  acceptWebSocketEndpoint,
  encodeWsClientText,
  encodeWsClientBinary,
  encodeWsClientPong,
  encodeWsClientClose,
} from '../../common/gateway_ws_endpoint.js'
import { createWsFrameSniffer, parseWsClientMessage } from '../../common/gateway_ws_frame_sniffer.js'
import { connectWebSocketUpstream } from '../../common/gateway_ws_upstream.js'
import { authenticateApiKeyForUpgrade } from '../../common/gateway_ws_api_key_auth.js'
import { buildClientError, buildWebSocketClientError } from '../../common/client_error_builder.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import { logger } from '../../common/logger.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { grokScheduler } from './relay_grok_scheduler.js'
import { grokAccountService } from '../account/account_grok_service.js'
import { assertModelAccess } from './relay_model_access.js'
import { recordGrokSpeechUsage } from './relay_grok_stt_billing.js'

export const isGrokSpeechWebSocketPath = (path) => ['/grok/stt', '/grok/v1/stt'].includes(path)

const selectSpeechAccount = async (keyData, model) => {
  assertModelAccess(keyData, model)
  return grokScheduler.selectAccount(keyData, model, null, { requiredAuthType: 'apikey' })
}

export const buildGrokSpeechUrl = (account, parameters) => {
  const base = grokAccountService.getUpstreamBaseUrl(account).replace(/\/+$/, '').replace(/\/v1$/, '')
  const url = new URL(`${base}/v1/stt`)
  for (const [name, value] of parameters) {
    if (!['api_key', 'key', 'access_token'].includes(name.toLowerCase())) {
      url.searchParams.append(name, value)
    }
  }
  return url.href
}

export const handleGrokSpeechWebSocket = async (req, socket, head) => {
  req.requestStartedAt ??= Date.now()
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const controller = new AbortController()
  socket.once('close', () => controller.abort())
  const auth = await authenticateApiKeyForUpgrade(req, url, {
    requiredPermission: 'grok',
    onLeaseExpired: () => socket.destroy(),
  })
  if (!auth.ok) {
    socket.end(`HTTP/1.1 ${auth.status} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    return
  }
  let account = null
  req.requestId = auth.requestId ?? req.requestId
  let endpoint = null
  let upstream = null
  let resolution = null
  let closed = false
  let terminal = null
  let metering = null
  let audioDone = false
  const finish = async (error = null) => {
    if (closed) {
      return
    }
    closed = true
    controller.abort()
    upstream?.destroy()
    try {
      if (account && endpoint) {
        await recordGrokSpeechUsage(req, auth.keyData, account, metering, true, {
          statusCode: error || terminal !== 'transcript.done' ? 502 : 200,
          protocolTerminal: terminal,
          errorCode: error || terminal !== 'transcript.done' ? 'upstream_stt_incomplete' : null,
        })
      }
    } catch (billingError) {
      logger.error('Grok STT metering failed', billingError)
    } finally {
      if (resolution) {
        proxyResolver.report(resolution.proxyId, resolution.contextKey, error)
      }
      await auth.release()
    }
  }
  const fail = (error) => {
    endpoint?.sendText(JSON.stringify(buildWebSocketClientError(error)))
    void finish(error)
    endpoint?.close(1011, 'upstream speech stream failed')
  }
  try {
    account = await selectSpeechAccount(auth.keyData, 'grok-stt-streaming')
    resolution = proxyResolver.resolveAgent(account, 'grok')
    const connection = await connectWebSocketUpstream({
      targetUrl: buildGrokSpeechUrl(account, url.searchParams),
      headers: { Authorization: `Bearer ${account.apiKey}` },
      agent: resolution.agent,
      signal: controller.signal,
    })
    upstream = connection.socket
    if (controller.signal.aborted) {
      await finish()
      return
    }
    req._crsUpstreamHeaders = connection.headers
    const write = (frame) => {
      if (!upstream.write(frame)) {
        socket.pause()
      }
    }
    endpoint = acceptWebSocketEndpoint(req, socket, head, {
      label: 'grok-stt',
      onBinaryMessage: (data) => {
        if (closed) {
          return
        }
        if (audioDone) {
          fail(Object.assign(new Error('Audio already ended'), { statusCode: 400 }))
          return
        }
        write(encodeWsClientBinary(data))
      },
      onTextMessage: (text) => {
        try {
          const event = parseWsClientMessage(text)
          if (!['audio.done', 'transcript.done'].includes(event.type) || audioDone) {
            throw Object.assign(new Error('Expected audio.done after binary audio'), { statusCode: 400 })
          }
          audioDone = true
          write(encodeWsClientText(text))
        } catch (error) {
          fail(error)
        }
      },
      onClose: () => {
        void finish()
      },
    })
    if (!endpoint) {
      await finish()
      return
    }
    const sniffer = createWsFrameSniffer({
      label: 'grok-stt',
      onTextMessage: (text) => {
        const event = JSON.parse(text)
        if (event.type === 'transcript.done') {
          terminal = event.type
          metering = event
        }
        if (event.type === 'error' || event.error) {
          terminal = 'error'
          text = JSON.stringify(buildWebSocketClientError({ response: { status: 502, data: event } }))
        }
        if (!endpoint.sendText(text)) {
          upstream.pause()
        }
      },
      onPing: (data) => write(encodeWsClientPong(data)),
      onCloseFrame: (data) => {
        upstream.end(encodeWsClientClose(data))
        if (terminal !== 'transcript.done') {
          fail(new Error('Missing transcript.done'))
        } else {
          endpoint.close(1000)
          void finish()
        }
      },
      onParseError: fail,
    })
    upstream.on('data', sniffer.push)
    upstream.on('error', fail)
    upstream.on('close', () => {
      if (!closed) {
        if (terminal !== 'transcript.done') {
          fail(new Error('Missing transcript.done'))
        } else {
          endpoint.close(1000)
          void finish()
        }
      }
    })
    upstream.on('drain', () => socket.resume())
    socket.on('drain', () => upstream.resume())
    upstream.setTimeout(config.requestTimeout ?? 600000, () => fail(new Error('Speech stream timeout')))
    if (connection.head.length) {
      sniffer.push(connection.head)
    }
  } catch (error) {
    if (!endpoint && !socket.destroyed) {
      socket.end(`HTTP/1.1 ${error.statusCode ?? 502} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    await finish(error)
  }
}

export const relayGrokSpeechHttp = async (req, res) => {
  const account = await selectSpeechAccount(req.apiKey, 'grok-stt')
  const resolution = proxyResolver.resolveAgent(account, 'grok')
  const controller = new AbortController()
  const detach = onClientDisconnect(res, () => controller.abort(), 'Grok STT')
  try {
    const url = new URL(req.originalUrl, 'http://localhost')
    const response = await axios({
      method: 'POST',
      url: buildGrokSpeechUrl(account, url.searchParams),
      headers: { Authorization: `Bearer ${account.apiKey}`, 'Content-Type': req.headers['content-type'] },
      data: req.rawBody ?? req.body,
      signal: controller.signal,
      timeout: config.requestTimeout ?? 600000,
      validateStatus: () => true,
      ...(resolution.agent ? { httpAgent: resolution.agent, httpsAgent: resolution.agent, proxy: false } : {}),
    })
    proxyResolver.report(resolution.proxyId, resolution.contextKey, null)
    if (response.status >= 400) {
      const error = buildClientError({ statusCode: response.status, upstreamBody: response.data })
      return res.status(error.statusCode).json(error.body)
    }
    await recordGrokSpeechUsage(req, req.apiKey, account, response.data, false, {
      statusCode: response.status,
      protocolTerminal: 'transcript.done',
    })
    return res.status(response.status).json(response.data)
  } catch (error) {
    proxyResolver.report(resolution.proxyId, resolution.contextKey, error)
    logger.error('Grok speech HTTP request failed', { error, accountId: account.id })
    const clientError = buildClientError({
      statusCode: error.statusCode ?? error.response?.status ?? 502,
      upstreamBody: error.response?.data,
    })
    throw Object.assign(new Error(clientError.body.error.message), { statusCode: clientError.statusCode })
  } finally {
    detach()
  }
}
