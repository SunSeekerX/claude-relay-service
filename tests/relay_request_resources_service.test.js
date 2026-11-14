import { afterEach, beforeEach, expect, jest, test } from '@jest/globals'
import { EventEmitter } from 'node:events'

let record
const subscribers = new Set()
const services = []
const client = {
  hgetall: jest.fn(async () => ({ ...record })),
  multi: jest.fn(() => {
    let fields
    const tx = {
      hset: (_key, value) => {
        fields = value
        return tx
      },
      hincrby: () => tx,
      exec: async () => {
        record = { ...record, ...fields, version: Number(record.version ?? 0) + 1 }
        return [
          [null, Object.keys(fields).length],
          [null, record.version],
        ]
      },
    }
    return tx
  }),
  publish: jest.fn(async (channel, message) => {
    for (const sub of subscribers) {
      sub.emit('message', channel, message)
    }
    return subscribers.size
  }),
  duplicate: jest.fn(() => {
    const sub = new EventEmitter()
    sub.subscribe = jest.fn(async () => {
      subscribers.add(sub)
    })
    sub.disconnect = jest.fn(() => subscribers.delete(sub))
    return sub
  }),
}
const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() }
jest.unstable_mockModule('../src/infra/redis.js', () => ({ redis: { getClientSafe: () => client } }))
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger }))
const { RelayRequestResourcesService } = await import('../src/modules/relay/relay_request_resources_service.js')
const { requestResourcesConfig } = await import('../config/request_resources.js')
const createService = () => {
  const service = new RelayRequestResourcesService()
  services.push(service)
  return service
}
const admit = (service, bytes = 20) => {
  const req = { method: 'POST', url: '/responses', headers: { 'content-length': String(bytes) } }
  const res = new EventEmitter()
  res.setHeader = jest.fn()
  res.status = jest.fn(() => res)
  res.json = jest.fn()
  const next = jest.fn()
  service.budget.middleware(req, res, next)
  req._crsReleaseRequestBodyProcessing?.()
  return { req, res, next }
}
beforeEach(() => {
  record = {}
  jest.clearAllMocks()
})
afterEach(() => {
  for (const service of services.splice(0)) {
    service.stop()
  }
  jest.useRealTimers()
})

test('a fresh instance has no concurrent or aggregate body limit', async () => {
  const service = createService()
  await service.start()
  expect(service.getSnapshot().config).toMatchObject({ maxRequests: 0, maxInflightBodyMiB: 0 })
  expect(requestResourcesConfig.maxRequests).toBe(0)
  expect(requestResourcesConfig.maxInflightBodyBytes).toBe(0)
  for (let index = 0; index < 70; index++) {
    expect(admit(service).next).toHaveBeenCalledWith()
  }
  expect(service.budget.status().activeRequests).toBe(70)
})

test('save changes admission immediately and survives creating another instance', async () => {
  const service = createService()
  await service.start()
  const saved = await service.save({ maxRequests: 1, maxInflightBodyMiB: 0 }, 'operator')
  expect(saved.config).toMatchObject({ maxRequests: 1, maxInflightBodyMiB: 0, updatedBy: 'operator', version: 1 })
  admit(service)
  expect(admit(service).res.status).toHaveBeenCalledWith(503)
  const restarted = createService()
  await restarted.start()
  expect(restarted.getSnapshot().config).toEqual(saved.config)
})

test('the count and body switches are independent and saved zeros turn limits off', async () => {
  const service = createService()
  await service.save({ maxRequests: 0, maxInflightBodyMiB: 1 }, 'operator')
  admit(service, 700 * 1024)
  expect(admit(service, 700 * 1024).res.status).toHaveBeenCalledWith(503)
  await service.save({ maxRequests: 0, maxInflightBodyMiB: 0 }, 'operator')
  expect(admit(service, 700 * 1024).next).toHaveBeenCalledWith()
  expect(service.budget.status().maxInflightBodyBytes).toBe(0)
})

test('lowering a budget keeps admitted requests alive and blocks only new work', async () => {
  const service = createService()
  const first = admit(service, 2 * 1024 * 1024)
  const release = first.req._crsRetainRequestResources()
  await service.save({ maxRequests: 1, maxInflightBodyMiB: 1 }, 'operator')
  expect(() => first.req._crsRecordRequestBodyBytes(2 * 1024 * 1024)).not.toThrow()
  expect(admit(service).res.status).toHaveBeenCalledWith(503)
  first.res.emit('close')
  expect(service.budget.status().activeRequests).toBe(1)
  release()
  expect(admit(service).next).toHaveBeenCalledWith()
})

test('subscribers adopt saves, ignore stale reads, and recover missed updates on reconnect', async () => {
  const first = createService()
  const second = createService()
  await first.start()
  await second.start()
  await first.save({ maxRequests: 7, maxInflightBodyMiB: 12 }, 'operator')
  await new Promise((resolve) => setImmediate(resolve))
  expect(second.budget.status().maxRequests).toBe(7)
  client.hgetall.mockResolvedValueOnce({ ...record, version: 0, maxRequests: 99 })
  await second.reload()
  expect(second.budget.status().maxRequests).toBe(7)
  record = { ...record, maxRequests: 2, version: 2 }
  second.subscriber.emit('ready')
  await new Promise((resolve) => setImmediate(resolve))
  expect(second.budget.status().maxRequests).toBe(2)
  second.stop()
  expect(subscribers.size).toBe(1)
})

test.each([
  { maxRequests: -1, maxInflightBodyMiB: 0 },
  { maxRequests: '64', maxInflightBodyMiB: 0 },
  { maxRequests: 1.5, maxInflightBodyMiB: 0 },
  { maxRequests: 0, maxInflightBodyMiB: -1 },
  { maxRequests: 0, maxInflightBodyMiB: 9007199254740991 },
  { maxRequests: 0 },
  { maxRequests: 0, maxInflightBodyMiB: 0, unexpected: true },
])('rejects invalid settings without writing Redis: %j', async (value) => {
  await expect(createService().save(value, 'operator')).rejects.toMatchObject({ statusCode: 400 })
  expect(client.multi).not.toHaveBeenCalled()
})

test('a failed save cannot change active limits or publish a success event', async () => {
  const service = createService()
  client.multi.mockImplementationOnce(() => {
    const tx = {
      hset: () => tx,
      hincrby: () => tx,
      exec: async () => {
        throw new Error('fixture offline')
      },
    }
    return tx
  })
  await expect(service.save({ maxRequests: 1, maxInflightBodyMiB: 2 }, 'operator')).rejects.toThrow('fixture offline')
  expect(service.budget.status().maxRequests).toBe(0)
  expect(client.publish).not.toHaveBeenCalled()
})

test('periodic reconciliation recovers a missed notification without restarting', async () => {
  jest.useFakeTimers()
  const first = createService()
  const second = createService()
  await first.start()
  await second.start()
  client.publish.mockResolvedValueOnce(0)
  await first.save({ maxRequests: 5, maxInflightBodyMiB: 0 }, 'operator')
  expect(second.budget.status().maxRequests).toBe(0)
  await jest.advanceTimersByTimeAsync(requestResourcesConfig.syncIntervalMs)
  expect(second.budget.status().maxRequests).toBe(5)
})

test('a Redis read failure retains the last successfully applied limit', async () => {
  const service = createService()
  await service.save({ maxRequests: 4, maxInflightBodyMiB: 0 }, 'operator')
  client.hgetall.mockRejectedValueOnce(new Error('fixture read failure'))
  await expect(service.reload()).rejects.toThrow('fixture read failure')
  expect(service.budget.status().maxRequests).toBe(4)
})
