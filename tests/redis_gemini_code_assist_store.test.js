import { beforeEach, expect, jest, test } from '@jest/globals'
import { attach } from '../src/infra/redis_gemini_code_assist_store.js'
import { RedisKeys, TTL } from '../src/infra/redis_key.js'

let redis
let client
let values
beforeEach(() => {
  values = new Map()
  client = {
    get: jest.fn(async (key) => values.get(key) ?? null),
    set: jest.fn(async (key, value) => {
      if (values.has(key)) {
        return null
      }
      values.set(key, value)
      return 'OK'
    }),
  }
  redis = { getClientSafe: () => client }
  attach(redis)
})

test('retains immutable operation ownership with TTL and isolates user keys', async () => {
  await redis.saveGeminiCodeAssistOperationAccount('key-a', 'op1', 'account-a')
  await redis.saveGeminiCodeAssistOperationAccount('key-b', 'op1', 'account-b')
  expect(client.set).toHaveBeenCalledWith(
    RedisKeys.geminiCodeAssist.operation('key-a', 'op1'),
    'account-a',
    'EX',
    TTL.geminiCodeAssistOperation,
    'NX',
  )
  expect(await redis.getGeminiCodeAssistOperationAccount('key-a', 'op1')).toBe('account-a')
  expect(await redis.getGeminiCodeAssistOperationAccount('key-b', 'op1')).toBe('account-b')
  await expect(redis.saveGeminiCodeAssistOperationAccount('key-a', 'op1', 'account-a')).resolves.toBeUndefined()
  await expect(redis.saveGeminiCodeAssistOperationAccount('key-a', 'op1', 'account-b')).rejects.toMatchObject({
    code: 'operation_account_conflict',
  })
  expect(await redis.getGeminiCodeAssistOperationAccount('key-a', 'op1')).toBe('account-a')
})

test('propagates persistence failures instead of returning an unowned operation', async () => {
  client.set.mockRejectedValueOnce(new Error('fixture write failed'))
  await expect(redis.saveGeminiCodeAssistOperationAccount('key-a', 'op1', 'account-a')).rejects.toThrow(
    'fixture write failed',
  )
  expect(await redis.getGeminiCodeAssistOperationAccount('key-a', 'op1')).toBeNull()
})
