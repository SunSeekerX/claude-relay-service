import crypto from 'node:crypto'

import { config } from '../../../config/config.js'
import { redis } from '../../infra/redis.js'
import { RedisKeys, TTL, LIMITS } from '../../infra/redis_key.js'
import { RedisLua } from '../../infra/redis_lua.js'
import { badRequest, forbidden, conflict, tooManyRequests } from '../../common/http_result.js'

const hashKey = (value) => crypto.createHash('sha256').update(value).digest('hex')
const secretFor = (keyId, oldHash, requestId) =>
  config.security.apiKeyPrefix +
  crypto
    .createHmac('sha256', config.security.encryptionKey)
    .update(`key-rotation\0${keyId}\0${oldHash}\0${requestId}`)
    .digest('hex')
const snapshot = (keyId, data, action, actor) => ({
  id: crypto.randomUUID(),
  keyId,
  keyName: data.name ?? '',
  ownerId: data.userId ?? '',
  ownerName: data.userUsername ?? '',
  oldHash: data.apiKey,
  newHash: '',
  oldKeySuffix: data.keySuffix ?? '',
  newKeySuffix: '',
  action,
  actorKind: actor.kind,
  actorId: actor.id ?? '',
  actorName: actor.name ?? '',
  ip: actor.ip ?? '',
  keyCreatedAt: data.createdAt ?? '',
  eventTime: new Date().toISOString(),
})

export const appendCredentialSnapshot = (multi, keyId, data, action, actor) => {
  const event = snapshot(keyId, data, action, actor)
  multi.eval(
    RedisLua.apiKeyHistorySnapshot,
    5,
    RedisKeys.apiKey.byId(keyId),
    RedisKeys.apiKeyHistory.event(event.id),
    RedisKeys.apiKeyHistory.byKey(keyId),
    RedisKeys.apiKeyHistory.all,
    RedisKeys.apiKey.hashMap,
    JSON.stringify(event),
    Date.parse(event.eventTime),
    RedisKeys.apiKeyHistory.hashPrefix,
    RedisKeys.apiKey.hashLegacy(''),
  )
}

export const rotateCredential = async ({ keyId, apiKey, requestId, actor }) => {
  if (
    typeof requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
  ) {
    throw badRequest('requestId 必须为随机 UUID')
  }
  if (actor.kind === 'key' && (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 512)) {
    throw badRequest('请输入完整 API Key')
  }
  const client = redis.getClientSafe()
  if (actor.kind === 'key') {
    const attempts = await client.eval(
      RedisLua.apiKeyRotationRate,
      1,
      RedisKeys.apiKeyHistory.rate(actor.ip),
      TTL.apiKeyRotationRate,
    )
    if (Number(attempts) > LIMITS.apiKeyRotationAttempts) {
      throw tooManyRequests('请求过于频繁,请稍后重试')
    }
  }
  const suppliedHash = actor.kind === 'key' ? hashKey(apiKey) : null
  const restore = async (event) => {
    if (
      event.actorKind !== actor.kind ||
      event.actorId !== (actor.id ?? '') ||
      (actor.kind === 'key' ? event.oldHash !== suppliedHash : event.keyId !== keyId)
    ) {
      throw conflict('更换请求不匹配')
    }
    const current = await redis.getApiKey(event.keyId)
    if (!current?.id || current.isDeleted === 'true' || current.apiKey !== event.newHash) {
      throw conflict('Key 已再次更换或删除,请联系管理员')
    }
    if (actor.kind === 'user' && current.userId !== actor.id) {
      throw forbidden('无权操作此 Key')
    }
    if (actor.kind === 'key' && current.userId) {
      throw forbidden('请登录所属账号管理此 Key')
    }
    const key = secretFor(event.keyId, event.oldHash, requestId)
    if (hashKey(key) !== current.apiKey) {
      throw conflict('恢复凭据已变化,请联系管理员')
    }
    return { id: event.keyId, name: current.name, key }
  }
  const saved = await client.get(RedisKeys.apiKeyHistory.request(requestId))
  if (saved) {
    return restore(JSON.parse(saved))
  }
  const data = actor.kind === 'key' ? await redis.findApiKeyByHash(suppliedHash) : await redis.getApiKey(keyId)
  if (!data?.id || (suppliedHash && data.apiKey !== suppliedHash)) {
    throw forbidden('Key 不存在或已更换')
  }
  keyId = data.id
  const newKey = secretFor(keyId, data.apiKey, requestId),
    newHash = hashKey(newKey)
  const event = { ...snapshot(keyId, data, 'rotate', actor), newHash, oldKeySuffix: suppliedHash ? apiKey.slice(-4) : data.keySuffix ?? '', newKeySuffix: newKey.slice(-4) }
  const result = await client.eval(
    RedisLua.apiKeyRotation,
    10,
    RedisKeys.apiKey.byId(keyId),
    RedisKeys.apiKey.hashMap,
    RedisKeys.apiKey.hashLegacy(data.apiKey),
    RedisKeys.apiKey.hashLegacy(newHash),
    RedisKeys.apiKeyHistory.byHash(data.apiKey),
    RedisKeys.apiKeyHistory.byHash(newHash),
    RedisKeys.apiKeyHistory.event(event.id),
    RedisKeys.apiKeyHistory.byKey(keyId),
    RedisKeys.apiKeyHistory.all,
    RedisKeys.apiKeyHistory.request(requestId),
    data.apiKey,
    newHash,
    event.eventTime,
    JSON.stringify(event),
    Date.parse(event.eventTime),
    TTL.apiKeyRotationRequest,
  )
  if (result === 'owner') {
    throw forbidden('请登录所属账号管理此 Key')
  }
  if (result === 'disabled') {
    throw forbidden('已禁用 Key 不能自助更换,请联系管理员')
  }
  if (['changed', 'deleted', 'collision'].includes(result)) {
    throw conflict('Key 状态已变更,请刷新后重试')
  }
  return restore(JSON.parse(result))
}

export const queryCredentialHistory = async ({
  apiKey = '',
  keyId = '',
  page = 1,
  pageSize = 20,
  sortOrder = 'desc',
}) => {
  if (typeof apiKey !== 'string' || apiKey.length > 512 || typeof keyId !== 'string' || keyId.length > 100) {
    throw badRequest('查询参数无效')
  }
  page = Number(page)
  pageSize = Number(pageSize)
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > LIMITS.apiKeyHistoryPage
  ) {
    throw badRequest('分页参数无效')
  }
  const client = redis.getClientSafe()
  if (apiKey) {
    const hash = hashKey(apiKey)
    keyId = await client.get(RedisKeys.apiKeyHistory.byHash(hash))
    if (!keyId) {
      keyId = (await redis.findApiKeyByHash(hash))?.id
    }
    if (!keyId) {
      return { rows: [], total: 0, target: null }
    }
  }
  const index = keyId ? RedisKeys.apiKeyHistory.byKey(keyId) : RedisKeys.apiKeyHistory.all
  if (!['asc', 'desc'].includes(sortOrder)) {
    throw badRequest('排序参数无效')
  }
  const [total, ids] = await Promise.all([
    client.zcard(index),
    client[sortOrder === 'asc' ? 'zrange' : 'zrevrange'](index, (page - 1) * pageSize, page * pageSize - 1),
  ])
  const rows = ids.length
    ? (await client.mget(ids.map((id) => RedisKeys.apiKeyHistory.event(id)))).filter(Boolean).map(JSON.parse)
    : []
  let target = null
  if (keyId) {
    const current = await redis.getApiKey(keyId)
    if (current?.id) {
      target = {
        keyId,
        keyName: current.name,
        ownerId: current.userId,
        ownerName: current.userUsername,
        deleted: current.isDeleted === 'true',
      }
    } else {
      const [last] = await client.zrevrange(index, 0, 0)
      if (last) {
        const event = JSON.parse(await client.get(RedisKeys.apiKeyHistory.event(last)))
        target = { keyId, keyName: event.keyName, ownerId: event.ownerId, ownerName: event.ownerName, deleted: true }
      }
    }
  }
  return { rows, total, target }
}

export const queryCustomerCredentialHistory = async ({ keyId, apiKey, userId, ip, page = 1, pageSize = 20, sortOrder = 'desc' }) => {
  const byKey = userId === undefined
  if (byKey && ip) {
    const attempts = await redis.getClientSafe().eval(RedisLua.apiKeyRotationRate, 1, RedisKeys.apiKeyHistory.readRate(ip), TTL.apiKeyHistoryReadRate)
    if (Number(attempts) > LIMITS.apiKeyHistoryReadAttempts) throw tooManyRequests('请求过于频繁,请稍后重试')
  }
  if (!Number.isSafeInteger(Number(page)) || Number(page) < 1 || Number(page) > 100000) throw badRequest('分页参数无效')
  if (byKey && (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 512)) throw badRequest('请输入当前 API Key')
  if (!byKey && (typeof userId !== 'string' || !userId || typeof keyId !== 'string' || !keyId || keyId.length > 100)) throw forbidden('Key 不存在或无权查看')
  const suppliedHash = byKey ? hashKey(apiKey) : null
  const current = byKey ? await redis.findApiKeyByHash(suppliedHash) : await redis.getApiKey(keyId)
  const authorized = (key) => key?.id && key.isDeleted !== 'true' && (byKey
    ? key.apiKey === suppliedHash && !key.userId && key.isActive === 'true'
    : key.userId === userId)
  if (!authorized(current)) throw forbidden('Key 不存在或无权查看')
  const result = await queryCredentialHistory({ keyId: current.id, page, pageSize, sortOrder })
  // 查询期间凭据被换掉、转移或删除时,不再向旧身份返回记录.
  if (!authorized(await redis.getApiKey(current.id))) throw forbidden('Key 不存在或无权查看')
  const masked = (suffix) => typeof suffix === 'string' && suffix.length === 4 ? `****${suffix}` : ''
  return {
    rows: result.rows.map((row) => ({ id: row.id, action: row.action, actorKind: row.actorKind, oldKeyMasked: masked(row.oldKeySuffix), newKeyMasked: masked(row.newKeySuffix), eventTime: row.eventTime })),
    total: result.total,
  }
}
