import { Worker } from 'node:worker_threads'
import { tokenizerConfig } from '../../../config/tokenizers.js'

const workers = new Set()
const queue = []
let pendingBytes = 0

const finishJob = (slot, result, error) => {
  const { job } = slot
  if (!job) {
    return
  }
  slot.job = null
  clearTimeout(job.timer)
  pendingBytes -= job.bytes
  slot.worker.unref()
  if (error) {
    job.reject(error)
  } else {
    job.resolve(result)
  }
  pump()
}

const createSlot = () => {
  const worker = new Worker(new URL('./tokenizer_count_worker.js', import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  })
  const slot = { worker, job: null, stopped: false }
  workers.add(slot)
  worker.on('message', (result) => finishJob(slot, result, result.ok ? null : new Error(result.error)))
  worker.on('error', (error) => {
    slot.stopped = true
    workers.delete(slot)
    finishJob(slot, null, error)
  })
  worker.on('exit', () => {
    slot.stopped = true
    workers.delete(slot)
    finishJob(slot, null, slot.job?.failure ?? new Error('本地计数工作进程退出'))
    pump()
  })
  worker.unref()
  return slot
}

const pump = () => {
  while (queue.length > 0) {
    let slot = [...workers].find((worker) => !worker.job && !worker.stopped)
    if (!slot && workers.size < tokenizerConfig.workers) {
      slot = createSlot()
    }
    if (!slot) {
      return
    }
    const job = queue.shift()
    clearTimeout(job.timer)
    slot.job = job
    slot.worker.ref()
    job.timer = setTimeout(() => {
      job.failure = new Error('本地计数超过时间预算')
      slot.stopped = true
      slot.worker.terminate().catch((error) => finishJob(slot, null, error))
    }, job.timeoutMs)
    slot.worker.postMessage({ ...job.payload, assetRoot: tokenizerConfig.dataRoot })
  }
}

export const runLocalTokenizer = (payload, { timeoutMs = tokenizerConfig.countTimeoutMs } = {}) =>
  new Promise((resolve, reject) => {
    const bytes = payload.texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0)
    if (bytes > tokenizerConfig.maxTextBytes || pendingBytes + bytes > tokenizerConfig.maxPendingBytes) {
      reject(new Error('本地计数文本超过资源预算'))
      return
    }
    if (
      queue.length >= tokenizerConfig.queue &&
      [...workers].every((slot) => slot.job) &&
      workers.size >= tokenizerConfig.workers
    ) {
      reject(new Error('本地计数队列已满'))
      return
    }
    const job = { payload, resolve, reject, bytes, timer: null, timeoutMs }
    pendingBytes += bytes
    queue.push(job)
    job.timer = setTimeout(() => {
      const index = queue.indexOf(job)
      if (index < 0) {
        return
      }
      queue.splice(index, 1)
      pendingBytes -= bytes
      reject(new Error('等待本地计数超时'))
    }, tokenizerConfig.queueTimeoutMs)
    pump()
  })

export const tokenizerPoolStatus = () => ({
  workers: workers.size,
  active: [...workers].filter((slot) => slot.job).length,
  queued: queue.length,
  pendingBytes,
})

export const closeTokenizerWorkers = async () => {
  for (const job of queue.splice(0)) {
    clearTimeout(job.timer)
    pendingBytes -= job.bytes
    job.reject(new Error('计数服务正在关闭'))
  }
  await Promise.all(
    [...workers].map((slot) => {
      slot.stopped = true
      return slot.worker.terminate()
    }),
  )
}
