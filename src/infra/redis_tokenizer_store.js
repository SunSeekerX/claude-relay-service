import { RedisKeys, TTL, LIMITS } from './redis_key.js'

export const attach = (redisClient) => {
  redisClient.getTokenizerSettings = async () => {
    const raw = await redisClient.getClientSafe().get(RedisKeys.tokenizer.settings)
    const stored = raw === null ? {} : JSON.parse(raw)
    return { enabled: true, disabledTokenizers: [], rules: [], ...stored }
  }
  redisClient.setTokenizerSettings = async (settings) =>
    redisClient.getClientSafe().set(RedisKeys.tokenizer.settings, JSON.stringify(settings))
  redisClient.saveTokenizerTask = async (task, create = false) => {
    const multi = redisClient.getClientSafe().multi()
    multi.set(RedisKeys.tokenizer.task(task.id), JSON.stringify(task), 'EX', TTL.tokenizerTask)
    if (create) {
      multi.lpush(RedisKeys.tokenizer.tasks, task.id)
      multi.ltrim(RedisKeys.tokenizer.tasks, 0, LIMITS.tokenizerTasks - 1)
    }
    const results = await multi.exec()
    if (!results) {
      throw new Error('词表任务状态保存失败')
    }
    for (const [error] of results) {
      if (error) {
        throw error
      }
    }
  }
  redisClient.getTokenizerTask = async (id) => {
    const raw = await redisClient.getClientSafe().get(RedisKeys.tokenizer.task(id))
    return raw === null ? null : JSON.parse(raw)
  }
  redisClient.getTokenizerTasks = async () => {
    const ids = await redisClient.getClientSafe().lrange(RedisKeys.tokenizer.tasks, 0, LIMITS.tokenizerTasks - 1)
    if (ids.length === 0) {
      return []
    }
    const values = await redisClient.getClientSafe().mget(ids.map(RedisKeys.tokenizer.task))
    return values.filter((value) => value !== null).map((value) => JSON.parse(value))
  }
}
