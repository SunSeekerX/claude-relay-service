// Responses WS 上游会话池（passthrough 复用）
// 第一版：按 accountId 缓存最近一次 upstream 目标元数据，避免重复解析；
// 真正的上游 WSS 长连接复用风险高（单连接多客户端会串话），默认不做连接共享。
// CLIProxyAPI 的 ctx_pool/dedicated 属于进阶；此处提供可扩展钩子。

import { logger } from '../../common/logger.js'

const pool = new Map() // accountId -> { targetUrl, headersTemplate, lastUsedAt, hits }

const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX = 200

export const responsesWsSessionPool = {
  get(accountId) {
    if (!accountId) {
      return null
    }
    const row = pool.get(accountId)
    if (!row) {
      return null
    }
    if (Date.now() - row.lastUsedAt > DEFAULT_TTL_MS) {
      pool.delete(accountId)
      return null
    }
    row.lastUsedAt = Date.now()
    row.hits += 1
    return row
  },

  set(accountId, meta = {}) {
    if (!accountId) {
      return
    }
    if (pool.size >= DEFAULT_MAX && !pool.has(accountId)) {
      // 简单淘汰最旧
      let oldestKey = null
      let oldestAt = Infinity
      for (const [key, value] of pool.entries()) {
        if (value.lastUsedAt < oldestAt) {
          oldestAt = value.lastUsedAt
          oldestKey = key
        }
      }
      if (oldestKey) {
        pool.delete(oldestKey)
      }
    }
    pool.set(accountId, {
      targetUrl: meta.targetUrl || '',
      isChatGptOAuth: Boolean(meta.isChatGptOAuth),
      lastUsedAt: Date.now(),
      hits: 1,
    })
  },

  invalidate(accountId) {
    if (accountId) {
      pool.delete(accountId)
    }
  },

  stats() {
    return { size: pool.size, max: DEFAULT_MAX, ttlMs: DEFAULT_TTL_MS }
  },

  clear() {
    pool.clear()
    logger.debug('[ResponsesWS-pool] cleared')
  },
}
