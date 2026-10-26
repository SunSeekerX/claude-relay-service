import { RedisKeys, TTL, LIMITS } from './redis_key.js'
import { RedisLua } from './redis_lua.js'

export const attach = (store) => {
  store.getResponsesContext = async (scope, id) => {
    const raw = await store.getClientSafe().get(RedisKeys.responsesContext.item(scope, id))
    return raw === null ? null : JSON.parse(raw)
  }
  store.saveResponsesContext = async (scope, id, context, retentionHours) => {
    const value = JSON.stringify(context)
    if (Buffer.byteLength(value) > LIMITS.responsesContextBytes) {
      throw new Error('Responses context exceeds storage budget')
    }
    await store
      .getClientSafe()
      .eval(
        RedisLua.responsesContext.save,
        2,
        RedisKeys.responsesContext.item(scope, id),
        RedisKeys.responsesContext.index(scope),
        value,
        TTL.responsesContext(retentionHours),
        Date.now(),
        LIMITS.responsesContexts,
        LIMITS.responsesContextBytes
      )
  }
}
