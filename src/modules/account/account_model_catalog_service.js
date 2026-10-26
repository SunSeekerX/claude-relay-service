import { createHash } from 'node:crypto'
import axios from 'axios'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redis } from '../../infra/redis.js'
import { LIMITS } from '../../infra/redis_key.js'
import { badRequest, notFound, HttpError } from '../../common/http_result.js'
import { safeParseJson, isActive, isSchedulable, isAutoProtectionDisabled } from '../../common/common_helper.js'
import { logger } from '../../common/logger.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { summarizeErrorForLog } from '../../common/client_error_builder.js'
import { droidRuntime } from '../../../config/droid_runtime.js'
import { parseStoredAccountModels, readMappedAccountModelRange } from '../../common/compat_account_models.js'
import { CODEX_CLI_VERSION, CODEX_ORIGINATOR, CODEX_USER_AGENT } from '../relay/relay_codex_responses_ws.js'
import { normalizeAntigravityModelInput, getAntigravityModelAlias } from '../relay/relay_antigravity_model.js'

export const ACCOUNT_MODEL_TYPES = [
  'claude-official',
  'claude-console',
  'ccr',
  'openai',
  'openai-responses',
  'gemini',
  'gemini-api',
  'bedrock',
  'droid',
  'grok',
]
export const normalizeModelAccountType = (type) =>
  type === 'claude' ? 'claude-official' : ['gemini-antigravity', 'antigravity'].includes(type) ? 'gemini' : type

export const parseModelAccount = (raw, type = null) => {
  if (!raw) {
    return null
  }
  const account = { ...raw }
  if (['claude-console', 'ccr'].includes(type)) {
    account.allowedModels = readMappedAccountModelRange(account)
  }
  for (const field of ['allowedModels', 'supportedModels', 'modelMapping']) {
    if (account[field] !== undefined) {
      account[field] = parseStoredAccountModels(account[field])
    }
  }
  for (const field of [
    'allowedModels',
    'supportedModels',
    'modelMapping',
    'proxy',
    'rateLimitStatus',
    'subscriptionInfo',
  ]) {
    if (typeof account[field] === 'string') {
      account[field] = safeParseJson(account[field], account[field])
    }
  }
  return account
}

export const modelCatalogSignature = (account) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        account.id,
        account.modelIdentityVersion,
        account.apiUrl,
        account.baseApi,
        account.baseUrl,
        account.apiKey,
        account.modelDiscoveryApiKey,
        account.projectId,
        account.tempProjectId,
        account.accountId,
        account.chatgptUserId,
        account.region,
        account.oauthProvider,
        account.authType,
        account.authenticationMethod,
        (typeof account.apiKeys === 'string' ? safeParseJson(account.apiKeys, []) : (account.apiKeys ?? [])).map(
          (entry) => (typeof entry === 'string' ? entry : [entry.id, entry.hash ?? entry.encryptedKey]),
        ),
        account.awsCredentials,
        account.bearerToken,
      ]),
    )
    .digest('hex')

export const readModelCatalog = (account) => {
  const stored =
    typeof account.modelCatalog === 'string' ? safeParseJson(account.modelCatalog, null) : account.modelCatalog
  if (!stored) {
    return { models: [], succeededAt: null, attemptedAt: null, error: '', stale: false, complete: true }
  }
  const stale = Boolean(stored.signature && stored.signature !== modelCatalogSignature(account))
  return {
    models: stale || !Array.isArray(stored.models) ? [] : stored.models,
    succeededAt: stored.succeededAt ?? null,
    attemptedAt: stored.attemptedAt ?? null,
    error: stored.error ?? '',
    stale,
    complete: stored.complete ?? true,
  }
}

export const getAccountModelSnapshot = async (type, id) => {
  const normalized = normalizeModelAccountType(type)
  if (!ACCOUNT_MODEL_TYPES.includes(normalized)) {
    throw badRequest('不支持的账号类型')
  }
  if (typeof id !== 'string' || !id || id.length > 100 || id.includes(':') || id === 'index') {
    throw badRequest('账号标识无效')
  }
  return parseModelAccount(await redis.getAccountModelState(normalized, id), normalized)
}

const supportsSync = (type) => ACCOUNT_MODEL_TYPES.includes(type)

export const getAccountModelCatalog = async (type, id) => {
  const normalized = normalizeModelAccountType(type)
  const account = await getAccountModelSnapshot(normalized, id)
  if (!account) {
    throw notFound('账号不存在')
  }
  const configured = ['openai-responses', 'claude-console', 'ccr'].includes(normalized)
    ? account.allowedModels
    : account.supportedModels
  return {
    ...readModelCatalog(account),
    canSync: supportsSync(normalized),
    configuredModels: Array.isArray(configured)
      ? configured
      : configured && typeof configured === 'object'
        ? Object.keys(configured)
        : [],
    hasDiscoveryKey: normalized === 'droid' && Boolean(account.modelDiscoveryApiKey),
  }
}

const modelIds = (data, gemini = false) => {
  const items = Array.isArray(data) ? data : (data?.data ?? data?.models)
  if (!Array.isArray(items)) {
    throw new Error('模型目录响应格式无效')
  }
  return items
    .filter((item) => item && !item.disabled && item.visibility !== 'hide')
    .filter(
      (item) =>
        !gemini || !item.supportedGenerationMethods || item.supportedGenerationMethods.includes('generateContent'),
    )
    .map((item) => (typeof item === 'string' ? item : (item?.id ?? item?.slug ?? item?.name ?? item?.model)))
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => (gemini ? id.replace(/^models\//, '') : id.trim()))
}

const fetchHttpModels = async (account, type, options) => {
  const { agent, proxyId, contextKey } = proxyResolver.resolveAgent(parseModelAccount(account), type)
  let next = options.url
  const seen = new Set()
  const models = new Set()
  while (next) {
    if (seen.has(next)) {
      throw new Error('模型目录分页游标重复')
    }
    seen.add(next)
    let response
    try {
      response = await axios.get(next, {
        headers: options.headers,
        timeout: 15000,
        proxy: false,
        httpAgent: agent,
        httpsAgent: agent,
        maxContentLength: LIMITS.accountCatalogBytes,
        maxRedirects: 0,
      })
      proxyResolver.report(proxyId, contextKey, null)
    } catch (error) {
      proxyResolver.report(proxyId, contextKey, error)
      throw error
    }
    for (const id of modelIds(response.data, ['gemini-api', 'gemini'].includes(type))) {
      models.add(id)
    }
    if (models.size > LIMITS.accountCatalogModels || seen.size > LIMITS.accountCatalogPages) {
      throw new Error('上游模型目录超过容量限制')
    }
    next = ''
    if (['gemini-api', 'gemini'].includes(type) && response.data.nextPageToken) {
      const url = new URL(options.url)
      url.searchParams.set('pageToken', response.data.nextPageToken)
      next = url.href
    } else if (options.anthropic && response.data.has_more) {
      if (!response.data.last_id) {
        throw new Error('模型目录缺少分页游标')
      }
      const url = new URL(options.url)
      url.searchParams.set('after_id', response.data.last_id)
      next = url.href
    }
  }
  return [...models]
}

const loadUpstreamModels = async (type, id) => {
  if (type === 'openai') {
    const service = await import('./account_openai_service.js')
    let account = await service.getAccount(id)
    if (service.isTokenExpired(account)) {
      if (!account.refreshToken) {
        throw badRequest('账号授权已过期且没有刷新凭据，请重新授权')
      }
      await service.refreshAccountToken(id)
      account = await service.getAccount(id)
    }
    const headers = {
      Authorization: `Bearer ${service.decrypt(account.accessToken)}`,
      originator: CODEX_ORIGINATOR,
      'User-Agent': CODEX_USER_AGENT,
    }
    if (account.accountId) {
      headers['ChatGPT-Account-Id'] = account.accountId
    }
    return fetchHttpModels(account, type, {
      url: `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLI_VERSION}`,
      headers,
    })
  }
  if (type === 'droid') {
    const { droidAccountService } = await import('./account_droid_service.js')
    const { listModels, ProcessTransport } = await import('@factory/droid-sdk/node')
    const account = await droidAccountService.getAccount(id)
    const dedicated = await droidAccountService.getModelDiscoveryApiKey(id)
    const entries = dedicated ? [] : await droidAccountService.getDecryptedApiKeyEntries(id)
    const apiKey = dedicated
      ? dedicated
      : entries.find((entry) => entry.status === undefined || entry.status === 'active')?.key
    if (!apiKey) {
      throw badRequest('请配置此 Droid 账号的模型同步专用 Factory Key；现有 OAuth 调用方式保持不变')
    }
    const parsedAccount = parseModelAccount(account)
    const resolved = proxyResolver.resolveProxyConfigForAccount(parsedAccount, 'droid')
    const proxy = resolved === undefined ? parsedAccount.proxy : resolved
    let proxyUrl
    if (proxy) {
      const value = new URL(`${proxy.type}://${proxy.host}:${proxy.port}`)
      if (proxy.username) {
        value.username = proxy.username
      }
      if (proxy.password) {
        value.password = proxy.password
      }
      proxyUrl = value.href
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crs-droid-models-'))
    const transport = new ProcessTransport({
      droidExecPath: droidRuntime.execPath,
      cwd: directory,
      env: {
        FACTORY_API_KEY: apiKey,
        FACTORY_HOME_OVERRIDE: directory,
        ...(proxyUrl ? { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl } : {}),
      },
    })
    let timer
    try {
      return modelIds(
        await Promise.race([
          (async () => {
            await transport.connect()
            return listModels({ transport })
          })(),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new HttpError(504, 'Droid 模型同步超时')), 30000)
          }),
        ]),
      )
    } finally {
      clearTimeout(timer)
      await transport.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
  if (type === 'bedrock') {
    const { bedrockAccountService } = await import('./account_bedrock_service.js')
    const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } =
      await import('@aws-sdk/client-bedrock')
    const { data: account } = await bedrockAccountService.getAccount(id)
    const { agent, proxyId, contextKey } = proxyResolver.resolveAgent(parseModelAccount(account), 'bedrock')
    const settings = {
      region: account.region,
      maxAttempts: 1,
      requestHandler: {
        requestTimeout: 15000,
        connectionTimeout: 10000,
        ...(agent ? { httpAgent: agent, httpsAgent: agent } : {}),
      },
    }
    if (account.awsCredentials) {
      settings.credentials = account.awsCredentials
    }
    if (account.bearerToken) {
      settings.credentials = {
        accessKeyId: 'BEDROCK_API_KEY_PLACEHOLDER',
        secretAccessKey: 'BEDROCK_API_KEY_PLACEHOLDER',
      }
    }
    const client = new BedrockClient(settings)
    if (account.bearerToken) {
      client.middlewareStack.add(
        (next) => async (args) => {
          for (const header of Object.keys(args.request.headers)) {
            if (header.toLowerCase() === 'authorization') {
              delete args.request.headers[header]
            }
          }
          args.request.headers.authorization = `Bearer ${account.bearerToken}`
          delete args.request.headers['x-amz-date']
          delete args.request.headers['x-amz-security-token']
          return next(args)
        },
        { step: 'finalizeRequest', name: 'modelCatalogBearerAuth', priority: 'low' },
      )
    }
    try {
      const response = await client.send(
        new ListFoundationModelsCommand({ byProvider: 'Anthropic', byOutputModality: 'TEXT' }),
      )
      const models = response.modelSummaries.map((model) => model.modelId)
      let nextToken
      const seenTokens = new Set()
      do {
        if (seenTokens.has(nextToken) || seenTokens.size >= LIMITS.accountCatalogPages) {
          throw new Error('上游模型列表分页无效或超过容量限制')
        }
        seenTokens.add(nextToken)
        const profiles = await client.send(new ListInferenceProfilesCommand({ nextToken, maxResults: 100 }))
        models.push(
          ...profiles.inferenceProfileSummaries
            .filter((profile) => profile.models?.some((model) => model.modelArn?.includes('anthropic')))
            .map((profile) => profile.inferenceProfileId),
        )
        ;({ nextToken } = profiles)
        if (models.length > LIMITS.accountCatalogModels) {
          throw new Error('上游模型目录超过容量限制')
        }
      } while (nextToken)
      proxyResolver.report(proxyId, contextKey, null)
      return models
    } catch (error) {
      proxyResolver.report(proxyId, contextKey, error)
      throw error
    } finally {
      client.destroy()
    }
  }
  if (type === 'gemini') {
    const service = await import('./account_gemini_service.js')
    let account = await service.getAccount(id)
    if (service.isTokenExpired(account)) {
      if (!account.refreshToken) {
        throw badRequest('账号授权已过期且没有刷新凭据，请重新授权')
      }
      await service.refreshAccountToken(id)
      account = await service.getAccount(id)
    }
    if (account.oauthProvider === 'antigravity') {
      const { fetchAvailableModels } = await import('../relay/relay_antigravity_client.js')
      const resolved = proxyResolver.resolveProxyConfigForAccount(account, 'antigravity')
      const response = await fetchAvailableModels({
        accessToken: account.accessToken,
        proxyConfig: resolved === undefined ? account.proxy : resolved,
        timeoutMs: 15000,
      })
      if (!response.models || typeof response.models !== 'object' || Array.isArray(response.models)) {
        throw new Error('上游模型列表格式无效')
      }
      const models = new Set()
      for (const modelId of Object.keys(response.models)) {
        const alias = getAntigravityModelAlias(normalizeAntigravityModelInput(modelId))
        if (!alias) {
          continue
        }
        models.add(alias)
        if (alias.endsWith('-thinking')) {
          models.add(alias.replace(/-thinking$/, ''))
        }
        if (alias.startsWith('gemini-claude-')) {
          models.add(alias.replace(/^gemini-/, ''))
        }
      }
      return [...models]
    }
    const { agent, proxyId, contextKey } = proxyResolver.resolveAgent(account, 'gemini')
    const options = {
      headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' },
      timeout: 15000,
      proxy: false,
      httpAgent: agent,
      httpsAgent: agent,
      maxContentLength: LIMITS.accountCatalogBytes,
      maxRedirects: 0,
    }
    try {
      let project = account.projectId ? account.projectId : account.tempProjectId
      if (!project) {
        const loaded = await axios.post(
          'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
          { metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' }, mode: 'HEALTH_CHECK' },
          options,
        )
        const value = loaded.data.cloudaicompanionProject
        project = typeof value === 'string' ? value : value?.id
      }
      if (!project) {
        throw badRequest('无法确认 Gemini CLI 项目，请先在账号中配置项目 ID')
      }
      const response = await axios.post(
        'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
        { project },
        options,
      )
      if (response.data.error || (response.data.buckets !== undefined && !Array.isArray(response.data.buckets))) {
        throw new Error('上游配额模型列表格式无效')
      }
      const models = (response.data.buckets ?? [])
        .map((bucket) => bucket.modelId)
        .filter((model) => typeof model === 'string' && model.trim())
        .map((model) => model.replace(/^models\//, ''))
      proxyResolver.report(proxyId, contextKey, null)
      return { models, complete: false }
    } catch (error) {
      proxyResolver.report(proxyId, contextKey, error)
      throw error
    }
  }
  const sources = {
    'claude-official': ['./account_claude_service.js', 'claudeAccountService'],
    'claude-console': ['./account_claude_console_service.js', 'claudeConsoleAccountService'],
    ccr: ['./account_ccr_service.js', 'ccrAccountService'],
    'openai-responses': ['./account_openai_responses_service.js', 'openaiResponsesAccountService'],
    'gemini-api': ['./account_gemini_api_service.js', 'geminiApiAccountService'],
    grok: ['./account_grok_service.js', 'grokAccountService'],
  }
  const [modulePath, exportName] = sources[type]
  const module = await import(modulePath)
  const service = module[exportName]
  let account = await service.getAccount(id)
  const expiresAt = Number(account.expiresAt) || Date.parse(account.expiresAt)
  if (type === 'claude-official' && (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60000)) {
    if (!account.refreshToken) {
      throw badRequest('账号授权已过期且没有刷新凭据，请重新授权')
    }
    await service.refreshAccountToken(id)
    account = await service.getAccount(id)
  }
  if (type === 'gemini-api') {
    const { buildGeminiApiUrl } = await import('../relay/relay_gemini_handlers_routes.js')
    return fetchHttpModels(account, type, {
      url: buildGeminiApiUrl(account.baseUrl, null, null, account.apiKey, { listModels: true }),
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const anthropic = ['claude-official', 'claude-console', 'ccr'].includes(type)
  const base =
    type === 'claude-official'
      ? 'https://api.anthropic.com'
      : type === 'openai-responses'
        ? account.baseApi
        : type === 'grok'
          ? account.baseUrl
          : account.apiUrl
  const url = `${String(base)
    .replace(/\/+$/, '')
    .replace(/\/v1\/messages$/, '')
    .replace(/\/v1$/, '')}/v1/models`
  const token =
    type === 'claude-official'
      ? service._decryptSensitiveData(account.accessToken)
      : type === 'grok' && account.authType !== 'apikey'
        ? await service.getDecryptedAccessToken(id)
        : account.apiKey
  const headers =
    type === 'claude-official'
      ? { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' }
      : anthropic
        ? {
            ...(token?.startsWith('sk-ant-') ? { 'x-api-key': token } : { Authorization: `Bearer ${token}` }),
            'anthropic-version': '2023-06-01',
          }
        : { Authorization: `Bearer ${token}` }
  return fetchHttpModels(account, type, { url, headers, anthropic })
}

export const syncAccountModelCatalog = async (type, id) => {
  const normalized = normalizeModelAccountType(type)
  const account = await getAccountModelSnapshot(normalized, id)
  if (!account) {
    throw notFound('账号不存在')
  }
  if (!supportsSync(normalized, account)) {
    throw badRequest('此账号类型暂无模型目录同步接口，请手动配置模型范围')
  }
  const attemptedAt = new Date().toISOString()
  const signature = modelCatalogSignature(account)
  try {
    const discovery = await loadUpstreamModels(normalized, id)
    const models = [...new Set(Array.isArray(discovery) ? discovery : discovery.models)]
    const complete = Array.isArray(discovery) ? true : discovery.complete
    if (models.some((model) => typeof model !== 'string' || !model.trim() || model.length > 200)) {
      throw badRequest('上游返回了无效的模型名称')
    }
    if (models.length > LIMITS.accountCatalogModels) {
      throw new Error('上游模型目录超过容量限制')
    }
    const current = await getAccountModelSnapshot(normalized, id)
    if (!current || signature !== modelCatalogSignature(current)) {
      throw new HttpError(409, '同步期间账号连接配置发生变化，请重新同步')
    }
    if (
      !(await redis.recordAccountModelCatalog(normalized, id, { models, signature, attemptedAt, error: '', complete }))
    ) {
      throw notFound('账号已删除')
    }
    return getAccountModelCatalog(normalized, id)
  } catch (error) {
    logger.error('Account model catalog sync failed', {
      accountType: normalized,
      accountId: id,
      error: summarizeErrorForLog(error),
    })
    const upstreamStatus = error.response?.status ?? error.$metadata?.httpStatusCode
    const message =
      error instanceof HttpError
        ? error.message
        : error.code === 'ENOENT'
          ? 'Droid CLI 尚未安装，请先完成服务的 Droid 运行依赖安装'
          : upstreamStatus
            ? `上游返回 HTTP ${upstreamStatus}`
            : error.code === 'ECONNABORTED'
              ? '同步请求超时'
              : '同步失败，请检查账号连接配置及上游模型列表接口'
    await redis.recordAccountModelCatalog(normalized, id, { attemptedAt, error: message })
    throw new HttpError(error instanceof HttpError ? error.statusCode : 502, message)
  }
}

export const accountModelReadiness = async (type, account) => {
  if (!isActive(account.isActive)) {
    return { state: 'blocked', reason: '账号已停用' }
  }
  if (!isSchedulable(account.schedulable)) {
    return { state: 'blocked', reason: '账号已暂停调度' }
  }
  if (account.subscriptionExpiresAt && Date.parse(account.subscriptionExpiresAt) <= Date.now()) {
    return { state: 'blocked', reason: '账号订阅已到期' }
  }
  if (
    Number(account.dailyQuota) > 0 &&
    account.lastResetDate === redis.getDateStringInTimezone() &&
    Number(account.dailyUsage) >= Number(account.dailyQuota)
  ) {
    return { state: 'blocked', reason: '账号额度不足' }
  }
  const observation = await redis.getAccountModelObservation(type, account)
  if (type === 'droid' && account.authenticationMethod === 'api_key') {
    const keys = typeof account.apiKeys === 'string' ? safeParseJson(account.apiKeys, []) : (account.apiKeys ?? [])
    if (!keys.some((entry) => typeof entry === 'string' || entry.status === undefined || entry.status === 'active')) {
      return { state: 'blocked', reason: '账号暂无可用的上游 Key' }
    }
  }
  if (
    type === 'grok' &&
    Number(account.dailyQuota) > 0 &&
    (await redis.getAccountDailyCost(account.id)) >= Number(account.dailyQuota)
  ) {
    return { state: 'blocked', reason: '账号额度不足' }
  }
  if (Number(account.maxConcurrentTasks) > 0 && observation.concurrency >= Number(account.maxConcurrentTasks)) {
    return { state: 'blocked', reason: '账号并发已满' }
  }
  if (!isAutoProtectionDisabled(account)) {
    if (observation.temporary || observation.overloaded) {
      return { state: 'blocked', reason: '账号暂时不可用' }
    }
    if (['error', 'unauthorized', 'blocked', 'temp_error', 'temp_unavailable'].includes(account.status)) {
      return { state: 'blocked', reason: '账号暂时不可用' }
    }
    const rate = account.rateLimitStatus
    const limited = rate === 'limited' || rate?.status === 'limited' || rate?.isRateLimited === true
    const reset = account.rateLimitResetAt ?? account.rateLimitEndAt ?? rate?.rateLimitResetAt
    if (limited && (!reset || Date.parse(reset) > Date.now())) {
      return { state: 'blocked', reason: '账号正在限流' }
    }
  }
  const oauth =
    ['openai', 'gemini', 'claude-official'].includes(type) ||
    (type === 'grok' && account.authType !== 'apikey') ||
    (type === 'droid' && account.authenticationMethod !== 'api_key')
  if (oauth) {
    if (!account.accessToken && !account.refreshToken) {
      return { state: 'blocked', reason: '账号尚未完成授权' }
    }
    let expiresAt = account.expiresAt ? Number(account.expiresAt) : NaN
    if (Number.isFinite(expiresAt)) {
      expiresAt = expiresAt < 1e11 ? expiresAt * 1000 : expiresAt
    } else {
      expiresAt = Date.parse(account.expiresAt)
    }
    if (!account.accessToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return { state: 'unknown', reason: '账号授权需在实际请求时确认' }
    }
  }
  return { state: 'ready', reason: '本地状态有可调度账号，请求时复检' }
}
