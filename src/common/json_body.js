// 保留原有 trim 空白正文判定，常见 UTF-8 JSON 不额外解码整包。
export const verifyJsonBody = (req, _res, buffer, encoding) => {
  req._crsRecordRequestBodyBytes?.(buffer.length)
  if (!buffer.length) {
    return
  }
  if (!encoding || encoding === 'utf-8' || encoding === 'utf8') {
    for (const byte of buffer) {
      if (byte === 32 || (byte >= 9 && byte <= 13)) {
        continue
      }
      if (byte < 128) {
        return
      }
      if (buffer.toString(encoding || 'utf8').trim()) {
        return
      }
      throw new Error('Invalid JSON: empty body')
    }
  } else if (buffer.toString(encoding).trim()) {
    return
  }
  throw new Error('Invalid JSON: empty body')
}
