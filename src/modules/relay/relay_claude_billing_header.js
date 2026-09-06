// Claude Code billing attribution 块：注入 + 与 outbound UA 版本对齐
// DEC_20260905_194420 全路径注入并对齐 fingerprint；算法对齐真实 CLI / Parrot / sub2api
import crypto from 'node:crypto'

import { extractClaudeCliVersionFromUserAgent, getClaudeCliVersion } from './relay_claude_cli_version.js'

// 真实 Claude Code CLI 抓包推导盐，改动会触发上游第三方判定
const FINGERPRINT_SALT = '59cf53e54c78'

const BILLING_PREFIX = 'x-anthropic-billing-header'
const CC_VERSION_WITH_FP_RE = /cc_version=\d+\.\d+\.\d+\.[0-9a-fA-F]{3}\b/g
const CC_VERSION_RE = /cc_version=\d+\.\d+\.\d+/g

const isBillingText = (text) => typeof text === 'string' && text.trim().toLowerCase().startsWith(BILLING_PREFIX)

// 取 messages 首条 user 的首段纯文本
export const extractFirstUserText = (body) => {
  const messages = body?.messages
  if (!Array.isArray(messages)) {
    return ''
  }
  for (const message of messages) {
    if (!message || message.role !== 'user') {
      continue
    }
    const { content } = message
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          return block.text
        }
      }
      return ''
    }
    return ''
  }
  return ''
}

// SHA256(SALT + chars@4,7,20 + version) hex 前 3 位
export const computeClaudeCodeFingerprint = (body, version) => {
  const firstText = extractFirstUserText(body)
  const chars = []
  for (const index of [4, 7, 20]) {
    chars.push(index < firstText.length ? firstText[index] : '0')
  }
  const digest = crypto
    .createHash('sha256')
    .update(FINGERPRINT_SALT + chars.join('') + String(version || ''), 'utf8')
    .digest('hex')
  return digest.slice(0, 3)
}

export const buildBillingAttributionText = (body, cliVersion) => {
  const version = typeof cliVersion === 'string' && cliVersion.trim() ? cliVersion.trim() : getClaudeCliVersion()
  const fingerprint = computeClaudeCodeFingerprint(body, version)
  return `${BILLING_PREFIX}: cc_version=${version}.${fingerprint}; cc_entrypoint=cli;`
}

export const stripBillingHeaderFromSystem = (processedBody) => {
  if (!processedBody || processedBody.system === undefined || processedBody.system === null) {
    return processedBody
  }

  if (typeof processedBody.system === 'string') {
    if (isBillingText(processedBody.system)) {
      // 仅剥 billing 前缀行，保留同字符串后续业务指令
      const lines = processedBody.system.split(/\r?\n/)
      const kept = []
      let skippedBillingLine = false
      for (const line of lines) {
        if (!skippedBillingLine && isBillingText(line)) {
          skippedBillingLine = true
          continue
        }
        kept.push(line)
      }
      const nextText = kept.join('\n').trim()
      if (nextText) {
        processedBody.system = nextText
      } else {
        delete processedBody.system
      }
    }
    return processedBody
  }

  if (Array.isArray(processedBody.system)) {
    processedBody.system = processedBody.system.filter(
      (item) => !(item && item.type === 'text' && typeof item.text === 'string' && isBillingText(item.text)),
    )
  }
  return processedBody
}

const ensureSystemArray = (processedBody) => {
  if (!processedBody.system) {
    processedBody.system = []
    return
  }
  if (typeof processedBody.system === 'string') {
    const text = processedBody.system
    processedBody.system = text.trim() ? [{ type: 'text', text }] : []
    return
  }
  if (!Array.isArray(processedBody.system)) {
    processedBody.system = []
  }
}

// 用 outbound UA 的版本重写已有 billing 块中的 cc_version（含 fp 重算）
export const syncBillingHeaderVersion = (processedBody, userAgent) => {
  if (!processedBody || !Array.isArray(processedBody.system)) {
    return processedBody
  }
  const version = extractClaudeCliVersionFromUserAgent(userAgent)
  if (!version) {
    return processedBody
  }
  const replacement = `cc_version=${version}`
  const fingerprinted = `${replacement}.${computeClaudeCodeFingerprint(processedBody, version)}`
  for (const item of processedBody.system) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string' || !isBillingText(item.text)) {
      continue
    }
    let nextText = item.text.replace(CC_VERSION_WITH_FP_RE, fingerprinted)
    nextText = nextText.replace(CC_VERSION_RE, replacement)
    item.text = nextText
  }
  return processedBody
}

// 全路径：剥离客户端 billing → 注入对齐版本的 attribution → 再按 UA 同步一次（幂等）
// DEC_20260905_194420 全路径注入并对齐 fingerprint
export const ensureAlignedBillingHeader = (processedBody, options = {}) => {
  if (!processedBody || typeof processedBody !== 'object') {
    return processedBody
  }

  const userAgent = typeof options.userAgent === 'string' && options.userAgent.trim() ? options.userAgent.trim() : ''
  const versionFromUa = extractClaudeCliVersionFromUserAgent(userAgent)
  const cliVersion =
    typeof options.cliVersion === 'string' && options.cliVersion.trim()
      ? options.cliVersion.trim()
      : versionFromUa || getClaudeCliVersion()

  stripBillingHeaderFromSystem(processedBody)
  ensureSystemArray(processedBody)

  const billingText = buildBillingAttributionText(processedBody, cliVersion)
  processedBody.system.unshift({
    type: 'text',
    text: billingText,
  })

  if (userAgent) {
    syncBillingHeaderVersion(processedBody, userAgent)
  }
  return processedBody
}
