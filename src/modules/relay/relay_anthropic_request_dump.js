import path from 'node:path'
import { logger } from '../../common/logger.js'
import { getProjectRoot } from '../../common/project_paths.js'
import { safeRotatingAppend } from '../../common/safe_rotating_append.js'
import { env } from '../../../config/env.js'

export const REQUEST_DUMP_ENV = 'ANTHROPIC_DEBUG_REQUEST_DUMP'
export const REQUEST_DUMP_MAX_BYTES_ENV = 'ANTHROPIC_DEBUG_REQUEST_DUMP_MAX_BYTES'
export const REQUEST_DUMP_FILENAME = 'anthropic-requests-dump.jsonl'

const isEnabled = function isEnabled() {
  const raw = env[REQUEST_DUMP_ENV]
  if (!raw) {
    return false
  }
  return raw === '1' || raw.toLowerCase() === 'true'
}

const getMaxBytes = function getMaxBytes() {
  const raw = env[REQUEST_DUMP_MAX_BYTES_ENV]
  if (!raw) {
    return 2 * 1024 * 1024
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 2 * 1024 * 1024
  }
  return parsed
}

const maskSecret = function maskSecret(value) {
  if (value === null || value === undefined) {
    return value
  }
  const str = String(value)
  if (str.length <= 8) {
    return '***'
  }
  return `${str.slice(0, 4)}...${str.slice(-4)}`
}

const sanitizeHeaders = function sanitizeHeaders(headers) {
  const sensitive = new Set([
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'cookie',
    'set-cookie',
    'x-forwarded-for',
    'x-real-ip',
  ])

  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase()
    if (sensitive.has(key)) {
      out[key] = maskSecret(v)
      continue
    }
    out[key] = v
  }
  return out
}

const safeJsonStringify = function safeJsonStringify(payload, maxBytes) {
  let json
  try {
    json = JSON.stringify(payload)
  } catch (e) {
    return JSON.stringify({
      type: 'anthropic_request_dump_error',
      error: 'JSON.stringify_failed',
      message: e?.message || String(e),
    })
  }

  if (Buffer.byteLength(json, 'utf8') <= maxBytes) {
    return json
  }

  const truncated = Buffer.from(json, 'utf8').subarray(0, maxBytes).toString('utf8')
  return JSON.stringify({
    type: 'anthropic_request_dump_truncated',
    maxBytes,
    originalBytes: Buffer.byteLength(json, 'utf8'),
    partialJson: truncated,
  })
}

export const dumpAnthropicMessagesRequest = async function dumpAnthropicMessagesRequest(req, meta = {}) {
  if (!isEnabled()) {
    return
  }

  const maxBytes = getMaxBytes()
  const filename = path.join(getProjectRoot(), REQUEST_DUMP_FILENAME)

  const record = {
    ts: new Date().toISOString(),
    requestId: req?.requestId || null,
    method: req?.method || null,
    url: req?.originalUrl || req?.url || null,
    ip: req?.ip || null,
    meta,
    headers: sanitizeHeaders(req?.headers || {}),
    body: req?.body || null,
  }

  const line = `${safeJsonStringify(record, maxBytes)}\n`

  try {
    await safeRotatingAppend(filename, line)
  } catch (e) {
    logger.warn('Failed to dump Anthropic request', {
      filename,
      requestId: req?.requestId || null,
      error: e?.message || String(e),
    })
  }
}
