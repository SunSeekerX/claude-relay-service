import { IncrementalSSEParser } from './relay_sse_parser.js'
import { extractErrorMessage, sanitizeErrorMsg } from '../../common/test_payload_helper.js'

export const modelTestSignal = (res) => {
  const controller = new AbortController()
  res.once('close', () => {
    if (!res.writableEnded) {
      controller.abort()
    }
  })
  if (res.destroyed) {
    controller.abort()
  }
  return controller.signal
}

export const rejectModelTestResponse = async (stream, res, status) => {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk)
    chunks.push(buffer.subarray(0, 65536 - size))
    size += buffer.length
    if (size >= 65536) {
      break
    }
  }
  let message = `API Error: ${status}`
  try {
    message = extractErrorMessage(JSON.parse(Buffer.concat(chunks).toString('utf8')), message)
  } catch {
    message = `API Error: ${status}`
  }
  if (!res.destroyed && !res.writableEnded) {
    res.write(
      `data: ${JSON.stringify({ type: 'test_complete', success: false, error: sanitizeErrorMsg(message) })}\n\n`,
    )
    res.end()
  }
}

export const pipeModelTestStream = async (stream, res, format) => {
  const parser = new IncrementalSSEParser()
  let completed = false
  let failed = false
  const write = (data) => {
    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
  }
  const consume = (events) => {
    for (const event of events) {
      if (event.type === 'invalid') {
        failed = true
        continue
      }
      if (event.type === 'done' && format === 'openai-chat') {
        completed = true
        continue
      }
      if (event.type !== 'data') {
        continue
      }
      const { data } = event
      if (!data || typeof data !== 'object') {
        failed = true
        continue
      }
      if (data.error || ['error', 'response.failed', 'response.incomplete'].includes(data.type)) {
        failed = true
      }
      if (data.type === 'response.completed') {
        completed = data.response?.status === 'completed'
        if (!completed) {
          failed = true
        }
      }
      if (format === 'claude-messages') {
        if (data.type === 'message_stop') {
          completed = true
        }
        if (data.type === 'message_delta' && ['max_tokens', 'refusal'].includes(data.delta?.stop_reason)) {
          failed = true
        }
      }
      if (format === 'gemini-generate') {
        const reason = data.candidates?.[0]?.finishReason
        if (reason) {
          completed = reason === 'STOP'
          if (!completed) {
            failed = true
          }
        }
        if (data.promptFeedback?.blockReason) {
          failed = true
        }
      }
      const text =
        format === 'gemini-generate'
          ? data.candidates?.[0]?.content?.parts
              ?.filter((part) => !part.thought)
              .map((part) => part.text ?? '')
              .join('')
          : format === 'claude-messages'
            ? data.type === 'content_block_delta'
              ? data.delta?.text
              : null
            : format === 'openai-chat'
              ? data.choices?.[0]?.delta?.content
              : data.type === 'response.output_text.delta'
                ? data.delta
                : data.type === 'response.content_part.delta'
                  ? data.delta?.text
                  : null
      if (typeof text === 'string' && text) {
        write({ type: 'content', text })
      }
    }
  }
  try {
    for await (const chunk of stream) {
      consume(parser.feed(chunk))
    }
    consume(parser.finish())
    write({
      type: 'test_complete',
      success: completed && !failed,
      ...(!completed || failed ? { error: failed ? '模型返回失败或不完整结果' : '模型流未正常完成' } : {}),
    })
  } catch {
    write({ type: 'test_complete', success: false, error: '模型测试连接中断' })
  } finally {
    if (!res.writableEnded) {
      res.end()
    }
  }
}
