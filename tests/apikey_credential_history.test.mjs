import assert from 'node:assert/strict'
import { test } from 'node:test'
import crypto from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import Redis from 'ioredis'

import { config } from '../config/config.js'
import { redis } from '../src/infra/redis.js'
import { RedisKeys } from '../src/infra/redis_key.js'
import { appendCredentialSnapshot, rotateCredential, queryCredentialHistory, queryCustomerCredentialHistory } from '../src/modules/apikey/apikey_credential_history.js'

test('Key 轮换原子性、权限、恢复、旧值撤销及删除轨迹', { skip: process.env.CRS_KEY_HISTORY_REDIS !== '1' }, async () => {
  const namespace = `fixture_key_history_${Date.now()}:`
  const directory = `.agent_tmp/20261120_key_rotation/backend_${Date.now()}`
  await mkdir(directory, { recursive: true })
  await writeFile(`${directory}/README.md`, '# Key rotation verification\n\n北京时间 2026-11-20。本机 Redis 16380 独立 fixture_key_history 命名空间,不访问业务键、不访问生产。Windows Node --test tests/apikey_credential_history.test.mjs, CRS_KEY_HISTORY_REDIS=1。结果 result.json。\n')
  for (const group of [RedisKeys.apiKeyHistory, RedisKeys.apiKey]) {
    for (const [name, value] of Object.entries(group)) {
      if (typeof value === 'function') group[name] = (...args) => namespace + value(...args)
      else if (typeof value === 'string') group[name] = namespace + value
    }
  }
  const client = new Redis({ host: '127.0.0.1', port: 16380, password: config.redis.password, db: 0, retryStrategy: null, connectTimeout: 5000 })
  await client.ping()
  const originalClient = redis.client
  const originalConnected = redis.isConnected
  redis.client = client
  redis.isConnected = true
  const hash = value => crypto.createHash('sha256').update(value).digest('hex')
  const actor = { kind: 'key', ip: 'fixture' }
  const create = async (id, extra = {}) => {
    const key = `cr_${crypto.randomBytes(32).toString('hex')}`, data = { id, name: '测试 Key', apiKey: hash(key), isActive: 'true', userId: '', totalCostLimit: '100', ...extra }
    const multi = client.multi();multi.hset(RedisKeys.apiKey.byId(id), data);multi.hset(RedisKeys.apiKey.hashMap, hash(key), id);appendCredentialSnapshot(multi, id, data, 'create', { kind: 'admin', id: 'admin' });await multi.exec()
    return key
  }
  try {
    const oldKey = await create('independent'), requestId = crypto.randomUUID()
    const changed = await rotateCredential({ apiKey: oldKey, requestId, actor })
    assert.notEqual(changed.key, oldKey)
    assert.equal(await redis.findApiKeyByHash(hash(oldKey)), null)
    assert.equal((await redis.findApiKeyByHash(hash(changed.key))).id, 'independent')
    assert.equal((await redis.getApiKey('independent')).totalCostLimit, '100')
    assert.equal((await rotateCredential({ apiKey: oldKey, requestId, actor })).key, changed.key)
    await assert.rejects(rotateCredential({ apiKey: oldKey, requestId: crypto.randomUUID(), actor }))
    assert.equal((await queryCredentialHistory({ apiKey: oldKey })).target.keyId, 'independent')
    const customerHistory=await queryCustomerCredentialHistory({apiKey:changed.key})
    assert.equal(customerHistory.rows[0].oldKeyMasked,'****'+oldKey.slice(-4))
    assert.equal(customerHistory.rows[0].newKeyMasked,'****'+changed.key.slice(-4))
    assert.deepEqual(Object.keys(customerHistory.rows[0]).sort(),['id','action','actorKind','oldKeyMasked','newKeyMasked','eventTime'].sort())
    for(const value of [oldKey,changed.key,hash(oldKey),hash(changed.key),requestId]) assert.equal(JSON.stringify(customerHistory).includes(value),false)
    await assert.rejects(queryCustomerCredentialHistory({apiKey:oldKey}))
    await assert.rejects(queryCustomerCredentialHistory({keyId:'independent',userId:'user-1'}))
    assert.equal((await queryCustomerCredentialHistory({apiKey:changed.key,pageSize:1,sortOrder:'asc'})).rows[0].oldKeyMasked,'')
    const admin = { kind: 'admin', id: 'admin', name: '管理员', ip: 'admin' }
    const recovered = await rotateCredential({ keyId: 'independent', requestId: crypto.randomUUID(), actor: admin })
    const adminChangedHistory=await queryCustomerCredentialHistory({apiKey:recovered.key,pageSize:1})
    assert.equal(adminChangedHistory.total,3)
    assert.equal(adminChangedHistory.rows[0].oldKeyMasked,'****'+changed.key.slice(-4))
    await assert.rejects(rotateCredential({ apiKey: oldKey, requestId, actor: { ...actor, ip: 'replay' } }), /再次更换/)
    assert.equal(await redis.findApiKeyByHash(hash(changed.key)), null)
    const stale = client.multi();stale.hset(RedisKeys.apiKey.hashMap, hash(oldKey), 'independent');await stale.exec()
    assert.equal(await redis.findApiKeyByHash(hash(oldKey)), null, 'stale map must not authenticate a rotated credential')
    const owned = await create('owned', { userId: 'user-1', userUsername: '客户甲' })
    await assert.rejects(rotateCredential({ apiKey: owned, requestId: crypto.randomUUID(), actor: { ...actor, ip: 'owned' } }), /登录所属/)
    await assert.rejects(rotateCredential({ keyId: 'owned', requestId: crypto.randomUUID(), actor: { kind: 'user', id: 'user-2' } }), /登录所属/)
    const ownedNew=await rotateCredential({ keyId: 'owned', requestId: crypto.randomUUID(), actor: { kind: 'user', id: 'user-1' } })
    assert.equal((await queryCustomerCredentialHistory({keyId:'owned',userId:'user-1'})).rows[0].newKeyMasked,'****'+ownedNew.key.slice(-4))
    await assert.rejects(queryCustomerCredentialHistory({keyId:'owned',userId:'user-2'}))
    await assert.rejects(queryCustomerCredentialHistory({apiKey:ownedNew.key}))
    const disabled=await create('disabled', { isActive: 'false' })
    await assert.rejects(queryCustomerCredentialHistory({apiKey:disabled}))
    await assert.rejects(rotateCredential({ keyId: 'disabled', requestId: crypto.randomUUID(), actor: { kind: 'user', id: 'user-1' } }), /禁用/)
    const concurrentKey = await create('concurrent')
    const race = await Promise.allSettled([0, 1].map(index => rotateCredential({ apiKey: concurrentKey, requestId: crypto.randomUUID(), actor: { ...actor, ip: `race-${index}` } })))
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
    const data = await redis.getApiKey('independent'), deletion = client.multi()
    deletion.hset(RedisKeys.apiKey.byId('independent'), { isDeleted: 'true', isActive: 'false' })
    appendCredentialSnapshot(deletion, 'independent', data, 'delete', admin)
    deletion.del(RedisKeys.apiKey.byId('independent'));await deletion.exec()
    assert.equal((await queryCredentialHistory({ apiKey: oldKey })).target.deleted, true)
    assert.equal((await queryCredentialHistory({ apiKey: recovered.key })).target.deleted, true)
    assert.equal((await queryCredentialHistory({ apiKey: 'pre-feature-unknown-key' })).target, null)
    const history = await queryCredentialHistory({ apiKey: oldKey })
    assert.equal(JSON.stringify(history).includes(recovered.key), false)
    await assert.rejects(queryCustomerCredentialHistory({apiKey:recovered.key}))
    await assert.rejects(queryCustomerCredentialHistory({keyId:'independent',userId:'user-1'}))
    await writeFile(`${directory}/result.json`, JSON.stringify({ passed: true, namespace, checks: ['customer history redaction allowlist','old-key/foreign-owner/owned-key rejection','masked pagination and missing legacy suffix','rotation/recovery', 'no stale auth', 'ownership', 'disabled key', 'concurrent winner', 'old/new lookup', 'deletion history', 'hash-only storage'] }, null, 2))
    console.log(JSON.stringify({ passed: true, directory }))
  } finally { redis.client = originalClient; redis.isConnected = originalConnected; await client.quit() }
})
