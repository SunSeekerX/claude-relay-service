// cache_control 官方透传策略
// - 1P Claude / Console：保留 ttl / scope
// - Bedrock 等不支持字段的上游：仅 type 净化（由上游适配层调用）
// - 断点数量：默认不硬裁；可配置软上限

export const CACHE_CONTROL_SOFT_LIMIT = 100

export const sanitizeCacheControlForBedrock = (node) => {
  if (!node || typeof node !== 'object') {
    return node
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      sanitizeCacheControlForBedrock(item)
    }
    return node
  }
  if (node.cache_control && typeof node.cache_control === 'object') {
    node.cache_control = { type: node.cache_control.type || 'ephemeral' }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      sanitizeCacheControlForBedrock(value)
    }
  }
  return node
}

// 统计 cache_control 块数（只读）
export const countCacheControlBlocks = (body) => {
  let total = 0
  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return
    }
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (node.cache_control) {
      total += 1
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        visit(value)
      }
    }
  }
  visit(body)
  return total
}

// 软限制：仅当超过 softLimit 时从最旧 messages 断点开始剥，保留 system/tools 末尾
// 默认 softLimit 很大 = 实质上官方透传；调用方可用环境/配置收紧
export const enforceCacheControlSoftLimit = (body, softLimit = CACHE_CONTROL_SOFT_LIMIT) => {
  if (!body || typeof body !== 'object' || !Number.isFinite(softLimit) || softLimit <= 0) {
    return { removed: 0, total: countCacheControlBlocks(body) }
  }

  const total = countCacheControlBlocks(body)
  if (total <= softLimit) {
    return { removed: 0, total }
  }

  let needRemove = total - softLimit
  let removed = 0

  const stripFromContentArray = (contentArray) => {
    if (!Array.isArray(contentArray) || needRemove <= 0) {
      return
    }
    for (const item of contentArray) {
      if (needRemove <= 0) {
        break
      }
      if (item && item.cache_control) {
        delete item.cache_control
        needRemove -= 1
        removed += 1
      }
    }
  }

  // 优先从较早的 user/assistant 消息剥，保留 system 与 tools 末尾断点
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (needRemove <= 0) {
        break
      }
      if (message && Array.isArray(message.content)) {
        stripFromContentArray(message.content)
      }
    }
  }

  if (needRemove > 0 && Array.isArray(body.system)) {
    stripFromContentArray(body.system)
  }

  if (needRemove > 0 && Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (needRemove <= 0) {
        break
      }
      if (tool && tool.cache_control) {
        delete tool.cache_control
        needRemove -= 1
        removed += 1
      }
    }
  }

  return { removed, total }
}

// 1P 路径：不删 ttl/scope；仅可选软上限
export const prepareCacheControlForOfficialClaude = (body, { softLimit = CACHE_CONTROL_SOFT_LIMIT } = {}) =>
  enforceCacheControlSoftLimit(body, softLimit)
