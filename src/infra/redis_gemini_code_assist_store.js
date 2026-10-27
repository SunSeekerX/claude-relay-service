import { RedisKeys, TTL } from './redis_key.js'

export const attach = (redis) => {
  redis.getGeminiCodeAssistOperationAccount = async (ownerId, operationId) =>
    redis.getClientSafe().get(RedisKeys.geminiCodeAssist.operation(ownerId, operationId))

  redis.saveGeminiCodeAssistOperationAccount = async (ownerId, operationId, accountId) => {
    const client = redis.getClientSafe()
    const key = RedisKeys.geminiCodeAssist.operation(ownerId, operationId)
    const saved = await client.set(key, accountId, 'EX', TTL.geminiCodeAssistOperation, 'NX')
    if (saved !== 'OK' && (await client.get(key)) !== accountId) {
      throw Object.assign(new Error('Code Assist operation has conflicting account ownership'), {
        statusCode: 503,
        code: 'operation_account_conflict',
      })
    }
  }
}
