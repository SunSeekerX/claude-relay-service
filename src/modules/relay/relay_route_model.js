import { assertModelAccess } from './relay_model_access.js'
import { IncrementalSSEParser, parseSSEEvent } from './relay_sse_parser.js'
import { getRequestRouteFormat } from './relay_routing_contract.js'

const rewriteModelFields = (value, requestedModel) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }
  const result = { ...value }
  if (typeof result.model === 'string') {
    result.model = requestedModel
  }
  if (result.message && typeof result.message.model === 'string') {
    result.message = { ...result.message, model: requestedModel }
  }
  if (result.response && typeof result.response.model === 'string') {
    result.response = { ...result.response, model: requestedModel }
  }
  return result
}

export const rewriteRouteModelFrame = (frame, requestedModel) => {
  const event = parseSSEEvent(frame)
  if (event.type !== 'data') {
    return frame
  }
  const rewritten = rewriteModelFields(event.data, requestedModel)
  if (JSON.stringify(rewritten) === JSON.stringify(event.data)) {
    return frame
  }
  const lines = frame.replace(/(?:\r\n|\n|\r){2}$/, '').split(/\r\n|\n|\r/)
  let inserted = false
  return `${lines
    .flatMap((line) => {
      if (!line.startsWith('data:')) {
        return [line]
      }
      if (inserted) {
        return []
      }
      inserted = true
      return [`data: ${JSON.stringify(rewritten)}`]
    })
    .join('\n')}\n\n`
}

const installModelEcho = (res, requestedModel) => {
  const originalJson = res.json.bind(res)
  const originalSend = res.send.bind(res)
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)
  const parser = new IncrementalSSEParser()
  const isSse = () => String(res.getHeader('content-type') ?? '').includes('text/event-stream')
  const rewriteJson = (body) => {
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      return rewriteModelFields(body, requestedModel)
    }
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
      return body
    }
    try {
      return JSON.stringify(rewriteModelFields(JSON.parse(String(body)), requestedModel))
    } catch {
      return body
    }
  }
  res.json = (value) => originalJson(rewriteModelFields(value, requestedModel))
  res.send = (value) => originalSend(rewriteJson(value))
  res.write = (chunk, encoding, callback) => {
    if (!isSse()) {
      return originalWrite(chunk, encoding, callback)
    }
    const output = parser
      .feedFrames(chunk)
      .map((frame) => rewriteRouteModelFrame(frame, requestedModel))
      .join('')
    return originalWrite(output, typeof encoding === 'string' ? 'utf8' : encoding, callback)
  }
  res.end = (chunk, encoding, callback) => {
    const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback
    const ending = typeof chunk === 'function' ? undefined : chunk
    if (!isSse()) {
      const rewritten = rewriteJson(ending)
      if (rewritten !== ending && !res.headersSent) {
        res.removeHeader('content-length')
      }
      return originalEnd(rewritten, typeof encoding === 'string' ? encoding : undefined, done)
    }
    let frames = []
    if (ending !== undefined && ending !== null) {
      frames = parser.feedFrames(ending)
    }
    frames.push(...parser.finishFrames())
    return originalEnd(frames.map((frame) => rewriteRouteModelFrame(frame, requestedModel)).join(''), 'utf8', done)
  }
}

export const applyRouteModel = (req, res, route, pathModel = null, keyData = req.apiKey) => {
  const requestedModel = pathModel ?? req.body?.model ?? req.body?.request?.model
  if (typeof requestedModel !== 'string' || !requestedModel) {
    return null
  }
  assertModelAccess(keyData, requestedModel)
  const mapping = route.modelMapping ?? {}
  const hasMapping = Object.hasOwn(mapping, requestedModel)
  if (route.modelMode === 'mapped-only' && !hasMapping) {
    const error = new Error('该入口仅开放模型映射表中的模型')
    error.statusCode = 400
    throw error
  }
  const mappedModel = hasMapping ? mapping[requestedModel] : requestedModel
  assertModelAccess(keyData, mappedModel)
  req._relayRouteModel = { requestedModel, mappedModel }
  if (req.body && Object.hasOwn(req.body, 'model')) {
    req.body.model = mappedModel
  }
  if (req.body?.request && Object.hasOwn(req.body.request, 'model')) {
    req.body.request.model = mappedModel
  }
  if (
    mappedModel !== requestedModel &&
    route.echoModel !== 'upstream' &&
    getRequestRouteFormat(req) !== 'gemini-generate'
  ) {
    installModelEcho(res, requestedModel)
  }
  return mappedModel
}
