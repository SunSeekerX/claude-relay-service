import { formatMetaValueForConsole } from './http_access_log.js'
import chalk from 'chalk'

const hiddenKeys = new Set([
  'level',
  'message',
  'timestamp',
  'stack',
  'type',
  'ua',
  'userAgent',
  'referer',
  'splat',
  'ts',
  'time',
  'lvl',
  'msg',
])
const singleLine = (value) => String(value).replace(/[\r\n\t]+/g, ' ')
const identityKeys = ['requestId', 'model', 'accountId', 'routeCode']

export const formatConsoleEntry = (info, { detailed = false } = {}) => {
  const level = String(info.level).toUpperCase()
  const color = info.level === 'error' ? chalk.red : info.level === 'warn' ? chalk.yellow : chalk.cyan
  const prefix = `${chalk.gray(info.timestamp)} ${color(level.padEnd(5))}`
  const metadata = Object.entries(info).filter(([key]) => !hiddenKeys.has(key) && !key.startsWith('_'))
  const expanded = detailed || ['warn', 'error'].includes(info.level)
  const message =
    info.type === 'startup-summary' ? String(info.message) : singleLine(info._coloredMessage ?? info.message)
  let output = `${prefix} ${message}`
  if (expanded) {
    const lines = Array.isArray(info._accessMetaLines)
      ? info._accessMetaLines
      : metadata.map(
          ([key, value]) =>
            `${key}: ${value instanceof Error ? (value.stack ?? value.message) : formatMetaValueForConsole(value)}`,
        )
    for (const line of lines) {
      output += `\n  ${line}`
    }
  } else {
    const identity = { ...info._file, ...info }
    const labels = identityKeys
      .filter((key) => identity[key] !== undefined && identity[key] !== null)
      .map((key) => `${key}=${singleLine(identity[key])}`)
    if (labels.length) {
      output += ` | ${labels.join(' ')}`
    }
  }
  if (info.stack) {
    output += `\n${info.stack}`
  }
  return output
}

export const createStartupProgress = (emit, now = Date.now) => {
  let active = false
  let startedAt = 0
  let stageAt = 0
  let stage = ''
  let heartbeat
  const visibleTypes = new Set(['startup-stage', 'startup-summary'])
  return {
    shouldShow(info) {
      return !active || !['info', 'debug', 'verbose', 'silly'].includes(info.level) || visibleTypes.has(info.type)
    },
    begin() {
      if (active) {
        return
      }
      active = true
      stage = '加载模块'
      startedAt = now()
      stageAt = startedAt
      clearInterval(heartbeat)
      heartbeat = setInterval(() => {
        emit(`启动进行中: ${stage}（${((now() - stageAt) / 1000).toFixed(1)}s）`, {
          type: 'startup-stage',
          stage,
          durationMs: now() - stageAt,
        })
      }, 10000)
      heartbeat.unref()
    },
    stage(label) {
      const elapsed = now() - stageAt
      stage = label
      stageAt = now()
      emit(`${label}${elapsed > 0 ? ` | 上阶段 ${elapsed}ms` : ''}`, {
        type: 'startup-stage',
        stage: label,
        previousDurationMs: elapsed,
      })
    },
    finish() {
      active = false
      clearInterval(heartbeat)
      return now() - startedAt
    },
  }
}
