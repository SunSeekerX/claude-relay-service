import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const client = { get: jest.fn(), set: jest.fn() }
const logger = new Proxy({}, { get: () => jest.fn() })
jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: { getClientSafe: () => client }
}))
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger }))
jest.unstable_mockModule('../src/infra/middleware_auth.js', () => ({
  authenticateAdmin: (req, res, next) => {
    if (req.headers.authorization !== 'Bearer fixture-admin') return res.sendStatus(401)
    req.admin = { username: 'fixture-admin' }
    next()
  }
}))
const { defaultTestPromptConfig, normalizeTestPromptConfig, testPromptConfigService } =
  await import('../src/modules/relay/relay_test_prompt_config_service.js')
const { router } = await import('../src/modules/relay/relay_test_model_config_routes.js')
const { RedisKeys } = await import('../src/infra/redis_key.js')
const app = express().use(express.json()).use('/admin', router)
app.use((error, _req, res, _next) =>
  res.status(error.statusCode ?? 500).json({ code: error.statusCode ?? 500, msg: error.message })
)
const singleConfig = () => ({
  selectionMode: 'random_simple',
  defaultId: 'one',
  templates: [
    {
      id: 'one',
      name: 'Managed',
      prompt: 'Managed daily question',
      hint: 'Short reply',
      enabled: true
    }
  ]
})

beforeEach(() => {
  jest.clearAllMocks()
  client.get.mockResolvedValue(null)
  client.set.mockResolvedValue('OK')
})

describe('managed access test prompts', () => {
  it('uses 40 editable defaults only when the Redis key is absent and performs no migration writes', async () => {
    const config = await testPromptConfigService.getConfig()
    expect(config.templates).toHaveLength(40)
    expect(new Set(config.templates.map((item) => item.id)).size).toBe(40)
    expect(client.get).toHaveBeenCalledWith(RedisKeys.testPromptConfig)
    expect(client.set).not.toHaveBeenCalled()
    config.templates[0].prompt = 'Changed copy'
    expect(defaultTestPromptConfig().templates[0].prompt).not.toBe('Changed copy')
  })

  it('saves edits, disabled entries and empty banks without silently restoring defaults', async () => {
    const config = singleConfig()
    config.templates.push({
      id: 'disabled',
      name: 'Disabled',
      prompt: 'Do not select',
      enabled: false
    })
    const saved = await testPromptConfigService.saveConfig(config, 'fixture')
    client.get.mockResolvedValue(JSON.stringify(saved))
    for (let index = 0; index < 10; index++) {
      expect(await testPromptConfigService.resolvePrompt()).toBe('Managed daily question')
    }
    expect(client.set).toHaveBeenCalledWith(RedisKeys.testPromptConfig, JSON.stringify(saved))
    const empty = { selectionMode: 'random_simple', defaultId: '', templates: [] }
    await testPromptConfigService.saveConfig(empty, 'fixture')
    client.get.mockResolvedValue(JSON.stringify(empty))
    expect(await testPromptConfigService.getConfig()).toEqual(empty)
    await expect(testPromptConfigService.resolvePrompt()).rejects.toThrow('启用题目')
  })

  it('keeps handwritten input exact and resolves a configured fixed question', async () => {
    const prompt = '  Translate this sentence\ninto English.  '
    expect(await testPromptConfigService.resolvePrompt(prompt)).toBe(prompt)
    expect(client.get).not.toHaveBeenCalled()
    client.get.mockResolvedValue(JSON.stringify({ ...singleConfig(), selectionMode: 'fixed' }))
    expect(await testPromptConfigService.resolvePrompt()).toBe('Managed daily question')
    for (const invalid of ['', ' ', null, 42, {}, 'x'.repeat(32001)]) {
      await expect(testPromptConfigService.resolvePrompt(invalid)).rejects.toThrow()
    }
  })

  it('propagates Redis or corrupt data failures instead of returning defaults', async () => {
    client.get.mockRejectedValueOnce(new Error('Redis read failed'))
    await expect(testPromptConfigService.getConfig()).rejects.toThrow('Redis read failed')
    client.get.mockResolvedValue('not json')
    await expect(testPromptConfigService.getConfig()).rejects.toThrow()
    client.set.mockRejectedValueOnce(new Error('Redis write failed'))
    await expect(testPromptConfigService.saveConfig(singleConfig(), 'fixture')).rejects.toThrow(
      'Redis write failed'
    )
  })

  it('rejects duplicate IDs, disabled defaults, invalid types and oversized config', () => {
    const config = singleConfig()
    for (const invalid of [
      { ...config, templates: [config.templates[0], config.templates[0]] },
      { ...config, templates: [{ ...config.templates[0], enabled: false }] },
      { ...config, templates: [{ ...config.templates[0], enabled: 'false' }] },
      { ...config, templates: null },
      {
        ...config,
        templates: Array.from({ length: 101 }, (_, index) => ({
          ...config.templates[0],
          id: `p_${index}`
        }))
      },
      {
        ...config,
        defaultId: '',
        templates: Array.from({ length: 20 }, (_, index) => ({
          ...config.templates[0],
          id: `p_${index}`,
          prompt: '中'.repeat(32000)
        }))
      }
    ])
      expect(() => normalizeTestPromptConfig(invalid)).toThrow()
  })

  it('authenticates admin writes and returns the same saved bank on the next read', async () => {
    await request(app).put('/admin/test-prompt-config').send(singleConfig()).expect(401)
    expect(client.set).not.toHaveBeenCalled()
    const response = await request(app)
      .put('/admin/test-prompt-config')
      .set('Authorization', 'Bearer fixture-admin')
      .send(singleConfig())
      .expect(200)
    expect(response.body.code).toBe(200)
    client.get.mockResolvedValue(JSON.stringify(response.body.data.config))
    const read = await request(app)
      .get('/admin/test-prompt-config')
      .set('Authorization', 'Bearer fixture-admin')
      .expect(200)
    expect(read.body.data.config).toEqual(response.body.data.config)
  })
})
