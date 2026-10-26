import { IncrementalSSEParser } from './relay_sse_parser.js'

export const installResponsesToolTransport = (res, adapter) => {
  const original = { json: res.json, write: res.write, end: res.end }
  const parser = new IncrementalSSEParser()
  const render = (events) =>
    events
      .flatMap((event) => {
        if (event.type === 'invalid') {
          throw new Error('Invalid Responses SSE in tool compatibility mode')
        }
        if (event.type !== 'data') {
          return []
        }
        return adapter
          .restoreEvent(event.data)
          .map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
      })
      .join('')
  res.json = (body) =>
    original.json.call(
      res,
      body?.response
        ? { ...body, response: adapter.restoreResponse(body.response) }
        : adapter.restoreResponse(body)
    )
  const isSse = () => String(res.getHeader('content-type') ?? '').includes('text/event-stream')
  res.write = (chunk, encoding, callback) => {
    if (!isSse()) {
      return original.write.call(res, chunk, encoding, callback)
    }
    const text = render(parser.feed(chunk))
    const done = typeof encoding === 'function' ? encoding : callback
    if (!text) {
      done?.()
      return true
    }
    return original.write.call(res, text, 'utf8', done)
  }
  res.end = (chunk, encoding, callback) => {
    if (!isSse()) {
      return original.end.call(res, chunk, encoding, callback)
    }
    const done =
      typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback
    const events =
      chunk !== undefined && chunk !== null && typeof chunk !== 'function' ? parser.feed(chunk) : []
    return original.end.call(res, render([...events, ...parser.finish()]), 'utf8', done)
  }
  return () => Object.assign(res, original)
}
