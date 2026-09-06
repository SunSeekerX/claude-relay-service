// Claude CLI 伪装版本：内置基线 + 环境变量覆盖
// DEC_20260905_194420 基线抬到 2.1.251 以开箱支持 fable；CLAUDE_CLI_VERSION 可再抬高
// 进程启动解析一次：UA 与 billing cc_version 必须同源，禁止每次读 env
import { env } from '../../../config/env.js'
import { logger } from '../../common/logger.js'

// 内置基线（未配置覆盖时的生效值；覆盖值不得低于此）
export const CLAUDE_CLI_BASELINE_VERSION = '2.1.251'

const STRICT_THREE_PART_SEMVER = /^\d+\.\d+\.\d+$/

const parseSemverParts = (version) => {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    return null
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

// a >= b
export const isSemverGte = (left, right) => {
  const leftParts = parseSemverParts(left)
  const rightParts = parseSemverParts(right)
  if (!leftParts || !rightParts) {
    return false
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) {
      return true
    }
    if (leftParts[index] < rightParts[index]) {
      return false
    }
  }
  return true
}

// 严格三段纯数字且不低于内置基线
export const isSupportedClaudeCliVersion = (version) => {
  const normalized = typeof version === 'string' ? version.trim() : ''
  if (!normalized || !STRICT_THREE_PART_SEMVER.test(normalized)) {
    return false
  }
  return isSemverGte(normalized, CLAUDE_CLI_BASELINE_VERSION)
}

export const resolveClaudeCliVersion = (rawOverride) => {
  const version = typeof rawOverride === 'string' ? rawOverride.trim() : ''
  if (!version) {
    return CLAUDE_CLI_BASELINE_VERSION
  }
  if (!isSupportedClaudeCliVersion(version)) {
    logger.warn(
      `[ClaudeCLI] ignore invalid CLAUDE_CLI_VERSION override value=${version} baseline=${CLAUDE_CLI_BASELINE_VERSION} requirement=strict three-part semver not older than baseline`,
    )
    return CLAUDE_CLI_BASELINE_VERSION
  }
  return version
}

// 启动时解析一次，伪装身份在进程生命周期内恒定
const resolvedClaudeCliVersion = resolveClaudeCliVersion(env.CLAUDE_CLI_VERSION)

export const getClaudeCliVersion = () => resolvedClaudeCliVersion

export const buildClaudeCliUserAgent = (version = getClaudeCliVersion()) => `claude-cli/${version} (external, cli)`

export const extractClaudeCliVersionFromUserAgent = (userAgent) => {
  if (typeof userAgent !== 'string' || !userAgent.trim()) {
    return ''
  }
  const match = userAgent.match(/claude-cli\/(\d+\.\d+\.\d+)\b/i)
  return match ? match[1] : ''
}
