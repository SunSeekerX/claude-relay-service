import { parseRetryAfterMilliseconds } from '../../common/retry_after.js'
import { IncrementalSSEParser } from './relay_sse_parser.js'

const MAX_ERROR_BODY_BYTES = 64 * 1024

export const parseAntigravityErrorBody = (value) => {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value
  if (typeof text !== 'string') {
    return text
  }
  try {
    return JSON.parse(text)
  } catch {
    const parser = new IncrementalSSEParser()
    const events = [...parser.feed(text), ...parser.finish()]
    return events.find((event) => event.type === 'data' && event.data?.error)?.data ?? text
  }
}

export const parseAntigravityRetryDelayMs = (response) => {
  const body = parseAntigravityErrorBody(response?.data)
  const details = body?.error?.details
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') {
        continue
      }
      const duration = /^(\d+)(?:\.(\d{1,9}))?s$/.exec(detail.retryDelay)
      if (duration) {
        const milliseconds = Math.ceil(Number(duration[1]) * 1000 + Number(`0.${duration[2] ?? '0'}`) * 1000)
        if (Number.isSafeInteger(milliseconds)) {
          return milliseconds
        }
      }
    }
  }
  return parseRetryAfterMilliseconds(response?.headers?.['retry-after'])
}

// Axios 的错误响应也可能是流；只读取诊断所需的有界正文，释放失败连接后才能重试。
export const readAntigravityErrorBody = async (response, { signal, timeoutMs }) => {
  const stream = response?.data
  if (!stream || typeof stream.on !== 'function' || typeof stream.pipe !== 'function') {
    if (response) {
      response.data = parseAntigravityErrorBody(stream)
    }
    return
  }
  if (signal?.aborted) {
    stream.destroy()
    signal.throwIfAborted()
  }
  const chunks = []
  let bytes = 0
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      stream.off('data', onData)
      stream.off('end', finish)
      stream.off('close', finish)
      stream.off('error', finish)
      stream.destroy()
      resolve()
    }
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = MAX_ERROR_BODY_BYTES - bytes
      chunks.push(buffer.subarray(0, remaining))
      bytes += Math.min(buffer.length, remaining)
      if (bytes === MAX_ERROR_BODY_BYTES) {
        finish()
      }
    }
    const timer = setTimeout(finish, Math.max(1, Math.min(timeoutMs, 5000)))
    signal?.addEventListener('abort', finish, { once: true })
    stream.on('data', onData)
    stream.once('end', finish)
    stream.once('close', finish)
    stream.once('error', finish)
    if (stream.destroyed || stream.readableEnded) {
      finish()
    }
  })
  signal?.throwIfAborted()
  response.data = parseAntigravityErrorBody(Buffer.concat(chunks).toString('utf8'))
}
