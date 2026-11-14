import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { Readable } from 'node:stream'

const axios = jest.fn()
const recordUsage = jest.fn().mockResolvedValue({})
const unmetered = jest.fn().mockResolvedValue({})
const outcomes = jest.fn()
const antigravityRequest = jest.fn()
const account = {
  id: 'oauth-fixture',
  oauthProvider: 'gemini-cli',
  accessToken: 'fixture-token',
  refreshToken: 'fixture-refresh',
  projectId: 'fixture-project',
}
class OAuth2Client {
  setCredentials() {}
  async getAccessToken() {
    return { token: 'fixture-token' }
  }
  async getTokenInfo() {
    return {}
  }
}
const mocks = {
  axios: { default: axios },
  'google-auth-library': { OAuth2Client },
  '../config/config.js': { config: {} },
  '../config/env.js': { env: {}, hasEnv: () => false },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/infra/redis.js': { redis: {} },
  '../src/common/common_helper.js': { createEncryptor: () => ({ encrypt: (v) => v, decrypt: (v) => v }) },
  '../src/modules/proxy/proxy_helper.js': { ProxyHelper: { createProxyAgent: () => null } },
  '../src/modules/account/account_token_refresh_service.js': { tokenRefreshService: {} },
  '../src/modules/account/account_model_policy.js': { normalizeAccountModelRange: jest.fn() },
  '../src/common/compat_account_models.js': { parseStoredAccountModels: jest.fn() },
  '../src/modules/webhook/webhook_notifier.js': { webhookNotifier: {} },
  '../src/common/token_refresh_logger.js': {},
  '../src/modules/relay/relay_upstream_error_helper.js': {},
  '../src/modules/relay/relay_antigravity_client.js': {
    ensureAntigravityProjectId: () => 'fixture-project',
    buildAntigravityEnvelope: ({ requestData }) => ({ model: requestData.model }),
    request: antigravityRequest,
  },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: { recordUsage } },
  '../src/modules/relay/relay_request_detail_service.js': {
    requestDetailService: { captureUnmeteredRequest: unmetered },
  },
}
for (const [name, exports] of Object.entries(mocks)) {
  jest.unstable_mockModule(name, () => exports)
}
jest.useFakeTimers()
const { relayGeminiChatResponse } = await import('../src/modules/relay/relay_gemini_relay_service.js')
jest.clearAllTimers()
jest.useRealTimers()
const app = express()
  .use(express.json())
  .post('/chat', async (req, res) => {
    req.apiKey = { id: 'key-fixture' }
    req._crsRecordRelayResult = outcomes
    await relayGeminiChatResponse({
      req,
      res,
      account,
      model: req.body.model,
      stream: req.body.stream === true,
      requestBody: req.body,
      signal: new AbortController().signal,
      proxyConfig: null,
    })
  })
const wireUsage = {
  promptTokenCount: 40,
  cachedContentTokenCount: 20,
  toolUsePromptTokenCount: 10,
  candidatesTokenCount: 7,
  thoughtsTokenCount: 3,
  totalTokenCount: 60,
}
const body = {
  model: 'gemini-fixture',
  temperature: 0,
  messages: [{ role: 'user', content: 'fixture' }],
  tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
}
const frame = (data) => `data:${JSON.stringify({ response: data })}\n\n`
beforeEach(() => {
  jest.clearAllMocks()
  axios.mockReset()
  account.oauthProvider = 'gemini-cli'
})

describe('Gemini OAuth forwarding through the production Code Assist client', () => {
  it.each([false, true])('uses the official URL and envelope and accounts for tools, stream=%s', async (stream) => {
    const payload = {
      candidates: [{ content: { parts: [{ text: '中文' }] }, finishReason: 'STOP' }],
      usageMetadata: wireUsage,
    }
    axios.mockResolvedValue({ data: stream ? Readable.from([Buffer.from(frame(payload))]) : { response: payload } })
    const response = await request(app)
      .post('/chat')
      .send({ ...body, stream })
    expect(response.status).toBe(200)
    expect(axios).toHaveBeenCalledTimes(1)
    expect(axios.mock.calls[0][0]).toMatchObject({
      url: `https://cloudcode-pa.googleapis.com/v1internal:${stream ? 'streamGenerateContent' : 'generateContent'}`,
      headers: { Authorization: 'Bearer fixture-token' },
      signal: expect.any(AbortSignal),
      data: {
        model: 'gemini-fixture',
        project: 'fixture-project',
        request: {
          session_id: 'key-fixture',
          generationConfig: { temperature: 0 },
          tools: [{ functionDeclarations: [expect.objectContaining({ name: 'lookup' })] }],
        },
      },
    })
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0][1]).toMatchObject({
      input_tokens: 30,
      cache_read_input_tokens: 20,
      output_tokens: 7,
      reasoning_tokens: 3,
      _upstreamUsage: { toolUsePromptTokenCount: 10 },
    })
    expect(recordUsage.mock.calls[0][6]).toMatchObject({ protocolTerminal: 'STOP' })
    expect(unmetered).not.toHaveBeenCalled()
  })

  it.each(['MAX_TOKENS', 'SAFETY'])(
    'settles %s and the final unterminated usage frame exactly once',
    async (reason) => {
      const text =
        frame({ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: reason }] }) +
        frame({ usageMetadata: wireUsage }).trimEnd()
      const bytes = Buffer.from(text)
      axios.mockResolvedValue({ data: Readable.from([bytes.subarray(0, 17), bytes.subarray(17)]) })
      const response = await request(app)
        .post('/chat')
        .send({ ...body, stream: true })
      expect(response.text.match(/data: \[DONE\]/g)).toHaveLength(1)
      expect(recordUsage).toHaveBeenCalledTimes(1)
      expect(recordUsage.mock.calls[0][1].input_tokens).toBe(30)
      expect(recordUsage.mock.calls[0][6]).toMatchObject({ statusCode: 200, protocolTerminal: reason })
      expect(outcomes).toHaveBeenLastCalledWith(expect.objectContaining({ hasUsage: true, final: true }))
    },
  )

  it.each([false, true])('retains the selected Antigravity transport and cancellation, stream=%s', async (stream) => {
    account.oauthProvider = 'antigravity'
    const payload = {
      candidates: [{ content: { parts: [{ text: 'fixture' }] }, finishReason: 'STOP' }],
      usageMetadata: wireUsage,
    }
    antigravityRequest.mockResolvedValue({
      response: { data: stream ? Readable.from([Buffer.from(frame(payload))]) : { response: payload } },
    })
    const response = await request(app)
      .post('/chat')
      .send({ ...body, stream })
    expect(response.status).toBe(200)
    expect(axios).not.toHaveBeenCalled()
    expect(antigravityRequest).toHaveBeenCalledTimes(1)
    expect(antigravityRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'fixture-project',
        stream,
        signal: expect.any(AbortSignal),
        requestData: expect.objectContaining({ model: 'gemini-fixture' }),
      }),
    )
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0][1].input_tokens).toBe(30)
  })

  it('settles known usage after a transport failure and reports the stream error', async () => {
    const source = Readable.from(
      (async function* () {
        yield Buffer.from(
          frame({ candidates: [{ content: { parts: [{ text: 'partial' }] } }], usageMetadata: wireUsage }),
        )
        throw new Error('fixture transport failure')
      })(),
    )
    axios.mockResolvedValue({ data: source })
    const response = await request(app)
      .post('/chat')
      .send({ ...body, stream: true })
    expect(response.text).toContain('"error"')
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0][6]).toMatchObject({ statusCode: 502, errorCode: 'upstream_stream_error' })
    expect(outcomes).toHaveBeenLastCalledWith(expect.objectContaining({ statusCode: 502, hasUsage: true }))
  })
})
