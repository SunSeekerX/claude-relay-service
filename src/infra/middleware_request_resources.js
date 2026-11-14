const capacityErrorBody = (req) => {
  const path = (req.originalUrl ?? req.url).split('?')[0]
  const message = 'Server request capacity reached, please retry later'
  if (req.headers['anthropic-version'] || /\/messages(?:\/count_tokens)?$/.test(path)) {
    return { type: 'error', error: { type: 'overloaded_error', message } }
  }
  if (/\/v1(?:beta)?\/(?:models\/|interactions)|\/v1internal[:/]/.test(path)) {
    return { error: { code: 503, status: 'UNAVAILABLE', message } }
  }
  return { error: { type: 'server_error', code: 'server_overloaded', message, param: null } }
}

export const createRequestResourceBudget = ({ maxRequests, maxBodyBytes, maxInflightBodyBytes }) => {
  const exceedsBodyBudget = (bytes) => maxInflightBodyBytes > 0 && bytes > maxInflightBodyBytes
  let activeRequests = 0
  let activeBodyBytes = 0
  const middleware = (req, res, next) => {
    const hasBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined
    if (!hasBody && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next()
    }
    const length = Number(req.headers['content-length'])
    const encoding = String(req.headers['content-encoding'] ?? 'identity')
      .trim()
      .toLowerCase()
    // 未知长度及压缩请求先预留单包上限，避免解压或解析完成后才发现容量不足。
    let reservedBytes = !hasBody
      ? 0
      : encoding === 'identity' && Number.isSafeInteger(length) && length >= 0
        ? length
        : maxBodyBytes
    if (reservedBytes > maxBodyBytes) {
      return next(Object.assign(new Error('Request body size exceeds limit'), { statusCode: 413 }))
    }
    if ((maxRequests > 0 && activeRequests >= maxRequests) || exceedsBodyBudget(activeBodyBytes + reservedBytes)) {
      res.setHeader('Retry-After', '1')
      res.setHeader('Connection', 'close')
      return res.status(503).json(capacityErrorBody(req))
    }
    activeRequests++
    activeBodyBytes += reservedBytes
    req._crsRequestResourcesActive = true
    let responseDone = false
    let retained = 1
    let released = false
    const release = () => {
      if (released || !responseDone || retained > 0) {
        return
      }
      released = true
      activeRequests--
      activeBodyBytes -= reservedBytes
      req._crsRequestResourcesActive = false
      res.removeListener('finish', onResponseDone)
      res.removeListener('close', onResponseDone)
      req._crsFinalizeRequestLog?.()
    }
    const onResponseDone = () => {
      responseDone = true
      release()
    }
    let bodyProcessingDone = false
    req._crsReleaseRequestBodyProcessing = () => {
      if (bodyProcessingDone) {
        return
      }
      bodyProcessingDone = true
      retained--
      release()
    }
    req._crsRetainRequestResources = () => {
      retained++
      let settled = false
      return () => {
        if (settled) {
          return
        }
        settled = true
        retained--
        release()
      }
    }
    req._crsRecordRequestBodyBytes = (bytes) => {
      if (released) {
        return
      }
      if (
        bytes > maxBodyBytes ||
        (bytes > reservedBytes && exceedsBodyBudget(activeBodyBytes - reservedBytes + bytes))
      ) {
        throw Object.assign(new Error('Request body size exceeds its reserved capacity'), { statusCode: 413 })
      }
      activeBodyBytes += bytes - reservedBytes
      reservedBytes = bytes
    }
    res.once('finish', onResponseDone)
    res.once('close', onResponseDone)
    next()
  }
  return {
    middleware,
    setLimits: ({ maxRequests: requestLimit, maxInflightBodyBytes: bodyLimit }) => {
      maxRequests = requestLimit
      maxInflightBodyBytes = bodyLimit
    },
    status: () => ({ activeRequests, activeBodyBytes, maxRequests, maxInflightBodyBytes }),
  }
}
