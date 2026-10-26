import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { redis } from '../../infra/redis.js'
import { RedisKeys, TTL } from '../../infra/redis_key.js'
import { RedisLua } from '../../infra/redis_lua.js'
import { tokenizerConfig } from '../../../config/tokenizers.js'
import { badRequest, conflict, notFound } from '../../common/http_result.js'
import { logger } from '../../common/logger.js'
import { loadTokenizerAssets, performTokenizerAssetTask, readTokenizerJson } from './tokenizer_assets.js'

const activeTasks = new Map()

const acquireFileLock = async (id) => {
  await fs.mkdir(tokenizerConfig.dataRoot, { recursive: true })
  const filename = path.join(tokenizerConfig.dataRoot, '.operation-lock.json')
  try {
    const existing = await readTokenizerJson(filename)
    if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0) {
      throw new Error('词表文件锁无效，需要管理员检查')
    }
    let alive = true
    try {
      process.kill(existing.pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') {
        alive = false
      } else {
        throw error
      }
    }
    if (alive) {
      throw new Error('另一个词表下载进程仍在运行')
    }
    await fs.unlink(filename)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
  const handle = await fs.open(filename, 'wx')
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, taskId: id }))
  } finally {
    await handle.close()
  }
  return async () => {
    const current = await readTokenizerJson(filename, null)
    if (current?.taskId === id && current.pid === process.pid) {
      await fs.unlink(filename)
    }
  }
}

export const startTokenizerTask = async (input) => {
  if (
    !['download', 'update', 'apply', 'verify', 'check-updates'].includes(input.operation) ||
    !Array.isArray(input.ids) ||
    input.ids.length === 0 ||
    input.ids.length > 64 ||
    new Set(input.ids).size !== input.ids.length
  ) {
    throw badRequest('请选择任务类型和不重复的词表资源')
  }
  const { plan } = await loadTokenizerAssets()
  if (input.ids.some((id) => !plan.bundles.some((bundle) => bundle.id === id))) {
    throw badRequest('词表资源不在受支持来源清单内')
  }
  const client = redis.getClientSafe()
  const id = crypto.randomUUID()
  if ((await client.set(RedisKeys.tokenizer.taskLock, id, 'EX', TTL.tokenizerTaskLock, 'NX')) !== 'OK') {
    throw conflict('已有词表任务正在执行，请先等待或取消')
  }
  const task = {
    id,
    operation: input.operation,
    ids: input.ids,
    state: 'queued',
    createdAt: new Date().toISOString(),
    completed: 0,
    total: input.ids.length,
    message: '等待执行',
  }
  try {
    await redis.saveTokenizerTask(task, true)
  } catch (error) {
    await client.eval(RedisLua.lock.compareAndDel, 1, RedisKeys.tokenizer.taskLock, id)
    throw error
  }
  const controller = new AbortController()
  const active = { controller, promise: null }
  activeTasks.set(id, active)
  const assertOwnership = async () => {
    const [owner, cancelled] = await Promise.all([
      client.get(RedisKeys.tokenizer.taskLock),
      client.get(RedisKeys.tokenizer.cancel(id)),
    ])
    if (owner !== id || cancelled || controller.signal.aborted) {
      controller.abort()
      throw new Error(owner !== id ? '词表任务执行租约已失效' : '词表任务已取消')
    }
  }
  const run = async () => {
    let unlockFile = null
    const renew = setInterval(() => {
      client
        .eval(RedisLua.tokenizer.renewLock, 1, RedisKeys.tokenizer.taskLock, id, TTL.tokenizerTaskLock)
        .then((renewed) => {
          if (renewed !== 1) {
            controller.abort()
          }
          return assertOwnership()
        })
        .catch((error) => {
          controller.abort()
          logger.error('Tokenizer task lease failed', { error, taskId: id })
        })
    }, 15000)
    try {
      if (['download', 'update', 'apply'].includes(task.operation)) {
        unlockFile = await acquireFileLock(id)
      }
      task.state = 'running'
      task.startedAt = new Date().toISOString()
      await redis.saveTokenizerTask(task)
      task.result = await performTokenizerAssetTask({
        ids: task.ids,
        operation: task.operation,
        signal: controller.signal,
        assertOwnership,
        progress: async (completed, total, message, detail = {}) => {
          await assertOwnership()
          Object.assign(task, { completed, total, message, ...detail })
          await redis.saveTokenizerTask(task)
        },
      })
      task.state = 'complete'
      task.completed = task.total
      task.message = '词表任务完成'
    } catch (error) {
      task.state = controller.signal.aborted ? 'cancelled' : 'failed'
      task.message = error.message
      logger.error('Tokenizer asset task failed', { error, taskId: id, operation: task.operation })
    } finally {
      clearInterval(renew)
      task.finishedAt = new Date().toISOString()
      task.activeDownloads = 0
      try {
        await redis.saveTokenizerTask(task)
      } finally {
        try {
          if (unlockFile) {
            await unlockFile()
          }
        } finally {
          activeTasks.delete(id)
          await client.eval(RedisLua.lock.compareAndDel, 1, RedisKeys.tokenizer.taskLock, id)
        }
      }
    }
  }
  active.promise = run().catch((error) => logger.error('Tokenizer task finalization failed', { error, taskId: id }))
  return { ...task }
}

export const getTokenizerTasks = async () => {
  const tasks = await redis.getTokenizerTasks()
  const owner = await redis.getClientSafe().get(RedisKeys.tokenizer.taskLock)
  return tasks.map((task) =>
    ['queued', 'running'].includes(task.state) && owner !== task.id
      ? { ...task, state: 'interrupted', message: '执行租约已失效，未确认完成；不会自动重跑' }
      : task,
  )
}

export const cancelTokenizerTask = async (id) => {
  const task = await redis.getTokenizerTask(id)
  if (!task) {
    throw notFound('词表任务不存在')
  }
  if (!['queued', 'running'].includes(task.state)) {
    throw conflict('词表任务已经结束')
  }
  await redis.getClientSafe().set(RedisKeys.tokenizer.cancel(id), '1', 'EX', TTL.tokenizerTask)
  activeTasks.get(id)?.controller.abort()
  return { cancelRequested: true }
}

export const stopTokenizerTasks = async () => {
  const tasks = [...activeTasks.values()]
  for (const task of tasks) {
    task.controller.abort()
  }
  await Promise.allSettled(tasks.map((task) => task.promise))
}
