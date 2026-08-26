import express from 'express'
import request from 'supertest'
import { claudeConsoleRelayService } from '../src/modules/relay/relay_claude_console_relay_service.js'
import { router as claudeConsoleAccountsRouter } from '../src/modules/account/account_claude_console_routes.js'
jest.mock('../src/infra/middleware_auth.js', () => ({
  authenticateAdmin: (req, res, next) => next()
}))

jest.mock('../src/modules/relay/relay_claude_console_relay_service.js', () => ({
  testAccountConnection: jest.fn(async (accountId, res) =>
    res.status(200).json({ success: true, accountId })
  )
}))

jest.mock('../src/modules/account/account_claude_console_service.js', () => ({}))
jest.mock('../src/modules/account/account_group_service.js', () => ({}))
jest.mock('../src/modules/apikey/apikey_service.js', () => ({}))
jest.mock('../src/infra/redis.js', () => ({}))
jest.mock('../src/common/logger.js', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/modules/webhook/webhook_notifier.js', () => ({}))
jest.mock('../src/modules/admin/admin_utils_routes.js', () => ({
  formatAccountExpiry: jest.fn((account) => account),
  mapExpiryField: jest.fn((updates) => updates)
}))


describe('POST /admin/claude-console-accounts/:accountId/test', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/admin', claudeConsoleAccountsRouter)
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns 400 when model is missing', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/admin/claude-console-accounts/account-1/test')
      .send({})

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'model is required' })
    expect(claudeConsoleRelayService.testAccountConnection).not.toHaveBeenCalled()
  })

  it('passes model through to relay service when provided', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/admin/claude-console-accounts/account-1/test')
      .send({ model: 'claude-sonnet-4-6' })

    expect(response.status).toBe(200)
    expect(claudeConsoleRelayService.testAccountConnection).toHaveBeenCalledTimes(1)
    expect(claudeConsoleRelayService.testAccountConnection).toHaveBeenCalledWith(
      'account-1',
      expect.any(Object),
      'claude-sonnet-4-6'
    )
  })
})
