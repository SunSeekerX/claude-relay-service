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
export const parseSSELine = (line) => {
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
    this.parts = []
    this.smallParts = []
    this.smallLength = 0
    this.pendingLength = 0
    this.tail = ''
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
    return this._takeFrames(this.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
  }

  _flushSmallParts() {
    if (this.smallLength > 0) {
      this.parts.push(this.smallParts.join(''))
      this.smallParts = []
      this.smallLength = 0
    }
  }

  _append(text) {
    if (!text) {
      return
    }
    this.pendingLength += text.length
    if (this.pendingLength > 64 * 1024 * 1024) {
      throw new Error('SSE event exceeds the buffer limit')
    }
    // 合并细碎分片，避免单字节输入产生与正文同量级的数组条目。
    if (text.length >= 4096) {
      this._flushSmallParts()
      this.parts.push(text)
    } else {
      this.smallParts.push(text)
      this.smallLength += text.length
      if (this.smallLength >= 4096) {
        this._flushSmallParts()
      }
    }
  }

  _takePending() {
    this._flushSmallParts()
    const text = this.parts.length === 1 ? this.parts[0] : this.parts.join('')
    this.parts = []
    this.pendingLength = 0
    this.tail = ''
    return text
  }

  _takeFrames(text) {
    const frames = []
    if (!text) {
      return frames
    }
    // 最长分隔符为四字符；只重看前一分片末尾三字符，不重扫累计事件。
    const prefixLength = this.tail.length
    const scanned = this.tail + text
    // DEC_20260905_155232
    const boundary = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/g
    let match
    let consumed = 0
    while ((match = boundary.exec(scanned))) {
      const end = match.index + match[0].length - prefixLength
      const part = text.slice(consumed, end)
      if (this.pendingLength === 0) {
        if (part.length > 64 * 1024 * 1024) {
          throw new Error('SSE event exceeds the buffer limit')
        }
        frames.push(part)
        this.tail = ''
      } else {
        this._append(part)
        frames.push(this._takePending())
      }
      consumed = end
    }
    const remaining = text.slice(consumed)
    this._append(remaining)
    this.tail = (this.tail + remaining).slice(-3)
    return frames
  }

  finishFrames() {
    const frames = this._takeFrames(this.decoder.end())
    const remaining = this._takePending()
    if (remaining.trim()) {
      frames.push(`${remaining}\n\n`)
    }
    return frames
  }

  finish() {
    return this.finishFrames().map(parseSSEEvent)
  }

  /**
   * 是否有尚未完成的事件；不拼接累计正文。
   * @returns {boolean}
   */
  hasPending() {
    return this.pendingLength > 0
  }

  /**
   * 重置解析器
   */
  reset() {
    this.parts = []
    this.smallParts = []
    this.smallLength = 0
    this.pendingLength = 0
    this.tail = ''
    this.decoder = new StringDecoder('utf8')
  }
}
