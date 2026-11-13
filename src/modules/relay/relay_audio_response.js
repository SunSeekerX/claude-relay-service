import { IncrementalSSEParser } from './relay_sse_parser.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import { createStreamBackpressure } from '../../common/stream_helper.js'
import { buildClientError } from '../../common/client_error_builder.js'

// Inspect usage without changing audio text, subtitle bytes or native SSE events.
export const readAudioResponse = async (response, destination) => {
  const source = response.data
  const streaming =
    String(response.headers['content-type'] ?? '').includes('text/event-stream') && response.status < 400
  if (!streaming) {
    const chunks = []
    const detach = onClientDisconnect(destination, () => source.destroy(), 'Audio response')
    try {
      for await (const chunk of source) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
    } finally {
      detach()
    }
    const body = Buffer.concat(chunks)
    let data = body.toString('utf8')
    try {
      data = JSON.parse(data)
    } catch {
      // Plain text and subtitles are valid responses.
    }
    return { body, data, streaming: false }
  }

  destination.status(response.status)
  const parser = new IncrementalSSEParser()
  const backpressure = createStreamBackpressure(source, destination)
  const detach = onClientDisconnect(destination, () => source.destroy(), 'Audio transcription')
  let usage = null
  let terminal = null
  let streamError = null
  const observe = (events) => {
    for (const event of events) {
      if (event.type !== 'data') {
        continue
      }
      const { data } = event
      if (data.usage) {
        const { usage: reportedUsage } = data
        usage = reportedUsage
      }
      const type = data.type ?? event.name
      if (['transcript.text.done', 'text.done'].includes(type)) {
        terminal = type
      } else if (type === 'error' || data.error) {
        terminal = 'error'
        streamError = data
      }
    }
  }
  try {
    for await (const chunk of source) {
      observe(parser.feed(chunk))
      if (!destination.destroyed && !destination.writableEnded && !destination.write(chunk)) {
        await backpressure.waitForDrain()
      }
    }
    observe(parser.finish())
  } catch (error) {
    streamError = error
  } finally {
    backpressure.dispose()
    detach()
  }
  const failed = terminal === 'error' || !terminal
  if (failed && terminal !== 'error' && !destination.destroyed && !destination.writableEnded) {
    const error = buildClientError({ statusCode: 502, protocol: 'openai' })
    destination.write(`event: error\ndata: ${JSON.stringify(error.body)}\n\n`)
  }
  return {
    data: { usage },
    streaming: true,
    protocolTerminal: terminal,
    statusCode: failed ? 502 : response.status,
    errorCode: failed ? (streamError ? 'upstream_audio_stream_error' : 'upstream_audio_stream_incomplete') : null,
  }
}
