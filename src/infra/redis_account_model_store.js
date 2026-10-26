import { RedisKeys } from './redis_key.js'
import { RedisLua } from './redis_lua.js'

const storageNames = {
  'claude-official': 'claude',
  'claude-console': 'claudeConsole',
  ccr: 'ccr',
  openai: 'openai',
  'openai-responses': 'openaiResponses',
  gemini: 'gemini',
  'gemini-api': 'geminiApi',
  bedrock: 'bedrock',
  droid: 'droid',
  grok: 'grok',
}

export const attach = (redisClient) => {
  redisClient.getAccountModelState = async (type, id) => {
    const name = storageNames[type]
    const client = redisClient.getClientSafe()
    const raw =
      type === 'bedrock'
        ? JSON.parse((await client.get(RedisKeys.accounts[name](id))) ?? 'null')
        : await client.hgetall(RedisKeys.accounts[name](id))
    return raw && Object.keys(raw).length ? { ...raw, id } : null
  }
  redisClient.getAccountModelStates = async (type) => {
    const name = storageNames[type]
    const prefix = RedisKeys.accounts[name]('')
    const keys = await redisClient.scanKeys(RedisKeys.accounts[`${name}Pattern`])
    const ids = keys.map((key) => key.slice(prefix.length)).filter((id) => id !== 'index' && !id.includes(':'))
    const accounts = []
    for (let index = 0; index < ids.length; index += 8) {
      accounts.push(
        ...(await Promise.all(ids.slice(index, index + 8).map((id) => redisClient.getAccountModelState(type, id)))),
      )
    }
    return accounts.filter(Boolean)
  }
  redisClient.recordAccountModelCatalog = async (type, id, result) => {
    if (type === 'bedrock') {
      const client = redisClient.getClientSafe().duplicate()
      const key = RedisKeys.accounts.bedrock(id)
      try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await client.watch(key)
          const raw = await client.get(key)
          if (!raw) {
            await client.unwatch()
            return null
          }
          const account = JSON.parse(raw)
          const current = JSON.parse(account.modelCatalog ?? '{}')
          if (current.attemptedAt > result.attemptedAt) {
            await client.unwatch()
            return current
          }
          const next = { ...current, attemptedAt: result.attemptedAt, error: result.error }
          if (result.models) {
            Object.assign(next, {
              models: result.models,
              signature: result.signature,
              complete: result.complete,
              succeededAt: result.attemptedAt,
            })
          }
          account.modelCatalog = JSON.stringify(next)
          if (await client.multi().set(key, JSON.stringify(account)).exec()) {
            return next
          }
        }
        throw new Error('Account changed repeatedly while recording model discovery')
      } finally {
        await client.quit().catch(() => client.disconnect())
      }
    }
    const raw = await redisClient
      .getClientSafe()
      .eval(RedisLua.accountModels.record, 1, RedisKeys.accounts[storageNames[type]](id), JSON.stringify(result))
    return raw ? JSON.parse(raw) : null
  }
  redisClient.getAccountModelObservation = async (type, account) => {
    const client = redisClient.getClientSafe()
    const temporary = await client.get(RedisKeys.upstream.tempUnavailable(type, account.id))
    const composite =
      type === 'claude-console'
        ? RedisKeys.concurrency.consoleAccount(account.id)
        : type === 'openai-responses'
          ? RedisKeys.concurrency.openaiResponsesAccount(account.id)
          : null
    const concurrency =
      composite && Number(account.maxConcurrentTasks) > 0
        ? await client.zcount(RedisKeys.concurrency.byKey(composite), Date.now(), '+inf')
        : 0
    const overloaded = type === 'claude-official' ? await client.get(RedisKeys.account.overload(account.id)) : null
    return { temporary: Boolean(temporary), concurrency, overloaded: Boolean(overloaded) }
  }
}
