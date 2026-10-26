import crypto from 'node:crypto'
import { RedisKeys, TTL } from '../../infra/redis_key.js'
import { RedisLua } from '../../infra/redis_lua.js'

// DEC_20261026_194257 关闭自动保护时每账户五分钟五次认证失败聚合告警，十五分钟去重，不暂停调度。
export const recordAuthFailureAlert = async (accountId, accountType) => {
  const { redis } = await import('../../infra/redis.js')
  const client = redis.getClientSafe()
  const notify = await client.eval(
    RedisLua.upstreamAuthAlert,
    2,
    RedisKeys.upstream.authFailureWindow(accountType, accountId),
    RedisKeys.upstream.authFailureCooldown(accountType, accountId),
    Date.now(),
    TTL.upstreamAuthWindow * 1000,
    crypto.randomUUID(),
    5,
    TTL.upstreamAuthWindow,
    TTL.upstreamAuthAlertCooldown
  )
  if (Number(notify) !== 1) {
    return
  }
  const builder = {
    openai: RedisKeys.accounts.openai,
    'openai-responses': RedisKeys.accounts.openaiResponses,
    claude: RedisKeys.accounts.claude,
    'claude-official': RedisKeys.accounts.claude,
    'claude-console': RedisKeys.accounts.claudeConsole,
    ccr: RedisKeys.accounts.ccr,
    gemini: RedisKeys.accounts.gemini,
    'gemini-api': RedisKeys.accounts.geminiApi,
    'azure-openai': RedisKeys.accounts.azureOpenai,
    droid: RedisKeys.accounts.droid
  }[accountType]
  const name = builder ? await client.hget(builder(accountId), 'name') : null
  const { webhookNotifier } = await import('../webhook/webhook_notifier.js')
  await webhookNotifier.sendAccountAnomalyNotification({
    accountId,
    accountName: name ?? accountId,
    platform: accountType,
    status: 'error',
    errorCode: 'UPSTREAM_AUTH_FAILURE_BURST',
    reason: '同一账户五分钟内至少发生五次上游 401；自动保护已关闭，账户仍按原配置调度。请检查上游凭据。',
    timestamp: new Date().toISOString()
  })
}
