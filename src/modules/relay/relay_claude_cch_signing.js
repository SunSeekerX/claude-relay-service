// Claude Code billing 块 cch 签名：对最终序列化 body 计算 xxHash64，只改写 5 位 cch
// DEC_20261001_114137 OAuth 官方上游补 cch 签名，算法对齐 Claude Code 2.1.280 / CLIProxyAPI
import xxhash from 'xxhash-wasm'

const CCH_SEED = 0x4d659218e32a3268n
const CCH_LENGTH = 5
const CCH_ZERO = '00000'
const CCH_PLACEHOLDER = ' cch=00000;'
const BILLING_PREFIX = 'x-anthropic-billing-header:'
const ENTRYPOINT_RE = /cc_entrypoint=[^;]*;/
const LOWER_HEX_RE = /^[0-9a-f]{5}$/

// 哈希视图中整成员剔除的分发字段（任意层级）
const EXCLUDED_KEYS = new Set(['"max_tokens"', '"fallbacks"', '"fallback_credit_token"'])

const hasherPromise = xxhash()

// 在 billing 文本 cc_entrypoint 段后补 cch 占位；已有 cch 不重复
export const insertCchPlaceholder = (billingText) => {
  if (typeof billingText !== 'string' || !billingText.startsWith(BILLING_PREFIX)) {
    return billingText
  }
  if (/\bcch=[0-9a-f]{5};/.test(billingText)) {
    return billingText
  }
  const match = billingText.match(ENTRYPOINT_RE)
  if (!match) {
    return `${billingText}${CCH_PLACEHOLDER}`
  }
  const insertAt = match.index + match[0].length
  return `${billingText.slice(0, insertAt)}${CCH_PLACEHOLDER}${billingText.slice(insertAt)}`
}

// 字节级 JSON 扫描：model 字符串值置空、剔除分发字段成员，不重新序列化
class CchJsonScanner {
  constructor(bytes) {
    this.bytes = bytes
    this.pos = 0
    this.edits = []
  }

  skipWhitespace() {
    while (this.pos < this.bytes.length) {
      const code = this.bytes[this.pos]
      if (code !== 0x20 && code !== 0x09 && code !== 0x0d && code !== 0x0a) {
        return
      }
      this.pos += 1
    }
  }

  consume(code) {
    if (this.pos < this.bytes.length && this.bytes[this.pos] === code) {
      this.pos += 1
      return true
    }
    return false
  }

  addEdit(start, end) {
    if (start < end) {
      this.edits.push({ start, end })
    }
  }

  parseString() {
    if (this.bytes[this.pos] !== 0x22) {
      throw new Error(`missing JSON string at byte ${this.pos}`)
    }
    const start = this.pos
    this.pos += 1
    while (this.pos < this.bytes.length) {
      const code = this.bytes[this.pos]
      if (code === 0x5c) {
        this.pos += 2
      } else if (code === 0x22) {
        this.pos += 1
        return { start, end: this.pos }
      } else {
        this.pos += 1
      }
    }
    throw new Error(`unterminated JSON string at byte ${start}`)
  }

  parseValue(collect) {
    this.skipWhitespace()
    if (this.pos >= this.bytes.length) {
      throw new Error(`missing JSON value at byte ${this.pos}`)
    }
    const code = this.bytes[this.pos]
    if (code === 0x7b) {
      this.parseObject(collect)
      return
    }
    if (code === 0x5b) {
      this.parseArray(collect)
      return
    }
    if (code === 0x22) {
      this.parseString()
      return
    }
    const start = this.pos
    while (this.pos < this.bytes.length) {
      const current = this.bytes[this.pos]
      if ([0x2c, 0x7d, 0x5d, 0x20, 0x09, 0x0d, 0x0a].includes(current)) {
        break
      }
      this.pos += 1
    }
    if (this.pos === start) {
      throw new Error(`missing JSON value at byte ${start}`)
    }
  }
  parseArray(collect) {
    this.pos += 1
    this.skipWhitespace()
    if (this.consume(0x5d)) {
      return
    }
    for (;;) {
      this.parseValue(collect)
      this.skipWhitespace()
      if (this.consume(0x2c)) {
        continue
      }
      if (!this.consume(0x5d)) {
        throw new Error(`missing array end at byte ${this.pos}`)
      }
      return
    }
  }

  parseObject(collect) {
    this.pos += 1
    this.skipWhitespace()
    if (this.consume(0x7d)) {
      return
    }
    const members = []
    let commaBefore = -1
    for (;;) {
      this.skipWhitespace()
      const memberStart = this.pos
      const keyRange = this.parseString()
      this.skipWhitespace()
      if (!this.consume(0x3a)) {
        throw new Error(`missing object colon at byte ${this.pos}`)
      }
      this.skipWhitespace()
      const key = Buffer.from(this.bytes.subarray(keyRange.start, keyRange.end)).toString('latin1')
      const excluded = collect && EXCLUDED_KEYS.has(key)
      if (collect && key === '"model"' && this.bytes[this.pos] === 0x22) {
        const valueRange = this.parseString()
        this.addEdit(valueRange.start + 1, valueRange.end - 1)
      } else {
        this.parseValue(collect && !excluded)
      }
      const memberEnd = this.pos
      this.skipWhitespace()
      let commaAfter = -1
      if (this.consume(0x2c)) {
        commaAfter = this.pos - 1
      }
      members.push({ start: memberStart, end: memberEnd, commaBefore, commaAfter, excluded })
      if (commaAfter >= 0) {
        commaBefore = commaAfter
        continue
      }
      if (!this.consume(0x7d)) {
        throw new Error(`missing object end at byte ${this.pos}`)
      }
      break
    }
    if (collect) {
      this.addExcludedMemberEdits(members)
    }
  }

  // 连续剔除段的逗号处理与原生 CLI 哈希视图逐字节一致
  addExcludedMemberEdits(members) {
    for (let start = 0; start < members.length;) {
      if (!members[start].excluded) {
        start += 1
        continue
      }
      let end = start
      while (end + 1 < members.length && members[end + 1].excluded) {
        end += 1
      }
      if (end + 1 < members.length) {
        this.addEdit(members[start].start, members[end].commaAfter + 1)
      } else if (start > 0 && end > start) {
        this.addEdit(members[start].start, members[end].end)
      } else if (start > 0) {
        this.addEdit(members[start].commaBefore, members[end].end)
      } else {
        this.addEdit(members[start].start, members[end].end)
      }
      start = end + 1
    }
  }
}

const buildHashView = (bytes) => {
  const scanner = new CchJsonScanner(bytes)
  scanner.parseValue(true)
  scanner.skipWhitespace()
  if (scanner.pos !== bytes.length) {
    throw new Error(`unexpected JSON data at byte ${scanner.pos}`)
  }
  scanner.edits.sort((left, right) => left.start - right.start)
  const chunks = []
  let last = 0
  for (const edit of scanner.edits) {
    if (edit.start < last || edit.end > bytes.length) {
      throw new Error(`overlapping cch normalization edit at byte ${edit.start}`)
    }
    chunks.push(bytes.subarray(last, edit.start))
    last = edit.end
  }
  chunks.push(bytes.subarray(last))
  return Buffer.concat(chunks)
}

// 定位 system[0] billing 文本中 cch 五位数字在序列化字符串里的偏移
const findCchDigitsOffset = (bodyString, requestPayload) => {
  const billingText = requestPayload?.system?.[0]?.text
  if (typeof billingText !== 'string' || !billingText.startsWith(BILLING_PREFIX)) {
    return -1
  }
  const serializedBilling = JSON.stringify(billingText)
  const billingOffset = bodyString.indexOf(serializedBilling)
  if (billingOffset < 0) {
    return -1
  }
  let searchFrom = 0
  for (;;) {
    const relative = serializedBilling.indexOf('cch=', searchFrom)
    if (relative < 0) {
      return -1
    }
    const digitsStart = relative + 4
    const digits = serializedBilling.slice(digitsStart, digitsStart + CCH_LENGTH)
    if (serializedBilling[digitsStart + CCH_LENGTH] === ';' && LOWER_HEX_RE.test(digits)) {
      return billingOffset + digitsStart
    }
    searchFrom = digitsStart
  }
}

// 对最终 bodyString 签名；billing 块不在 system[0] 或无 cch 占位时原样返回
export const signClaudeMessagesBody = async (bodyString, requestPayload) => {
  const offset = findCchDigitsOffset(bodyString, requestPayload)
  if (offset < 0) {
    return bodyString
  }
  const unsigned = `${bodyString.slice(0, offset)}${CCH_ZERO}${bodyString.slice(offset + CCH_LENGTH)}`
  const { h64Raw } = await hasherPromise
  const hashView = buildHashView(Buffer.from(unsigned, 'utf8'))
  const cch = (h64Raw(hashView, CCH_SEED) & 0xfffffn).toString(16).padStart(CCH_LENGTH, '0')
  return `${unsigned.slice(0, offset)}${cch}${unsigned.slice(offset + CCH_LENGTH)}`
}
