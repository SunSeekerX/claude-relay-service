// ===
// Redis Lua 统一注册表 — 单一权威源
// ===
// 约定:
// - 脚本正文逐字保留(含 KEYS/ARGV 约定与注释语义)
// - 调用方只 import RedisLua.xxx 后 eval,禁止在业务文件再内联 Lua
// - 改脚本只动此处;改 KEYS/ARGV 顺序必须同步改所有 eval 调用点
// ===

export const RedisLua = {
  // === 支付 ===
  payment: {
    // 原子状态转移 + 状态二级索引 + pending 索引
    // KEYS[1]=order hash KEYS[2]=statusIdx(expected) KEYS[3]=statusIdx(next) KEYS[4]=pendingIdx
    // ARGV[1]=expected ARGV[2]=next ARGV[3]=updatedAt ARGV[4]=createdScore ARGV[5]=orderId ARGV[6...]=extra pairs
    casStatus: `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'updatedAt', ARGV[3])
for i = 6, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('ZREM', KEYS[2], ARGV[5])
redis.call('ZADD', KEYS[3], tonumber(ARGV[4]), ARGV[5])
if ARGV[1] == 'pending' then
  redis.call('ZREM', KEYS[4], ARGV[5])
end
return 1
`,

    // 累加 + refId 幂等:已 applied 则不重复加,返回当前累计值(credit/refunded 共用)
    addIdempotent: `
if redis.call('SISMEMBER', KEYS[2], ARGV[2]) == 1 then
  return redis.call('GET', KEYS[1]) or '0'
end
redis.call('SADD', KEYS[2], ARGV[2])
local nv = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[3], ARGV[3])
redis.call('LTRIM', KEYS[3], -tonumber(ARGV[4]), -1)
return nv
`,

    // 退款回收(执行时裁剪)
    // KEYS: credit, refunded, baseline, usageCostTotal, applied, tx, reversedAmounts
    reverse: `
if redis.call('SISMEMBER', KEYS[5], ARGV[2]) == 1 then
  return '-1'
end
local credit = tonumber(redis.call('GET', KEYS[1]) or '0')
local refunded = tonumber(redis.call('GET', KEYS[2]) or '0')
local baseline = tonumber(redis.call('GET', KEYS[3]) or '0')
local consumed = tonumber(redis.call('GET', KEYS[4]) or '0')
local used = consumed - baseline
if used < 0 then used = 0 end
local bal = credit - refunded - used
local actual = tonumber(ARGV[1])
if bal < actual then actual = bal end
if actual <= 0 then
  return '0'
end
redis.call('SADD', KEYS[5], ARGV[2])
redis.call('HSET', KEYS[7], ARGV[2], tostring(actual))
redis.call('INCRBYFLOAT', KEYS[2], actual)
redis.call('RPUSH', KEYS[6], ARGV[3])
redis.call('LTRIM', KEYS[6], -tonumber(ARGV[4]), -1)
return tostring(actual)
`,

    // 回滚一次 reverse
    // KEYS: refunded, applied, tx, reversedAmounts; ARGV: refId, tx, txMax
    unreverse: `
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then
  return '0'
end
local amt = tonumber(redis.call('HGET', KEYS[4], ARGV[1]))
if not amt then
  return '-1'
end
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])
redis.call('INCRBYFLOAT', KEYS[1], -amt)
redis.call('RPUSH', KEYS[3], ARGV[2])
redis.call('LTRIM', KEYS[3], -tonumber(ARGV[3]), -1)
return tostring(amt)
`,

    // 候选实例当日额度检查 + 按策略选一 + 以 orderId 记一笔预留
    // KEYS[1..n]=各候选当日额度 hash,KEYS[n+1]=round_robin 计数键
    // ARGV[1]=amount ARGV[2]=strategy ARGV[3]=n ARGV[4]=orderId ARGV[5]=reservedAtMs,其后每候选 3 项
    selectReserve: `
local amount = tonumber(ARGV[1])
local strategy = ARGV[2]
local n = tonumber(ARGV[3])
local orderId = ARGV[4]
local reservedVal = ARGV[1] .. ':' .. ARGV[5]
local eligible = {}
for i = 1, n do
  local base = 5 + (i - 1) * 3
  local dailyLimit = tonumber(ARGV[base + 2])
  local used = 0
  local vals = redis.call('HVALS', KEYS[i])
  for _, v in ipairs(vals) do
    used = used + (tonumber(string.match(v, '^[^:]+')) or 0)
  end
  if dailyLimit <= 0 or used + amount <= dailyLimit then
    eligible[#eligible + 1] = { idx = i, used = used, sort = tonumber(ARGV[base + 3]) }
  end
end
if #eligible == 0 then return '' end
local chosen = eligible[1]
if strategy == 'round_robin' then
  local rr = redis.call('INCR', KEYS[n + 1])
  chosen = eligible[(rr % #eligible) + 1]
else
  for j = 2, #eligible do
    local e = eligible[j]
    if e.used < chosen.used or (e.used == chosen.used and e.sort < chosen.sort) then
      chosen = e
    end
  end
end
redis.call('HSET', KEYS[chosen.idx], orderId, reservedVal)
redis.call('EXPIRE', KEYS[chosen.idx], 259200)
return ARGV[5 + (chosen.idx - 1) * 3 + 1]
`,
  },

  // === 代理绑定 CAS ===
  proxy: {
    // 单账户比较并删除:仅当字段值仍等于目标 id 时才 HDEL
    hashCasDelete:
      "if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('HDEL', KEYS[1], ARGV[1]) else return 0 end",

    // bedrock JSON string:Lua+cjson 原子 compare-and-clear
    stringJsonCasClear: `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, obj = pcall(cjson.decode, raw)
if not ok then return 0 end
if obj[ARGV[1]] == ARGV[2] then
  obj[ARGV[1]] = nil
  redis.call('SET', KEYS[1], cjson.encode(obj))
  return 1
end
return 0
`,
  },

  // === 计费关键写 ===
  cost: {
    // KEYS: dedupKey, costTotal, costRealTotal; ARGV: ratedAmount, realAmount, dedupTtl
    incrementTotal: `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], '1', 'EX', tonumber(ARGV[3]))
redis.call('INCRBYFLOAT', KEYS[2], ARGV[1])
redis.call('INCRBYFLOAT', KEYS[3], ARGV[2])
return 1
`,
  },

  // === 锁 / 用户消息队列 ===
  lock: {
    // 仅当值匹配时删除(token 刷新锁 / 账户锁共用)
    compareAndDel: `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`,

    acquireUserMessage: `
    local lockKey = KEYS[1]
    local lastTimeKey = KEYS[2]
    local requestId = ARGV[1]
    local lockTtl = tonumber(ARGV[2])
    local delayMs = tonumber(ARGV[3])

    -- 检查锁是否空闲
    local currentLock = redis.call('GET', lockKey)
    if currentLock == false then
      -- 检查是否需要延迟
      local lastTime = redis.call('GET', lastTimeKey)
      local now = redis.call('TIME')
      local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)

      if lastTime then
        local elapsed = nowMs - tonumber(lastTime)
        if elapsed < delayMs then
          -- 需要等待的毫秒数
          return {0, delayMs - elapsed}
        end
      end

      -- 获取锁
      redis.call('SET', lockKey, requestId, 'PX', lockTtl)
      return {1, 0}
    end

    -- 锁被占用,返回等待
    return {0, -1}
  `,

    releaseUserMessage: `
    local lockKey = KEYS[1]
    local lastTimeKey = KEYS[2]
    local requestId = ARGV[1]

    -- 验证锁持有者
    local currentLock = redis.call('GET', lockKey)
    if currentLock == requestId then
      -- 记录完成时间
      local now = redis.call('TIME')
      local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
      redis.call('SET', lastTimeKey, nowMs, 'EX', 60) -- 60秒后过期

      -- 删除锁
      redis.call('DEL', lockKey)
      return 1
    end
    return 0
  `,
  },

  // === 并发租约 ZSet ===
  concurrency: {
    incr: `
        local key = KEYS[1]
        local member = ARGV[1]
        local expireAt = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local ttl = tonumber(ARGV[4])

        redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
        redis.call('ZADD', key, expireAt, member)

        if ttl > 0 then
          redis.call('PEXPIRE', key, ttl)
        end

        local count = redis.call('ZCARD', key)
        return count
      `,

    refreshLease: `
        local key = KEYS[1]
        local member = ARGV[1]
        local expireAt = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local ttl = tonumber(ARGV[4])

        redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

        local exists = redis.call('ZSCORE', key, member)

        if exists then
          redis.call('ZADD', key, expireAt, member)
          if ttl > 0 then
            redis.call('PEXPIRE', key, ttl)
          end
          return 1
        end

        return 0
      `,

    decr: `
        local key = KEYS[1]
        local member = ARGV[1]
        local now = tonumber(ARGV[2])

        if member then
          redis.call('ZREM', key, member)
        end

        redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

        local count = redis.call('ZCARD', key)
        if count <= 0 then
          redis.call('DEL', key)
          return 0
        end

        return count
      `,

    get: `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])

        redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
        return redis.call('ZCARD', key)
      `,

    // 返回值:0=正常清理无删除,1=清理后删除空键,-1=遗留键已删除
    cleanupExpiredZset: `
              local key = KEYS[1]
              local now = tonumber(ARGV[1])

              -- 先检查键类型,只对 Sorted Set 执行清理
              local keyType = redis.call('TYPE', key)
              if keyType.ok ~= 'zset' then
                -- 非 ZSET 类型的遗留键,直接删除
                redis.call('DEL', key)
                return -1
              end

              -- 清理过期项
              redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

              -- 获取剩余计数
              local count = redis.call('ZCARD', key)

              -- 如果计数为0,删除键
              if count <= 0 then
                redis.call('DEL', key)
                return 1
              end

              return 0
            `,
  },

  // === 并发排队 ===
  queue: {
    incr: `
      local count = redis.call('INCR', KEYS[1])
      redis.call('EXPIRE', KEYS[1], ARGV[1])
      return count
    `,

    decr: `
      local count = redis.call('DECR', KEYS[1])
      if count <= 0 then
        redis.call('DEL', KEYS[1])
        return 0
      end
      return count
    `,

    incrStats: `
      local count = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
      redis.call('EXPIRE', KEYS[1], ARGV[2])
      return count
    `,

    recordWaitTime: `
      redis.call('LPUSH', KEYS[1], ARGV[1])
      redis.call('LTRIM', KEYS[1], 0, ARGV[2])
      redis.call('EXPIRE', KEYS[1], ARGV[3])
      return 1
    `,
  },

  // === 账户分组 USD 额度 ===
  groupPolicy: {
    // KEYS[1]=hold KEYS[2]=dailyCost KEYS[3]=weeklyCost KEYS[4]=monthlyCost
    // ARGV: dLimit wLimit mLimit epsilon holdTtl day week month dTtl wTtl mTtl
    acquire: `
local holdKey = KEYS[1]
local dCost = KEYS[2]
local wCost = KEYS[3]
local mCost = KEYS[4]
local dLimit = tonumber(ARGV[1]) or 0
local wLimit = tonumber(ARGV[2]) or 0
local mLimit = tonumber(ARGV[3]) or 0
local epsilon = tonumber(ARGV[4]) or 0
local holdTtl = tonumber(ARGV[5]) or 7200
local day = ARGV[6]
local week = ARGV[7]
local month = ARGV[8]
local dTtl = tonumber(ARGV[9]) or 2851200
local wTtl = tonumber(ARGV[10]) or 3456000
local mTtl = tonumber(ARGV[11]) or 6048000

if redis.call('EXISTS', holdKey) == 1 then
  return {0, 'busy'}
end

local function reserved_of(costKey, limit)
  if limit <= 0 then
    return 0
  end
  local used = tonumber(redis.call('GET', costKey) or '0') or 0
  if used + epsilon >= limit then
    return -1
  end
  local remaining = limit - used
  if remaining <= epsilon then
    return -1
  end
  return remaining
end

local dRes = reserved_of(dCost, dLimit)
if dRes < 0 then
  return {0, 'daily'}
end
local wRes = reserved_of(wCost, wLimit)
if wRes < 0 then
  return {0, 'weekly'}
end
local mRes = reserved_of(mCost, mLimit)
if mRes < 0 then
  return {0, 'monthly'}
end

if dRes == 0 and wRes == 0 and mRes == 0 then
  return {1, ''}
end

if dRes > 0 then
  redis.call('INCRBYFLOAT', dCost, dRes)
  redis.call('EXPIRE', dCost, dTtl)
end
if wRes > 0 then
  redis.call('INCRBYFLOAT', wCost, wRes)
  redis.call('EXPIRE', wCost, wTtl)
end
if mRes > 0 then
  redis.call('INCRBYFLOAT', mCost, mRes)
  redis.call('EXPIRE', mCost, mTtl)
end

local payload = string.format('%.8f|%.8f|%.8f|%s|%s|%s', dRes, wRes, mRes, day, week, month)
redis.call('SET', holdKey, payload, 'EX', holdTtl)
return {1, payload}
`,

    // KEYS[1]=hold
    // ARGV: groupId actual epsilon dTtl wTtl mTtl fallbackDay fallbackWeek fallbackMonth costPrefix
    settle: `
local holdKey = KEYS[1]
local groupId = ARGV[1]
local actual = tonumber(ARGV[2]) or 0
local epsilon = tonumber(ARGV[3]) or 0
local dTtl = tonumber(ARGV[4]) or 2851200
local wTtl = tonumber(ARGV[5]) or 3456000
local mTtl = tonumber(ARGV[6]) or 6048000
local day = ARGV[7]
local week = ARGV[8]
local month = ARGV[9]

local dRes, wRes, mRes = 0, 0, 0
local payload = redis.call('GETDEL', holdKey)
if payload then
  local parts = {}
  for part in string.gmatch(payload, '[^|]+') do
    parts[#parts + 1] = part
  end
  dRes = tonumber(parts[1]) or 0
  wRes = tonumber(parts[2]) or 0
  mRes = tonumber(parts[3]) or 0
  if parts[4] then day = parts[4] end
  if parts[5] then week = parts[5] end
  if parts[6] then month = parts[6] end
end

local function apply_axis(axis, reserved, period, ttl)
  local costKey = ARGV[10] .. axis .. ':' .. groupId .. ':' .. period
  local delta
  if reserved > epsilon then
    delta = actual - reserved
  else
    delta = actual
  end
  if delta > epsilon or delta < -epsilon then
    redis.call('INCRBYFLOAT', costKey, delta)
    redis.call('EXPIRE', costKey, ttl)
  end
end

apply_axis('daily', dRes, day, dTtl)
apply_axis('weekly', wRes, week, wTtl)
apply_axis('monthly', mRes, month, mTtl)
return 1
`,

    // KEYS[1]=hold  ARGV: groupId epsilon dTtl wTtl mTtl costPrefix
    release: `
local holdKey = KEYS[1]
local groupId = ARGV[1]
local epsilon = tonumber(ARGV[2]) or 0
local dTtl = tonumber(ARGV[3]) or 2851200
local wTtl = tonumber(ARGV[4]) or 3456000
local mTtl = tonumber(ARGV[5]) or 6048000

local payload = redis.call('GETDEL', holdKey)
if not payload then
  return 0
end

local parts = {}
for part in string.gmatch(payload, '[^|]+') do
  parts[#parts + 1] = part
end
local dRes = tonumber(parts[1]) or 0
local wRes = tonumber(parts[2]) or 0
local mRes = tonumber(parts[3]) or 0
local day = parts[4]
local week = parts[5]
local month = parts[6]
if not day or not week or not month then
  return 0
end

local function refund(axis, reserved, period, ttl)
  if reserved > epsilon then
    local costKey = ARGV[6] .. axis .. ':' .. groupId .. ':' .. period
    redis.call('INCRBYFLOAT', costKey, -reserved)
    redis.call('EXPIRE', costKey, ttl)
  end
end

refund('daily', dRes, day, dTtl)
refund('weekly', wRes, week, wTtl)
refund('monthly', mRes, month, mTtl)
return 1
`,
  },

  // === 账户限流 ===
  account: {
    // KEYS[1]=account hash
    // ARGV[1]=nowIso ARGV[2]=nowMs
    // 仅当 rateLimitStatus=limited 且已过期时清空限流字段;否则不写
    clearExpiredRateLimit: `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'rateLimitStatus') ~= 'limited' then return 0 end
local expired = 0
local resetAt = redis.call('HGET', KEYS[1], 'rateLimitResetAt')
if resetAt and resetAt ~= '' then
  if ARGV[1] >= resetAt then expired = 1 end
else
  local limitedAt = redis.call('HGET', KEYS[1], 'rateLimitedAt')
  if limitedAt and limitedAt ~= '' then
    local y, mo, d, h, mi, sec = string.match(limitedAt, '^(%d+)%-(%d+)%-(%d+)T(%d+):(%d+):(%d+)')
    if y then
      y = tonumber(y)
      mo = tonumber(mo)
      d = tonumber(d)
      h = tonumber(h)
      mi = tonumber(mi)
      sec = tonumber(sec)
      if mo <= 2 then
        y = y - 1
        mo = mo + 9
      else
        mo = mo - 3
      end
      local era = math.floor(y / 400)
      local yoe = y - era * 400
      local doy = math.floor((153 * mo + 2) / 5) + d - 1
      local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
      local limitedMs = (era * 146097 + doe - 719468) * 86400
      limitedMs = (limitedMs + h * 3600 + mi * 60 + sec) * 1000
      local duration = tonumber(redis.call('HGET', KEYS[1], 'rateLimitDuration') or '60') or 60
      if tonumber(ARGV[2]) - limitedMs > duration * 60000 then expired = 1 end
    end
  end
end
if expired ~= 1 then return 0 end
redis.call('HSET', KEYS[1],
  'rateLimitedAt', '',
  'rateLimitStatus', '',
  'rateLimitResetAt', '',
  'status', 'active',
  'schedulable', 'true',
  'errorMessage', '')
return 1
`,
  },
}
