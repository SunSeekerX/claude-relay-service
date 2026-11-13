import axios from 'axios'
import { createHash, createHmac } from 'node:crypto'
import { SignatureV4 } from '@smithy/signature-v4'
import { fromEnv } from '@aws-sdk/credential-providers'
import { config } from '../../../config/config.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import { createStreamBackpressure } from '../../common/stream_helper.js'
import { buildClientError } from '../../common/client_error_builder.js'
import { normalizeClaudeRequestForModel } from './translator/relay_translator_thinking.js'
import { IncrementalSSEParser } from './relay_sse_parser.js'
import { ClaudeStreamState } from './relay_claude_stream_state.js'

class Sha256 {
  constructor(secret) {
    this.hash = secret ? createHmac('sha256', secret) : createHash('sha256')
  }
  update(data) {
    this.hash.update(data)
  }
  async digest() {
    return this.hash.digest()
  }
}

export const buildMantleRequest = async (body, account) => {
  const { region } = account
  const model = body.model ?? account.defaultModel
  const payload = normalizeClaudeRequestForModel({ ...body, model }, model)
  const url = new URL(`https://bedrock-mantle.${region}.api.aws/anthropic/v1/messages`)
  let headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', host: url.host }
  const data = JSON.stringify(payload)
  if (account.credentialType === 'bearer_token') {
    headers['x-api-key'] = account.bearerToken
  } else {
    const signer = new SignatureV4({
      credentials: account.awsCredentials ?? fromEnv(),
      region,
      service: 'bedrock-mantle',
      sha256: Sha256,
    })
    const signed = await signer.sign({
      method: 'POST',
      protocol: 'https:',
      hostname: url.hostname,
      path: url.pathname,
      headers,
      body: data,
    })
    const { headers: signedHeaders } = signed
    headers = signedHeaders
  }
  return { url: url.href, headers, data, model }
}

export const relayBedrockMantle = async (body, account, res = null, req = null, onHeaders = null) => {
  const request = await buildMantleRequest(body, account)
  const controller = new AbortController()
  const detach = res ? onClientDisconnect(res, () => controller.abort(), 'Bedrock Mantle') : () => {}
  const resolution = proxyResolver.resolveAgent(account, 'bedrock')
  const startedAt = Date.now()
  let source = null
  let backpressure = null
  const state = new ClaudeStreamState({ model: request.model })
  try {
    const response = await axios({
      ...request,
      method: 'POST',
      signal: controller.signal,
      responseType: body.stream === true ? 'stream' : 'json',
      timeout: config.requestTimeout ?? 600000,
      validateStatus: () => true,
      ...(resolution.agent ? { httpAgent: resolution.agent, httpsAgent: resolution.agent, proxy: false } : {}),
    })
    source = response.data
    proxyResolver.report(resolution.proxyId, resolution.contextKey, null)
    await onHeaders?.()
    if (req) {
      req._crsUpstreamHeaders = response.headers
    }
    if (response.status >= 400) {
      if (body.stream) {
        source.destroy()
      }
      const error = buildClientError({
        statusCode: response.status,
        protocol: 'anthropic',
        upstreamBody: body.stream ? null : response.data,
      })
      throw Object.assign(new Error(error.body.error.message), {
        statusCode: error.statusCode,
        $metadata: { httpStatusCode: error.statusCode },
      })
    }
    if (!body.stream) {
      return {
        success: true,
        data: response.data,
        usage: response.data.usage,
        model: request.model,
        duration: Date.now() - startedAt,
      }
    }
    res.status(response.status)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    const parser = new IncrementalSSEParser()
    backpressure = createStreamBackpressure(source, res)
    const observe = (events) => {
      for (const event of events) {
        if (event.type === 'data') {
          state.observe(event.data.type ? event.data : { ...event.data, type: event.name })
        }
      }
    }
    let transportError = null
    try {
      for await (const chunk of source) {
        observe(parser.feed(chunk))
        if (!res.destroyed && !res.writableEnded && !res.write(chunk)) {
          await backpressure.waitForDrain()
        }
      }
      observe(parser.finish())
    } catch (error) {
      transportError = error
    }
    const result = state.finish(transportError)
    if (req) {
      req._crsProtocolTerminal = state.terminalType
    }
    if (result.statusCode >= 400 && state.error?.code && !res.destroyed && !res.writableEnded) {
      const error = buildClientError({ statusCode: result.statusCode, protocol: 'anthropic' })
      res.write(`event: error\ndata: ${JSON.stringify(error.body)}\n\n`)
    }
    if (!res.destroyed && !res.writableEnded) {
      res.end()
    }
    return {
      success: result.statusCode < 400,
      ...result,
      usage: state.getUsage(),
      protocolTerminal: state.terminalType,
      model: request.model,
      duration: Date.now() - startedAt,
    }
  } catch (error) {
    proxyResolver.report(resolution.proxyId, resolution.contextKey, error)
    throw error
  } finally {
    source?.destroy?.()
    backpressure?.dispose()
    detach()
  }
}
