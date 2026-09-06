// multipart/form-data：按 RFC 边界语法切 part，只在 text part 上读/改字段
// - boundary 优先取 Content-Type，禁止盲信正文首行
// - 分隔符必须是 line-start 的 --boundary，后接 CRLF 或 --
// - 禁止整包 UTF-8 编解码，文件 part 原样拷贝

const isCRLF = (buffer, index) => index >= 0 && buffer[index] === 0x0d && buffer[index + 1] === 0x0a

const isLF = (buffer, index) => index >= 0 && buffer[index] === 0x0a

const startsAtLineBoundary = (buffer, index) => {
  if (index === 0) {
    return true
  }
  if (isCRLF(buffer, index - 2)) {
    return true
  }
  if (isLF(buffer, index - 1)) {
    return true
  }
  return false
}

// RFC 2046: delimiter 后可有 transport padding 空白，再接 CRLF 或 --
const skipLinearWhitespace = (buffer, index) => {
  let cursor = index
  while (cursor < buffer.length) {
    const byte = buffer[cursor]
    // space / tab
    if (byte === 0x20 || byte === 0x09) {
      cursor += 1
      continue
    }
    break
  }
  return cursor
}

const isValidBoundaryDelimiterAt = (buffer, index, delim) => {
  if (index < 0 || index + delim.length > buffer.length) {
    return false
  }
  if (!startsAtLineBoundary(buffer, index)) {
    return false
  }
  if (!buffer.subarray(index, index + delim.length).equals(delim)) {
    return false
  }
  const after = skipLinearWhitespace(buffer, index + delim.length)
  // --boundary--  (close-delimiter; padding 后再跟 -- 也接受)
  if (after + 1 < buffer.length && buffer[after] === 0x2d && buffer[after + 1] === 0x2d) {
    return true
  }
  // --boundary[WSP*]\r\n | --boundary[WSP*]\n
  if (isCRLF(buffer, after) || isLF(buffer, after)) {
    return true
  }
  return false
}

const findNextBoundary = (buffer, from, delim) => {
  let index = from
  while (index <= buffer.length - delim.length) {
    const found = buffer.indexOf(delim, index)
    if (found < 0) {
      return -1
    }
    if (isValidBoundaryDelimiterAt(buffer, found, delim)) {
      return found
    }
    index = found + 1
  }
  return -1
}

// RFC 9110 token / quoted-string 参数表扫描（Content-Type 与 Content-Disposition 共用）
// - 参数名 token 含 . ! # $ 等
// - 引号内 ; 与 \" 不算结束；quoted-pair 解码
// - 禁止用整行正则，避免 note="x; name=model" 冒充 name
// DEC_20260906_011816 quoted-string 内文本不得冒充 disposition/type 参数
const isRfcParamTokenChar = (ch) => /[A-Za-z0-9!#$%&'*+.^_`|~-]/.test(ch)

const parseRfcParamList = (text, startIndex = 0) => {
  const params = Object.create(null)
  if (typeof text !== 'string' || !text) {
    return params
  }
  let index = Math.max(0, startIndex)
  const { length } = text
  while (index < length) {
    if (text[index] === ';') {
      index += 1
    }
    while (index < length && /\s/.test(text[index])) {
      index += 1
    }
    if (index >= length) {
      break
    }
    const nameStart = index
    while (index < length && isRfcParamTokenChar(text[index])) {
      index += 1
    }
    const name = text.slice(nameStart, index).toLowerCase()
    while (index < length && /\s/.test(text[index])) {
      index += 1
    }
    if (text[index] !== '=') {
      // 坏参数：跳到下一个未转义引号外的 ;
      let inQuotes = false
      while (index < length) {
        const ch = text[index]
        if (inQuotes && ch === '\\' && index + 1 < length) {
          index += 2
          continue
        }
        if (ch === '"') {
          inQuotes = !inQuotes
          index += 1
          continue
        }
        if (ch === ';' && !inQuotes) {
          break
        }
        index += 1
      }
      continue
    }
    index += 1
    while (index < length && /\s/.test(text[index])) {
      index += 1
    }
    let value
    if (text[index] === '"') {
      index += 1
      let decoded = ''
      while (index < length) {
        const ch = text[index]
        if (ch === '\\' && index + 1 < length) {
          // quoted-pair：保留后随字符，去掉反斜杠
          decoded += text[index + 1]
          index += 2
          continue
        }
        if (ch === '"') {
          break
        }
        decoded += ch
        index += 1
      }
      value = decoded
      if (text[index] === '"') {
        index += 1
      }
    } else {
      const valueStart = index
      while (index < length && text[index] !== ';') {
        index += 1
      }
      value = text.slice(valueStart, index).trim()
      // 单引号是 RFC 9110 tchar / RFC 2046 boundary 合法字符，不是 quoting
      // name='model' 的 token 值就是 'model'（含引号），不会匹配字段名 model
      // DEC_20260906_014853 禁止因首字符是 ' 丢掉合法 boundary
    }
    if (name && value !== '' && params[name] === undefined) {
      params[name] = value
    }
  }
  return params
}

export const parseMultipartBoundaryFromContentType = (contentType) => {
  if (typeof contentType !== 'string' || !contentType) {
    return null
  }
  // 跳过 type/subtype，只扫 ; 后参数
  let index = 0
  const { length } = contentType
  while (index < length && contentType[index] !== ';') {
    index += 1
  }
  const params = parseRfcParamList(contentType, index)
  return params.boundary || null
}

const getMultipartBoundary = (buffer, contentType = null) => {
  const fromHeader = parseMultipartBoundaryFromContentType(contentType)
  if (fromHeader) {
    return fromHeader
  }
  // Content-Type 已给出时禁止回退正文首行，避免假前导 --fake 骗本地选号
  // DEC_20260906_014853
  if (typeof contentType === 'string' && contentType) {
    return null
  }
  // 兜底：仅无 Content-Type 且正文以 --boundary 开头时才信首行
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null
  }
  if (buffer[0] !== 0x2d || buffer[1] !== 0x2d) {
    return null
  }
  let end = buffer.indexOf('\r\n')
  if (end < 0) {
    end = buffer.indexOf('\n')
  }
  if (end < 3) {
    return null
  }
  const line = buffer.subarray(0, end).toString('ascii')
  if (!line.startsWith('--')) {
    return null
  }
  const boundary = line.slice(2).trim()
  return boundary || null
}

const splitMultipartParts = (buffer, contentType = null) => {
  const boundary = getMultipartBoundary(buffer, contentType)
  if (!boundary || !Buffer.isBuffer(buffer)) {
    return { boundary: null, parts: [] }
  }
  const delim = Buffer.from(`--${boundary}`)
  const parts = []
  let start = findNextBoundary(buffer, 0, delim)
  if (start < 0) {
    return { boundary, parts }
  }
  start += delim.length
  start = skipLinearWhitespace(buffer, start)
  if (isCRLF(buffer, start)) {
    start += 2
  } else if (isLF(buffer, start)) {
    start += 1
  }

  while (start < buffer.length) {
    const next = findNextBoundary(buffer, start, delim)
    if (next < 0) {
      break
    }
    let partEnd = next
    if (partEnd >= 2 && isCRLF(buffer, partEnd - 2)) {
      partEnd -= 2
    } else if (partEnd >= 1 && isLF(buffer, partEnd - 1)) {
      partEnd -= 1
    }
    if (partEnd > start) {
      parts.push({ start, end: partEnd, buffer: buffer.subarray(start, partEnd) })
    }
    let after = skipLinearWhitespace(buffer, next + delim.length)
    if (after + 1 < buffer.length && buffer[after] === 0x2d && buffer[after + 1] === 0x2d) {
      break
    }
    if (isCRLF(buffer, after)) {
      after += 2
    } else if (isLF(buffer, after)) {
      after += 1
    }
    start = after
  }
  return { boundary, parts }
}

const parsePartHeadersAndBody = (partBuffer) => {
  let sep = partBuffer.indexOf('\r\n\r\n')
  let sepLen = 4
  if (sep < 0) {
    sep = partBuffer.indexOf('\n\n')
    sepLen = 2
  }
  if (sep < 0) {
    return null
  }
  const headerText = partBuffer.subarray(0, sep).toString('ascii')
  const body = partBuffer.subarray(sep + sepLen)
  return { headerText, body, headerEnd: sep, sepLen }
}

const getContentDispositionName = (headerText) => {
  // 只解析 Content-Disposition 行；RFC 参数扫描，quoted-string 内文本不得冒充 name
  // DEC_20260906_011816
  const dispositionLine =
    headerText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^content-disposition\s*:/i.test(line)) || ''
  if (!dispositionLine) {
    return null
  }
  const colon = dispositionLine.indexOf(':')
  const valuePart = colon >= 0 ? dispositionLine.slice(colon + 1).trim() : dispositionLine
  // disposition-type（form-data）之后才是参数
  let index = 0
  while (index < valuePart.length && valuePart[index] !== ';') {
    index += 1
  }
  const params = parseRfcParamList(valuePart, index)
  return typeof params.name === 'string' && params.name ? params.name : null
}

const isFilePart = (headerText) => /content-disposition:[^\n]*\bfilename\*?=/i.test(headerText)

// options.contentType: 请求 Content-Type（含 boundary=）
export const extractMultipartFormField = (buffer, fieldName, options = {}) => {
  if (!Buffer.isBuffer(buffer) || !fieldName) {
    return null
  }
  const contentType = options.contentType || null
  const { parts } = splitMultipartParts(buffer, contentType)
  for (const part of parts) {
    const parsed = parsePartHeadersAndBody(part.buffer)
    if (!parsed) {
      continue
    }
    if (isFilePart(parsed.headerText)) {
      continue
    }
    const name = getContentDispositionName(parsed.headerText)
    if (name !== fieldName) {
      continue
    }
    return (
      parsed.body
        .toString('utf8')
        .replace(/\r?\n$/, '')
        .trim() || null
    )
  }
  return null
}

export const rewriteMultipartFormField = (buffer, fieldName, newValue, options = {}) => {
  if (!Buffer.isBuffer(buffer) || !fieldName || newValue === undefined || newValue === null) {
    return buffer
  }
  const contentType = options.contentType || null
  const { boundary, parts } = splitMultipartParts(buffer, contentType)
  if (!boundary || parts.length === 0) {
    return buffer
  }

  let target = null
  for (const part of parts) {
    const parsed = parsePartHeadersAndBody(part.buffer)
    if (!parsed || isFilePart(parsed.headerText)) {
      continue
    }
    if (getContentDispositionName(parsed.headerText) === fieldName) {
      target = { part, parsed }
      break
    }
  }
  if (!target) {
    return buffer
  }

  const { part, parsed } = target
  const newBody = Buffer.from(String(newValue), 'utf8')
  const headerBuf = part.buffer.subarray(0, parsed.headerEnd + parsed.sepLen)
  const rebuiltPart = Buffer.concat([headerBuf, newBody])

  // 保留原包前缀/后缀与原始 boundary 行字节，只替换目标 part body
  const prefix = buffer.subarray(0, part.start)
  const suffix = buffer.subarray(part.end)
  return Buffer.concat([prefix, rebuiltPart, suffix])
}
