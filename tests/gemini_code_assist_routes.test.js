import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'

let key
let account
const scheduler = jest.fn()
const forward = jest.fn()
const getOauthClient = jest.fn()
const logger = { error: jest.fn(), info: jest.fn() }
const resource = jest.fn((_req, res) => res.status(501).end())
jest.unstable_mockModule('../src/modules/relay/relay_gemini_interactions_service.js', () => ({
  geminiInteractionsService: { resource }
}))
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger }))
jest.unstable_mockModule('../src/infra/middleware_auth.js', () => ({
  authenticateApiKey: (req, _res, next) => {
    req.apiKey = key
    next()
  }
}))
jest.unstable_mockModule('../src/modules/account/account_gemini_service.js', () => ({
  getAccount: async () => account,
  getOauthClient,
  forwardToCodeAssist: forward
}))
jest.unstable_mockModule('../src/modules/relay/relay_unified_gemini_scheduler.js', () => ({
  unifiedGeminiScheduler: { selectAccountForApiKey: scheduler }
}))
jest.unstable_mockModule('../src/modules/relay/relay_session_helper.js', () => ({
  sessionHelper: { generateSessionHash: () => null }
}))
jest.unstable_mockModule('../src/modules/relay/relay_gemini_handlers_routes.js', () => ({
  ...Object.fromEntries(
    [
      'handleCountTokens',
      'handleEmbedContent',
      'handleGenerateContent',
      'handleInteractions',
      'handleLoadCodeAssist',
      'handleModelDetails',
      'handleModels',
      'handleOnboardUser',
      'handleStandardGenerateContent',
      'handleStandardStreamGenerateContent',
      'handleStreamGenerateContent'
    ].map((name) => [name, (_req, res) => res.status(501).end()])
  ),
  parseProxyConfig: () => null,
  ensureGeminiPermissionMiddleware: (req, res, next) => {
    if (req.apiKey.permissions.includes('gemini')) {
      next()
    } else {
      res.status(403).end()
    }
  }
}))
const { router } = await import('../src/modules/relay/relay_standard_gemini_routes.js')
const { getCodeAssistOperation } = await import('../src/modules/relay/relay_gemini_code_assist_contract.js')
const { getRequestRouteFormat } = await import('../src/modules/relay/relay_routing_contract.js')
const app = express().use(express.json()).use('/gemini', router)
const named = express()
  .use(express.json())
  .use('/r/entry', (req, res) => {
    const operation = getCodeAssistOperation(req.method, req.path)
    req.apiKey = key
    req.params = { operationId: operation?.operationId }
    const { createCodeAssistHandler } = codeAssist
    if (!operation) {
      return res.status(404).end()
    }
    return createCodeAssistHandler(operation.name, {
      method: operation.method,
      dedicatedOnly: operation.name === 'setCodeAssistGlobalUserSetting'
    })(req, res)
  })
const codeAssist = await import('../src/modules/relay/relay_gemini_code_assist_handlers.js')

beforeEach(() => {
  jest.clearAllMocks()
  key = { id: 'fixture-key', permissions: ['gemini'], geminiAccountId: null }
  account = { id: 'oauth-a', accountType: 'shared', oauthProvider: 'gemini-cli' }
  scheduler.mockResolvedValue({ accountId: 'oauth-a', accountType: 'gemini' })
  getOauthClient.mockResolvedValue({ fixture: true })
  forward.mockResolvedValue({ fixture: true })
})

describe('Gemini CLI auxiliary routes', () => {
  it.each([
    ['get', '', 'get'],
    ['delete', '', 'delete'],
    ['post', '/cancel', 'cancel']
  ])('wires Interactions %s resource access through the Gemini permission gate', async (method, suffix, action) => {
    const path = `/gemini/v1beta/interactions/owned-id${suffix}`
    expect((await request(app)[method](path)).status).toBe(501)
    expect(resource.mock.calls.at(-1)[0].params.id).toBe('owned-id')
    expect(resource.mock.calls.at(-1)[2]).toBe(action)
    resource.mockClear()
    key.permissions = []
    expect((await request(app)[method](path)).status).toBe(403)
    expect(resource).not.toHaveBeenCalled()
  })
  it.each(['loadCodeAssist', 'retrieveUserQuota', 'listExperiments'])(
    'classifies and forwards named %s without a fabricated model hint',
    async (method) => {
      expect(getRequestRouteFormat({ method: 'POST', path: `/v1internal:${method}` })).toBe('gemini-generate')
      const response = await request(named)
        .post(`/r/entry/v1internal:${method}`)
        .send({ metadata: { enabled: false } })
      expect(response.status).toBe(200)
      expect(scheduler).toHaveBeenCalledWith(key, null, null, { oauthProvider: 'gemini-cli' })
      expect(forward.mock.calls[0][2]).toEqual({ metadata: { enabled: false } })
    }
  )
  it.each(['fetchAdminControls', 'recordCodeAssistMetrics'])(
    'forwards %s without introducing generation billing',
    async (method) => {
      const body = { project: 'project-a', metadata: { arbitrary: false }, metrics: [] }
      const res = await request(app).post(`/gemini/v1internal:${method}`).send(body)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ fixture: true })
      expect(scheduler).toHaveBeenCalledWith(key, null, null, { oauthProvider: 'gemini-cli' })
      expect(forward).toHaveBeenCalledWith(
        { fixture: true },
        method,
        body,
        null,
        expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) })
      )
    }
  )

  it('uses GET for settings and operation polling', async () => {
    expect((await request(app).get('/gemini/v1internal:getCodeAssistGlobalUserSetting')).status).toBe(200)
    expect(forward.mock.calls[0][4].method).toBe('GET')
    expect((await request(app).get('/gemini/v1internal/operations/123')).status).toBe(200)
    expect(forward.mock.calls[1][4]).toMatchObject({
      method: 'GET',
      operationName: 'operations/123'
    })
  })

  it.each([null, 'group:group-a', 'api:account-a'])(
    'rejects settings writes for binding %s before scheduling',
    async (binding) => {
      key.geminiAccountId = binding
      const res = await request(app).post('/gemini/v1internal:setCodeAssistGlobalUserSetting').send({})
      expect(res.status).toBe(403)
      expect(scheduler).not.toHaveBeenCalled()
      expect(forward).not.toHaveBeenCalled()
    }
  )

  it('requires the bound account itself to be dedicated and rejects scheduler fallback', async () => {
    key.geminiAccountId = 'oauth-a'
    let res = await request(app).post('/gemini/v1internal:setCodeAssistGlobalUserSetting').send({})
    expect(res.status).toBe(403)
    account.accountType = 'dedicated'
    scheduler.mockResolvedValue({ accountId: 'other-account', accountType: 'gemini' })
    res = await request(app).post('/gemini/v1internal:setCodeAssistGlobalUserSetting').send({})
    expect(res.status).toBe(403)
    expect(forward).not.toHaveBeenCalled()
  })

  it('allows explicitly bound dedicated OAuth settings and preserves false', async () => {
    key.geminiAccountId = 'oauth-a'
    account.accountType = 'dedicated'
    const body = { setting: { enableCodeCompletion: false } }
    const res = await request(app).post('/gemini/v1internal:setCodeAssistGlobalUserSetting').send(body)
    expect(res.status).toBe(200)
    expect(forward.mock.calls[0][2]).toEqual(body)
  })

  it('preserves Gemini permission checks and rejects incompatible upstream accounts', async () => {
    key.permissions = []
    expect((await request(app).post('/gemini/v1internal:fetchAdminControls').send({})).status).toBe(403)
    expect(forward).not.toHaveBeenCalled()
    key.permissions = ['gemini']
    account.oauthProvider = 'antigravity'
    expect((await request(app).post('/gemini/v1internal:fetchAdminControls').send({})).status).toBe(503)
    expect(forward).not.toHaveBeenCalled()
  })

  it('does not retry an ambiguous settings write failure and hides credential errors', async () => {
    key.geminiAccountId = 'oauth-a'
    account.accountType = 'dedicated'
    forward.mockRejectedValue({
      response: { status: 401, data: { error: { message: 'secret-token' } } }
    })
    const res = await request(app).post('/gemini/v1internal:setCodeAssistGlobalUserSetting').send({})
    expect(res.status).toBe(502)
    expect(JSON.stringify(res.body)).not.toContain('secret-token')
    expect(forward).toHaveBeenCalledTimes(1)
  })
})
