import { IncrementalSSEParser } from './relay_sse_parser.js'

// 上游允许固定使用 SSE；客户端仍按自己的 stream 参数接收 Chat JSON 或 SSE
export const attachResponsesToChatBridge = (req, res, converter, model, stream) => {
  const original = {
    write: res.write.bind(res),
    end: res.end.bind(res),
    json: res.json.bind(res),
    setHeader: res.setHeader.bind(res),
    flushHeaders: res.flushHeaders?.bind(res),
  }
  const parser = new IncrementalSSEParser()
  const state = converter.createStreamState()
  let completedResponse = null
  let failure = null
  let terminal = false
  let restored = false
  const restore = () => {
    if (restored) {
      return
    }
    restored = true
    Object.assign(res, original)
  }
  const fail = (message) => {
    if (failure) {
      return
    }
    failure = { error: { type: 'server_error', code: 'protocol_conversion_failed', message } }
    req._crsBridgeFailure = { errorCode: failure.error.code, errorMessage: message }
    if (stream) {
      original.write(`data: ${JSON.stringify(failure)}\n\n`)
    }
  }
  const consume = (events) => {
    for (const event of events) {
      if (failure) {
        return
      }
      if (event.type === 'invalid') {
        fail('Invalid upstream Responses event')
        return
      }
      if (event.type !== 'data') {
        continue
      }
      const { data } = event
      if (['response.completed', 'response.done', 'response.incomplete', 'response.failed'].includes(data.type)) {
        completedResponse = data.response
        terminal = true
      }
      if (data.error || data.response?.error) {
        failure = { error: data.error ?? data.response.error }
        terminal = true
        if (stream) {
          original.write(`data: ${JSON.stringify(failure)}\n\n`)
        }
        continue
      }
      try {
        if (stream) {
          for (const chunk of converter.convertStreamChunk(data, model, state)) {
            original.write(chunk)
          }
        }
      } catch (_error) {
        fail('Unable to convert upstream Responses events')
      }
    }
  }
  if (!stream) {
    res.setHeader = (name, value) =>
      original.setHeader(name, name.toLowerCase() === 'content-type' ? 'application/json' : value)
    res.flushHeaders = () => {}
  }
  res.json = (data) => {
    restore()
    if (res.statusCode >= 400) {
      return original.json(data)
    }
    const converted = converter.convertResponse(data, model)
    if (converted.error) {
      res.statusCode = 502
    }
    return original.json(converted)
  }
  res.write = (chunk, encoding, callback) => {
    if (res.statusCode >= 400) {
      return original.write(chunk, encoding, callback)
    }
    consume(parser.feed(chunk))
    const done = typeof encoding === 'function' ? encoding : callback
    if (typeof done === 'function') {
      done()
    }
    return true
  }
  res.end = (chunk, encoding, callback) => {
    if (res.statusCode >= 400) {
      restore()
      return original.end(chunk, encoding, callback)
    }
    if (chunk) {
      consume(parser.feed(chunk))
    }
    consume(parser.finish())
    if (!terminal && !failure) {
      fail('Upstream stream ended before a terminal response event')
    }
    restore()
    if (stream) {
      if (!failure) {
        original.write('data: [DONE]\n\n')
      }
      return original.end(undefined, encoding, callback)
    }
    const result =
      failure ??
      (completedResponse
        ? converter.convertResponse(completedResponse, model)
        : { error: { type: 'server_error', code: 'upstream_incomplete', message: 'Upstream response was incomplete' } })
    if (result.error) {
      res.statusCode = 502
    }
    return original.json(result)
  }
  return restore
}
