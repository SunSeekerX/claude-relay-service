import { StringDecoder } from 'node:string_decoder'

/**
 * Server-Sent Events (SSE) 解析工具
 *
 * 用于解析标准 SSE 格式的数据流
 * 当前主要用于 Gemini API 的流式响应处理
 *
 * @module sseParser
 */

/**
 * 解析单行 SSE 数据
 *
 * @param {string} line - SSE 格式的行（如："data: {json}\n"）
 * @returns {Object} 解析结果
 * @returns {'data'|'control'|'other'|'invalid'} .type - 行类型
 * @returns {Object|null} .data - 解析后的 JSON 数据（仅 type='data' 时）
 * @returns {string} .line - 原始行内容
 * @returns {string} [.jsonStr] - JSON 字符串
 * @returns {Error} [.error] - 解析错误（仅 type='invalid' 时）
 *
 * @example
 * // 数据行
 * parseSSELine('data: {"key":"value"}')
 * // => { type: 'data', data: {key: 'value'}, line: '...', jsonStr: '...' }
 *
 * @example
 * // 控制行
 * parseSSELine('data: [DONE]')
 * // => { type: 'control', data: null, line: '...', jsonStr: '[DONE]' }
 */
export const parseSSELine = function parseSSELine(line) {
  if (!line.startsWith('data:')) {
    return { type: 'other', line, data: null }
  }

  const jsonStr = line.substring(5).trim()

  if (!jsonStr || jsonStr === '[DONE]') {
    return { type: 'control', line, data: null, jsonStr }
  }

  try {
    const data = JSON.parse(jsonStr)
    return { type: 'data', line, data, jsonStr }
  } catch (e) {
    return { type: 'invalid', line, data: null, jsonStr, error: e }
  }
}

// data 字段允许省略冒号后的空格；同一事件的多行 data 必须合并后解析。
export const parseSSEEvent = (frame) => {
  let name = ''
  const dataLines = []
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line.startsWith('event:')) {
      name = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      const value = line.slice(5)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }
  const raw = dataLines.join('\n')
  if (dataLines.length === 0) {
    return { type: 'event', name }
  }
  if (raw.trim() === '[DONE]') {
    return { type: 'done', name }
  }
  try {
    return { type: 'data', name, data: JSON.parse(raw) }
  } catch (error) {
    return { type: 'invalid', name, raw, error }
  }
}

/**
 * 增量 SSE 解析器类
 * 用于处理流式数据，避免每次都 split 整个 buffer
 */
export class IncrementalSSEParser {
  constructor() {
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
  }

  /**
   * 添加数据块并返回完整的事件
   * @param {string} chunk - 数据块
   * @returns {Array<Object>} 解析出的完整事件数组
   */
  feed(chunk) {
    return this.feedFrames(chunk).map(parseSSEEvent)
  }

  // 返回含原始分隔符的完整事件，供出站改写复用同一个字节解码和分帧规则。
  feedFrames(chunk) {
    this.buffer += this.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    return this._takeFrames()
  }

  _takeFrames() {
    const frames = []
    // DEC_20260905_155232
    const boundary = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/
    let match
    while ((match = boundary.exec(this.buffer))) {
      const end = match.index + match[0].length
      if (end > 64 * 1024 * 1024) {
        throw new Error('SSE event exceeds the buffer limit')
      }
      frames.push(this.buffer.slice(0, end))
      this.buffer = this.buffer.slice(end)
    }
    if (this.buffer.length > 64 * 1024 * 1024) {
      throw new Error('SSE event exceeds the buffer limit')
    }
    return frames
  }

  finishFrames() {
    this.buffer += this.decoder.end()
    const frames = this._takeFrames()
    if (this.buffer.trim()) {
      frames.push(`${this.buffer}\n\n`)
    }
    this.buffer = ''
    return frames
  }

  finish() {
    return this.finishFrames().map(parseSSEEvent)
  }

  /**
   * 获取剩余的 buffer 内容
   * @returns {string}
   */
  getRemaining() {
    return this.buffer
  }

  /**
   * 重置解析器
   */
  reset() {
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
  }
}
