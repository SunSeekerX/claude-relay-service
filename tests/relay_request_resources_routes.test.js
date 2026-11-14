import { beforeEach, expect, jest, test } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const service = { reload: jest.fn(), save: jest.fn() }
jest.unstable_mockModule('../src/modules/relay/relay_request_resources_service.js', () => ({
  relayRequestResourcesService: service,
}))
jest.unstable_mockModule('../src/infra/middleware_auth.js', () => ({
  authenticateAdmin: (req, res, next) => {
    if (req.get('x-admin-token') !== 'fixture') {
      return res.status(401).json({ code: 401, msg: 'Unauthorized' })
    }
    req.admin = { username: 'fixture-admin' }
    next()
  },
}))
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }))
const { router } = await import('../src/modules/relay/relay_request_resources_routes.js')
const app = express()
app.use(express.json(), router)
beforeEach(() => jest.clearAllMocks())

test.each(['get', 'put'])('the %s settings API requires an administrator', async (method) => {
  const response = await request(app)[method]('/relay-request-resources').send({})
  expect(response.status).toBe(401)
  expect(service.reload).not.toHaveBeenCalled()
  expect(service.save).not.toHaveBeenCalled()
})

test('returns settings and runtime status in the management envelope', async () => {
  const data = { config: { maxRequests: 0, maxInflightBodyMiB: 0 }, status: { activeRequests: 2 } }
  service.reload.mockResolvedValueOnce(data)
  const response = await request(app).get('/relay-request-resources').set('x-admin-token', 'fixture')
  expect(response.body).toMatchObject({ code: 200, data })
})

test('saves explicit zeros and passes the authenticated operator to the service', async () => {
  const config = { maxRequests: 0, maxInflightBodyMiB: 0 }
  service.save.mockResolvedValueOnce({ config })
  const response = await request(app).put('/relay-request-resources').set('x-admin-token', 'fixture').send(config)
  expect(response.body).toMatchObject({ code: 200, data: { config } })
  expect(service.save).toHaveBeenCalledWith(config, 'fixture-admin')
})
