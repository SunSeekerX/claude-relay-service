import { logger } from './logger.js'
// 客户端断开判定的单一实现。
//
// 禁止用 req.on('close')：Node >= 16 起 IncomingMessage 'close' = 请求体读完，不是客户端断开。
// 正常请求也会 +0ms 触发 req 'close'（req.complete === true），误当断开会 abort 上游或 destroy 流。
//
// 判据：res 'close' 且 !res.writableEnded。
// 正常结束 → 先 res.end()（writableEnded=true）再 close → 不算断开
// 真断开 → close 时 writableEnded 仍 false → 算断开
// 只看 res，注册时机不敏感。返回 detach()，正常收尾时摘监听（幂等）。
export const onClientDisconnect = (res, onDisconnect, label = 'request') => {
  let detached = false

  const handleClose = () => {
    if (detached) {
      return
    }
    detached = true
    // 响应已写完 = 正常收尾，不是客户端断开
    if (res.writableEnded) {
      return
    }
    logger.info(`Client disconnected, aborting ${label}`)
    onDisconnect()
  }

  // 注册前就已断开的补偿：'close' 是一次性过去事件，晚注册的监听器不会被补发。
  // 调用点常在 await 上游响应之后才注册（此时才有可回收的上游流），若客户端在等上游期间断开，
  // 光靠 once('close') 会永久漏掉、上游流不回收。故此处先判一次终态。
  if (res.destroyed && !res.writableEnded) {
    handleClose()
    return () => {}
  }

  res.once('close', handleClose)

  return () => {
    detached = true
    res.removeListener('close', handleClose)
  }
}
