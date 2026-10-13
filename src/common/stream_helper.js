/**
 * Stream Helper Utilities
 * 流处理辅助工具函数
 */

/**
 * 检查响应流是否仍然可写（客户端连接是否有效）
 * @param {import('http').ServerResponse} stream - HTTP响应流
 * @returns {boolean} 如果流可写返回true，否则返回false
 */
export const isStreamWritable = (stream) => {
  if (!stream) {
    return false
  }

  // 检查流是否已销毁
  if (stream.destroyed) {
    return false
  }

  // 检查底层socket是否已销毁
  if (stream.socket?.destroyed) {
    return false
  }

  // 检查流是否已结束写入
  if (stream.writableEnded) {
    return false
  }

  return true
}

// 暂停上游直到下游排空；下游断开时恢复读取，保留 drain-for-usage。
export const createStreamBackpressure = (source, destination) => {
  let pending = null
  let release = null

  const waitForDrain = () => {
    if (pending) {
      return pending
    }
    if (!isStreamWritable(destination)) {
      return Promise.resolve(false)
    }
    if (source.destroyed || source.closed) {
      return Promise.resolve(true)
    }
    source.pause()
    const promise = new Promise((resolve) => {
      const clientGone = () => finish(false)
      const finish = (writable = true) => {
        destination.removeListener('drain', finish)
        destination.removeListener('close', clientGone)
        destination.removeListener('error', clientGone)
        destination.removeListener('finish', clientGone)
        source.removeListener('error', finish)
        source.removeListener('close', finish)
        pending = null
        release = null
        source.resume()
        resolve(Boolean(writable) && isStreamWritable(destination))
      }
      release = finish
      destination.once('drain', finish)
      destination.once('close', clientGone)
      destination.once('error', clientGone)
      destination.once('finish', clientGone)
      source.once('error', finish)
      source.once('close', finish)
    })
    pending = promise
    if (!isStreamWritable(destination) || destination.writableNeedDrain === false) {
      release()
    }
    return promise
  }

  return { waitForDrain, dispose: () => release?.() }
}
