import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const load = jest.fn(async () => ({ models: ['model-a'], succeededAt: null, canSync: true }))
const sync = jest.fn(async () => ({ models: ['model-a'], succeededAt: '2026-10-25T00:00:00Z' }))
const supported = jest.fn(async () => [{ id: 'model-a', source: 'configured', availability: 'ready' }])
await jest.unstable_mockModule('../src/infra/middleware_auth.js', () => ({
  authenticateAdmin: (req, res, next) => {
    if (req.headers.authorization !== 'Bearer fixture-admin') {
      return res.status(401).json({ code: 401, msg: 'Admin authentication required' })
    }
    return next()
  },
}))
await jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis: {} }))
await jest.unstable_mockModule('../src/modules/relay/relay_routing_service.js', () => ({
  getRouteTargets: jest.fn(),
  saveRoute: jest.fn(),
  getAccountSupportedModelDetails: supported,
}))
await jest.unstable_mockModule('../src/modules/account/account_model_catalog_service.js', () => ({
  getAccountModelCatalog: load,
  syncAccountModelCatalog: sync,
}))
const { router } = await import('../src/modules/relay/relay_routing_admin_routes.js')
const app = express().use(express.json()).use('/admin', router)
const base = '/admin/account-model-catalog/openai-responses/account-fixture'
beforeEach(() => jest.clearAllMocks())

describe('administrator-only supported model management', () => {
  test.each([
    ['get', ''],
    ['get', '/supported-models'],
    ['post', '/sync'],
  ])('API ID or ordinary Key cannot authorize %s %s', async (method, suffix) => {
    const result = await request(app)
      [method](base + suffix)
      .set('x-api-key', 'ordinary-user-key')
      .send({ apiId: 'share-id' })
    expect(result.status).toBe(401)
    expect(load).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    expect(supported).not.toHaveBeenCalled()
  })
  test('loading model state requires admin authentication and retains the standard management envelope', async () => {
    const result = await request(app).get(base).set('Authorization', 'Bearer fixture-admin')
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ code: 200, data: { models: ['model-a'] } })
    expect(load).toHaveBeenCalledWith('openai-responses', 'account-fixture')
  })
  test('manual sync only uses the saved account identity; request-body credentials, ranges and bindings are ignored', async () => {
    const result = await request(app)
      .post(`${base}/sync`)
      .set('Authorization', 'Bearer fixture-admin')
      .send({ accountId: 'another', allowedModels: ['forged'], apiKey: 'forged', binding: 'another-group' })
    expect(result.body.code).toBe(200)
    expect(sync).toHaveBeenCalledWith('openai-responses', 'account-fixture')
    expect(sync.mock.calls[0]).toHaveLength(2)
  })
})
