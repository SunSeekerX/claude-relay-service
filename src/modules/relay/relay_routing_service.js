import { redis } from '../../infra/redis.js'
import { badRequest, conflict, forbidden, notFound, HttpError } from '../../common/http_result.js'
import { hasPermission } from '../../common/compat_permissions.js'
import { accountGroupService } from '../account/account_group_service.js'
import { isModelAllowedByGroup } from '../account/account_group_constants.js'
import { collectExclusiveMemberIds, getGroupSchedulingSnapshot } from '../account/account_group_policy.js'
import { getRateLimitModelFamily } from './relay_model_helper.js'
import { isAutoProtectionDisabled, getMappedModelName } from '../../common/common_helper.js'
import { isAccountModelInRange } from '../account/account_model_policy.js'
import { isModelAllowed } from './relay_model_access.js'
import { modelInterfaceSupport } from './relay_model_capabilities.js'
import { modelService } from '../pricing/pricing_model_service.js'
import {
  getAccountModelSnapshot,
  parseModelAccount,
  readModelCatalog,
  accountModelReadiness,
} from '../account/account_model_catalog_service.js'
import {
  isRouteCode,
  normalizeKeyRouting,
  normalizeRouteModelConfig,
  ROUTE_FORMATS,
  ROUTE_PROVIDERS,
  getDefaultRouteFormat,
  LEGACY_MODEL_BASES,
  DEFAULT_MODEL_BASES,
} from './relay_routing_contract.js'

const accountSources = {
  claude: [
    ['', '../account/account_claude_service.js', 'claudeAccountService', 'claude-official'],
    ['console:', '../account/account_claude_console_service.js', 'claudeConsoleAccountService', 'claude-console'],
    ['bedrock:', '../account/account_bedrock_service.js', 'bedrockAccountService', 'bedrock'],
    ['ccr:', '../account/account_ccr_service.js', 'ccrAccountService', 'ccr'],
  ],
  openai: [
    ['', '../account/account_openai_service.js', null, 'openai'],
    [
      'responses:',
      '../account/account_openai_responses_service.js',
      'openaiResponsesAccountService',
      'openai-responses',
    ],
  ],
  gemini: [
    ['', '../account/account_gemini_service.js', null, 'gemini'],
    ['api:', '../account/account_gemini_api_service.js', 'geminiApiAccountService', 'gemini-api'],
  ],
  antigravity: [['', '../account/account_gemini_service.js', null, 'gemini']],
  droid: [['', '../account/account_droid_service.js', 'droidAccountService', 'droid']],
  grok: [['', '../account/account_grok_service.js', 'grokAccountService', 'grok']],
}

const mapRouteBatches = async (items, mapper) => {
  const results = []
  for (let index = 0; index < items.length; index += 8) {
    results.push(...(await Promise.all(items.slice(index, index + 8).map(mapper))))
  }
  return results
}

export const getRouteAccount = async (provider, binding, readOnly = false) => {
  const sources = accountSources[provider]
  const source =
    sources?.find(([prefix]) => prefix && binding.startsWith(prefix)) ?? sources?.find(([prefix]) => !prefix)
  if (!source) {
    return null
  }
  const [prefix, modulePath, exportName, accountType] = source
  const accountId = binding.slice(prefix.length)
  if (!accountId || accountId.includes(':')) {
    return null
  }
  let account
  if (readOnly) {
    account = await getAccountModelSnapshot(accountType, accountId)
  } else {
    const module = await import(modulePath)
    const service = exportName ? module[exportName] : module
    const result = await service.getAccount(accountId)
    account = accountType === 'bedrock' ? result?.data : result
  }
  if (!account?.id) {
    return null
  }
  if (accountType === 'gemini') {
    const accountProvider = account.oauthProvider === 'antigravity' ? 'antigravity' : 'gemini'
    if (accountProvider !== provider) {
      return null
    }
  }
  return { account, accountId, accountType }
}

export const getRouteTarget = async (route, readOnly = false) => {
  if (route.binding.startsWith('group:')) {
    const groupId = route.binding.slice(6)
    const group = await accountGroupService.getGroup(groupId)
    if (!group || group.platform !== route.provider) {
      return null
    }
    return { kind: 'group', group, name: group.name }
  }
  const target = await getRouteAccount(route.provider, route.binding, readOnly)
  return target ? { kind: 'account', ...target, name: route.targetName } : null
}

const getLegacyModelTarget = async (provider, binding, cache) => {
  const cacheKey = `legacy-target:${provider}:${binding ?? 'shared'}`
  if (!cache.has(cacheKey)) {
    cache.set(
      cacheKey,
      (async () => {
        if (!binding) {
          return { kind: 'shared' }
        }
        if (binding.startsWith('group:')) {
          const group = await accountGroupService.getGroup(binding.slice(6))
          const platforms = provider === 'antigravity' ? ['antigravity', 'gemini'] : [provider]
          return group && platforms.includes(group.platform) ? { kind: 'group', group } : null
        }
        for (const [prefix] of accountSources[provider]) {
          const account = await getRouteAccount(provider, binding.includes(':') ? binding : `${prefix}${binding}`, true)
          if (account) {
            return { kind: 'account', ...account }
          }
        }
        return null
      })(),
    )
  }
  return cache.get(cacheKey)
}

export const getRouteTargets = async (provider) => {
  if (!Object.hasOwn(ROUTE_PROVIDERS, provider)) {
    throw badRequest('请选择有效的上游平台')
  }
  const groups = await accountGroupService.getAllGroups(provider)
  const accountLists = await Promise.all(
    accountSources[provider].map(async ([prefix, modulePath, exportName]) => {
      const module = await import(modulePath)
      const service = exportName ? module[exportName] : module
      const result = await service.getAllAccounts()
      const accounts = Array.isArray(result) ? result : (result?.data ?? [])
      return accounts
        .filter((account) => {
          if (provider !== 'gemini' && provider !== 'antigravity') {
            return true
          }
          if (prefix === 'api:') {
            return true
          }
          return (account.oauthProvider === 'antigravity' ? 'antigravity' : 'gemini') === provider
        })
        .map((account) => ({ value: `${prefix}${account.id}`, label: account.name, kind: 'account' }))
    }),
  )
  return [
    ...groups.map((group) => ({ value: `group:${group.id}`, label: group.name, kind: 'group' })),
    ...accountLists.flat(),
  ]
}

const normalizeRoute = (input, code, createdAt) => {
  if (!isRouteCode(code)) {
    throw badRequest('入口标识需以小写字母开头，仅含小写字母、数字和连字符，最多 48 字符')
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) {
    throw badRequest('入口名称不能为空，且不能超过 100 字符')
  }
  if (typeof input.provider !== 'string' || !Object.hasOwn(ROUTE_PROVIDERS, input.provider)) {
    throw badRequest('请选择有效的上游平台')
  }
  const provider = ROUTE_PROVIDERS[input.provider]
  if (typeof input.binding !== 'string' || !input.binding || input.binding.length > 100) {
    throw badRequest('请选择入口绑定的账号或分组')
  }
  if (
    !Array.isArray(input.formats) ||
    input.formats.length === 0 ||
    new Set(input.formats).size !== input.formats.length ||
    input.formats.some((format) => !provider.formats.includes(format))
  ) {
    throw badRequest('请选择该上游平台支持的接口格式')
  }
  if (typeof input.isActive !== 'boolean') {
    throw badRequest('入口启用状态必须为布尔值')
  }
  const targetName = input.targetName ?? ''
  if (typeof targetName !== 'string' || targetName.length > 100) {
    throw badRequest('公开名称不能超过 100 字符')
  }
  if (!input.binding.startsWith('group:') && !targetName.trim()) {
    throw badRequest('单账号入口必须填写公开名称')
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) {
    throw badRequest('入口说明不能超过 500 字符')
  }
  let modelConfig
  try {
    modelConfig = normalizeRouteModelConfig(input)
  } catch (error) {
    throw badRequest(error.message)
  }
  return {
    ...modelConfig,
    code,
    name: input.name.trim(),
    provider: input.provider,
    binding: input.binding,
    targetName: targetName.trim(),
    formats: [...input.formats],
    isActive: input.isActive,
    description: input.description ?? '',
    createdAt,
    updatedAt: new Date().toISOString(),
  }
}

export const saveRoute = async (input, code = null) => {
  const mode = code === null ? 'create' : 'update'
  const routeCode = code ?? input.code
  const previous = mode === 'update' ? await redis.getRelayRoute(routeCode) : null
  if (mode === 'update' && !previous) {
    throw notFound('入口不存在')
  }
  const route = normalizeRoute(input, routeCode, previous?.createdAt ?? new Date().toISOString())
  if (route.tokenizerOverride) {
    const { isKnownTokenizer } = await import('../tokenizer/tokenizer_service.js')
    if (!(await isKnownTokenizer(route.tokenizerOverride))) {
      throw badRequest('请选择受支持的词表覆盖项')
    }
  }
  const target = await getRouteTarget(route)
  if (!target) {
    throw badRequest('绑定目标不存在或不属于所选上游平台')
  }
  if (target.accountType === 'gemini-api' && route.formats.includes('claude-messages')) {
    throw badRequest('Gemini API 账号当前不支持 Claude Messages 转换，请选择 Gemini 原生或 Chat Completions')
  }
  const result = await redis.saveRelayRoute(route, mode)
  if (result === 'exists') {
    throw conflict('入口标识已存在')
  }
  if (result === 'missing') {
    throw notFound('入口不存在')
  }
  if (result === 'full') {
    throw badRequest('入口数量已达到上限')
  }
  return route
}

export const validateKeyRouting = async (input) => {
  let routing
  try {
    routing = normalizeKeyRouting(input)
  } catch (error) {
    throw badRequest(error.message)
  }
  const routes = await Promise.all(routing.allowedRoutes.map((code) => redis.getRelayRoute(code)))
  for (let index = 0; index < routes.length; index++) {
    if (!routes[index]) {
      throw badRequest(`授权入口不存在: ${routing.allowedRoutes[index]}`)
    }
  }
  for (const [format, code] of Object.entries(routing.defaults)) {
    if (!routes.find((route) => route.code === code).formats.includes(format)) {
      throw badRequest('默认入口未开放对应的接口格式')
    }
  }
  return routing
}

export const resolveRequestRoute = async (keyData, format, explicitCode = null) => {
  const routing = normalizeKeyRouting(keyData.relayRouting)
  const code = explicitCode ?? (format ? routing.defaults[format] : null)
  if (!code) {
    return null
  }
  if (!routing.allowedRoutes.includes(code)) {
    throw forbidden('此 Key 未获授权使用该入口')
  }
  const route = await redis.getRelayRoute(code)
  if (!route || !route.isActive) {
    throw new HttpError(503, '调用入口当前不可用')
  }
  if (format && !route.formats.includes(format)) {
    if (explicitCode) {
      throw badRequest('该入口未开放此接口格式')
    }
    throw new HttpError(503, '默认入口未开放此接口格式')
  }
  if (!hasPermission(keyData.permissions, ROUTE_PROVIDERS[route.provider].permission)) {
    throw forbidden('此 Key 未获授权使用该入口的上游服务')
  }
  if (!(await getRouteTarget(route))) {
    throw new HttpError(503, '调用入口绑定目标当前不可用')
  }
  return route
}

export const applyRouteBinding = (keyData, route) => {
  const result = { ...keyData, _relayRoute: route }
  for (const field of [
    'claudeAccountId',
    'claudeConsoleAccountId',
    'bedrockAccountId',
    'geminiAccountId',
    'openaiAccountId',
    'azureOpenaiAccountId',
    'droidAccountId',
    'grokAccountId',
  ]) {
    result[field] = ''
  }
  if (route.provider === 'claude') {
    if (route.binding.startsWith('console:')) {
      result.claudeConsoleAccountId = route.binding.slice(8)
    } else if (route.binding.startsWith('bedrock:')) {
      result.bedrockAccountId = route.binding.slice(8)
    } else {
      result.claudeAccountId = route.binding
    }
  } else if (route.provider === 'openai') {
    result.openaiAccountId = route.binding
  } else if (route.provider === 'gemini' || route.provider === 'antigravity') {
    result.geminiAccountId = route.binding
  } else if (route.provider === 'droid') {
    result.droidAccountId = route.binding
  } else if (route.provider === 'grok') {
    result.grokAccountId = route.binding
  }
  return result
}

export const resolveDefaultModelRoutes = async (keyData, req) => {
  const path = req.path.split('?')[0].replace(/\/+$/, '')
  if (
    req.method !== 'GET' ||
    req.params?.routeCode ||
    !['/v1/models', '/models', '/v1beta/models', '/native/v1/models'].includes(path) ||
    !getDefaultRouteFormat(req, 'models')
  ) {
    return []
  }
  const original = req.originalUrl ?? req.url ?? ''
  const formats = /^\/openai\/(?:gemini|claude|native)(?:\/|$)/.test(original)
    ? ['openai-chat']
    : /\/(?:gemini|v1beta)(?:\/|$)/.test(original)
      ? ['gemini-generate']
      : req.headers['anthropic-version'] || req.headers['anthropic-beta'] || /^\/(?:api|claude)\//.test(original)
        ? ['claude-messages']
        : req.query?.client_version
          ? ['openai-responses']
          : ['openai-chat', 'openai-responses']
  const routing = normalizeKeyRouting(keyData.relayRouting)
  if (!formats.some((format) => routing.defaults[format])) {
    return []
  }
  const routes = []
  for (const format of formats) {
    if (!routing.defaults[format]) {
      routes.push({
        legacyProvider: format === 'claude-messages' ? 'claude' : format === 'gemini-generate' ? 'gemini' : 'openai',
        discoveryFormat: format,
      })
      continue
    }
    const route = await resolveRequestRoute(keyData, format)
    routes.push({ ...route, discoveryFormat: format })
  }
  return routes
}

export const getPublicRoute = async (route, keyData, modelCache = new Map()) => {
  const target = await getRouteTarget(route, true)
  const permitted = hasPermission(keyData.permissions, ROUTE_PROVIDERS[route.provider].permission)
  const modelDetailsByFormat =
    route.isActive && target && permitted
      ? Object.fromEntries(
          await mapRouteBatches(route.formats, async (format) => [
            format,
            await getRouteModelDetails(route, keyData, target, modelCache, format),
          ]),
        )
      : {}
  return {
    code: route.code,
    name: route.name,
    description: route.description,
    providerLabel: ROUTE_PROVIDERS[route.provider].label,
    formats: ROUTE_FORMATS.filter((format) => route.formats.includes(format.value)),
    targetKind: route.binding.startsWith('group:') ? 'group' : 'account',
    targetName: target?.name ?? route.targetName,
    status: !route.isActive ? 'disabled' : !permitted ? 'permission-denied' : !target ? 'target-missing' : 'configured',
    models: [
      ...new Set(
        Object.values(modelDetailsByFormat)
          .flat()
          .map((model) => model.id),
      ),
    ],
    modelsByFormat: Object.fromEntries(
      Object.entries(modelDetailsByFormat).map(([format, models]) => [format, models.map((model) => model.id)]),
    ),
    modelDetailsByFormat,
    modelMode: route.modelMode ?? 'upstream',
    basePath: `/r/${route.code}`,
  }
}

export const getPublicKeyRouting = async (keyData) => {
  const routing = normalizeKeyRouting(keyData.relayRouting)
  const modelCache = new Map()
  const routes = await mapRouteBatches(routing.allowedRoutes, async (code) => {
    const route = await redis.getRelayRoute(code)
    return route
      ? getPublicRoute(route, keyData, modelCache)
      : {
          code,
          name: code,
          status: 'deleted',
          formats: [],
          targetName: '',
          basePath: `/r/${code}`,
        }
  })
  const legacyTargets = []
  const bindings = [
    [
      'claude',
      keyData.claudeAccountId ||
        (keyData.claudeConsoleAccountId ? `console:${keyData.claudeConsoleAccountId}` : null) ||
        (keyData.bedrockAccountId ? `bedrock:${keyData.bedrockAccountId}` : null),
    ],
    ['openai', keyData.openaiAccountId],
    ['gemini', keyData.geminiAccountId],
    ['droid', keyData.droidAccountId],
    ['grok', keyData.grokAccountId],
  ]
  for (const [provider, binding] of bindings) {
    if (!hasPermission(keyData.permissions, ROUTE_PROVIDERS[provider].permission)) {
      continue
    }
    let targetName = binding ? '专属账号' : '共享账号池'
    if (binding?.startsWith('group:')) {
      const group = await accountGroupService.getGroup(binding.slice(6))
      targetName = group?.name ?? '绑定分组不存在'
    }
    const modelsByFormat = {}
    const modelDetailsByFormat = {}
    let targetExists = !binding
    const possibleProviders = provider === 'gemini' ? ['gemini', 'antigravity'] : [provider]
    for (const format of ROUTE_PROVIDERS[provider].formats) {
      const combined = new Map()
      for (const candidateProvider of possibleProviders) {
        const target = await getLegacyModelTarget(candidateProvider, binding, modelCache)
        if (!target) {
          continue
        }
        targetExists = true
        const details = await getRouteModelDetails(
          {
            provider: candidateProvider,
            formats: [format],
            modelMapping: {},
            modelMode: 'upstream',
          },
          keyData,
          target,
          modelCache,
          format,
        )
        for (const detail of details) {
          const previous = combined.get(detail.id)
          if (!previous || detail.availability === 'ready' || previous.availability === 'blocked') {
            combined.set(detail.id, detail)
          }
        }
      }
      modelDetailsByFormat[format] = [...combined.values()]
      modelsByFormat[format] = [...combined.keys()]
    }
    const basePathsByFormat = Object.fromEntries(
      Object.entries(LEGACY_MODEL_BASES[provider]).filter(
        ([format, base]) => !routing.defaults[format] || !getDefaultRouteFormat({ originalUrl: base }, format),
      ),
    )
    legacyTargets.push({
      provider,
      label: ROUTE_PROVIDERS[provider].label,
      targetName,
      targetKind: binding?.startsWith('group:') ? 'group' : binding ? 'account' : 'shared',
      status: targetExists ? 'configured' : 'target-missing',
      modelsByFormat,
      modelDetailsByFormat,
      basePathsByFormat,
      formats: ROUTE_FORMATS.filter((format) => Object.hasOwn(basePathsByFormat, format.value)),
    })
  }
  const defaultModelDetailsByFormat = {}
  const legacyProviders = {
    'claude-messages': 'claude',
    'openai-chat': 'openai',
    'openai-responses': 'openai',
    'gemini-generate': 'gemini',
  }
  for (const { value: format } of ROUTE_FORMATS) {
    const code = routing.defaults[format]
    defaultModelDetailsByFormat[format] = code
      ? (routes.find((route) => route.code === code)?.modelDetailsByFormat?.[format] ?? [])
      : (legacyTargets.find((target) => target.provider === legacyProviders[format])?.modelDetailsByFormat?.[format] ??
        [])
  }
  return {
    defaults: routing.defaults,
    routes,
    legacyTargets,
    defaultModelDetailsByFormat,
    defaultBasePathsByFormat: DEFAULT_MODEL_BASES,
    legacyDefault: Object.keys(routing.defaults).length === 0,
  }
}

export const getRouteModelDetails = async (
  route,
  keyData,
  knownTarget = null,
  modelCache = new Map(),
  format = null,
) => {
  if (format && !route.formats.includes(format)) {
    return []
  }
  const target = knownTarget ?? (await getRouteTarget(route, true))
  const accounts = target?.kind === 'account' ? [target] : []
  if (target?.kind === 'group' || target?.kind === 'shared') {
    const cacheKey = `${route.provider}:${target.group?.id ?? 'shared'}`
    if (!modelCache.has(cacheKey)) {
      modelCache.set(
        cacheKey,
        (async () => {
          if (target.kind === 'shared') {
            const exclusive = await collectExclusiveMemberIds(accountGroupService, route.provider)
            const lists = await mapRouteBatches(accountSources[route.provider], async ([prefix, , , accountType]) => {
              const raw = await redis.getAccountModelStates(accountType)
              return raw
                .map((value) => ({
                  account: parseModelAccount(value, accountType),
                  accountId: value.id,
                  accountType,
                  binding: `${prefix}${value.id}`,
                }))
                .filter(
                  ({ account }) =>
                    (account.accountType === 'shared' ||
                      (['claude-official', 'openai', 'gemini', 'gemini-api', 'grok', 'droid'].includes(accountType) &&
                        !account.accountType)) &&
                    !exclusive.has(account.id) &&
                    (!['gemini', 'antigravity'].includes(route.provider) ||
                      (account.oauthProvider === 'antigravity' ? 'antigravity' : 'gemini') === route.provider),
                )
            })
            return lists.flat()
          }
          const members = await accountGroupService.getGroupMembers(target.group.id)
          return mapRouteBatches(members, async (id) => {
            for (const [prefix] of accountSources[route.provider]) {
              const member = await getRouteAccount(route.provider, `${prefix}${id}`, true)
              if (member) {
                return member
              }
            }
            return null
          })
        })(),
      )
    }
    accounts.push(...(await modelCache.get(cacheKey)).filter(Boolean))
  }
  let modelAllowed = () => true
  let supportsModel = () => true
  if (['claude', 'openai', 'gemini', 'antigravity'].includes(route.provider)) {
    if (route.provider === 'claude') {
      const { unifiedClaudeScheduler } = await import('./relay_unified_claude_scheduler.js')
      supportsModel = ({ account, accountType }, model) =>
        unifiedClaudeScheduler._isModelSupportedByAccount(account, accountType, model)
    } else if (route.provider === 'openai') {
      const { unifiedOpenAIScheduler } = await import('./relay_unified_openai_scheduler.js')
      supportsModel = ({ account, accountType }, model) =>
        unifiedOpenAIScheduler._isOpenAIModelSupported(account, accountType, model)
    } else {
      const { unifiedGeminiScheduler } = await import('./relay_unified_gemini_scheduler.js')
      const requireOauth = format === 'claude-messages' || route.formats.every((value) => value === 'claude-messages')
      supportsModel = ({ account, accountType }, model) =>
        (!requireOauth || accountType !== 'gemini-api') &&
        unifiedGeminiScheduler._isGeminiModelSupported(account, model)
    }
  } else if (route.provider === 'grok') {
    const { grokScheduler } = await import('./relay_grok_scheduler.js')
    supportsModel = ({ account }, model) => grokScheduler._supportsModel(account, model)
  } else if (route.provider === 'droid') {
    const { droidScheduler } = await import('./relay_droid_scheduler.js')
    const endpoint = { 'claude-messages': 'anthropic', 'openai-chat': 'comm', 'openai-responses': 'openai' }[format]
    supportsModel = ({ account }, model) =>
      (!endpoint || droidScheduler._matchesEndpoint(account, endpoint)) &&
      isAccountModelInRange(account.supportedModels, model)
  }
  const providerSupportsModel = supportsModel
  const accountMappedModel = ({ account, accountType }, model) =>
    ['claude-console', 'ccr', 'openai-responses'].includes(accountType) && !Array.isArray(account.supportedModels)
      ? getMappedModelName(account.supportedModels, model)
      : model
  supportsModel = (entry, model) =>
    providerSupportsModel(entry, model) &&
    modelInterfaceSupport(accountMappedModel(entry, model), format) !== 'unsupported' &&
    isModelAllowed(keyData, accountMappedModel(entry, model)) &&
    (!target?.group || isModelAllowedByGroup(target.group, accountMappedModel(entry, model)))
  modelAllowed = (model) => accounts.some((entry) => supportsModel(entry, model))
  const providerPrefix = {
    claude: ['claude-'],
    openai: ['gpt-', 'o1', 'o3', 'o4', 'codex-', 'chatgpt-'],
    gemini: ['gemini-'],
    antigravity: ['gemini-', 'claude-'],
    grok: ['grok', 'composer'],
    droid: [],
  }[route.provider]
  const declaredModels = new Set()
  const accountCatalogs = new Map()
  const namesOf = (value) =>
    Array.isArray(value) ? value : value && typeof value === 'object' ? Object.keys(value) : []
  for (const entry of accounts) {
    const { account, accountType, accountId } = entry
    const catalog = readModelCatalog(account)
    const configured = [account.allowedModels, account.supportedModels, account.modelMapping].flatMap(namesOf)
    if (accountType === 'bedrock') {
      configured.push(
        ...[account.defaultModel, account.smallFastModel].filter((model) => typeof model === 'string' && model),
      )
    }
    const configuredNames = configured.filter((name) => typeof name === 'string' && !name.includes('*'))
    for (const name of [...configuredNames, ...catalog.models]) {
      declaredModels.add(name.replace(/^models\//, ''))
    }
    const cacheKey = `readiness:${accountType}:${accountId}`
    if (!modelCache.has(cacheKey)) {
      modelCache.set(cacheKey, accountModelReadiness(accountType, account))
    }
    accountCatalogs.set(entry, {
      catalog,
      configured,
      readiness: await modelCache.get(cacheKey),
      rangeConfigured: ['openai-responses', 'claude-console', 'ccr'].includes(accountType)
        ? namesOf(account.allowedModels).length > 0
        : configured.length > 0,
    })
  }
  for (const value of [
    target?.group?.modelWhitelist,
    ...accounts.flatMap(({ account }) => [account.allowedModels, account.supportedModels, account.modelMapping]),
  ]) {
    let parsed = value
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value)
      } catch {
        continue
      }
    }
    const names = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.keys(parsed) : []
    for (const name of names) {
      if (typeof name === 'string' && name.trim() && !name.includes('*')) {
        declaredModels.add(['gemini', 'antigravity'].includes(route.provider) ? name.replace(/^models\//, '') : name)
      }
    }
  }
  const knownModels = modelService.getAllModels()
  const knownNames = new Set(knownModels.map((model) => model.id))
  const canAdvertise = (entry, model) => {
    if (!supportsModel(entry, model)) {
      return false
    }
    const data = accountCatalogs.get(entry)
    return (
      data.configured.some((name) => typeof name === 'string' && isAccountModelInRange([name], model)) ||
      data.catalog.models.includes(model) ||
      ((!data.catalog.succeededAt || data.catalog.stale || !data.catalog.complete) &&
        !data.rangeConfigured &&
        knownNames.has(model))
    )
  }
  const candidates = [
    ...knownModels,
    ...[...declaredModels]
      .filter((name) => !knownNames.has(name))
      .map((id) => ({ id, object: 'model', owned_by: route.provider })),
  ]
  const catalog = candidates.filter(
    (model) =>
      (providerPrefix.length === 0 ||
        declaredModels.has(model.id) ||
        providerPrefix.some((prefix) => model.id.toLowerCase().startsWith(prefix))) &&
      (!target?.group || isModelAllowedByGroup(target.group, model.id)) &&
      isModelAllowed(keyData, model.id) &&
      modelAllowed(model.id) &&
      accounts.some((entry) => canAdvertise(entry, model.id)),
  )
  const mapping = route.modelMapping ?? {}
  const aliases = Object.entries(mapping)
    .filter(
      ([alias, model]) =>
        isModelAllowed(keyData, alias) &&
        isModelAllowed(keyData, model) &&
        (!target?.group || isModelAllowedByGroup(target.group, model)) &&
        modelAllowed(model),
    )
    .map(([alias]) => ({ id: alias, object: 'model', owned_by: route.provider }))
  const aliasNames = new Set(aliases.map((model) => model.id))
  const models =
    route.modelMode === 'mapped-only' ? aliases : [...catalog.filter((model) => !aliasNames.has(model.id)), ...aliases]
  let groupState = null
  if (target?.group) {
    const cacheKey = `group-state:${target.group.id}`
    if (!modelCache.has(cacheKey)) {
      modelCache.set(cacheKey, getGroupSchedulingSnapshot(target.group))
    }
    groupState = await modelCache.get(cacheKey)
  }
  return models.map(({ id }) => {
    const upstreamModel = Object.hasOwn(mapping, id) ? mapping[id] : id
    const supported = accounts.filter((entry) =>
      Object.hasOwn(mapping, id) ? supportsModel(entry, upstreamModel) : canAdvertise(entry, upstreamModel),
    )
    const source = supported.some((entry) => accountCatalogs.get(entry).catalog.models.includes(upstreamModel))
      ? 'upstream'
      : Object.hasOwn(mapping, id) ||
          supported.some((entry) =>
            accountCatalogs.get(entry).configured.some((name) => isAccountModelInRange([name], upstreamModel)),
          )
        ? 'configured'
        : 'unconfirmed'
    const states = supported.map((entry) => {
      const family = entry.accountType === 'claude-official' ? getRateLimitModelFamily(upstreamModel) : null
      if (
        family &&
        !isAutoProtectionDisabled(entry.account) &&
        Date.parse(entry.account[`${family}RateLimitEndAt`]) > Date.now()
      ) {
        return { state: 'blocked', reason: '该模型正在限流' }
      }
      const data = accountCatalogs.get(entry)
      const confirmed =
        Object.hasOwn(mapping, id) ||
        data.catalog.models.includes(upstreamModel) ||
        data.configured.some((name) => isAccountModelInRange([name], upstreamModel))
      return data.readiness.state === 'ready' && !confirmed
        ? { state: 'unknown', reason: '有候选账号，模型尚未向上游确认' }
        : data.readiness
    })
    const state = states.find((value) => value.state === 'ready') ??
      states.find((value) => value.state === 'unknown') ?? {
        state: 'blocked',
        reason:
          states.length && states.every((value) => value.reason === states[0].reason)
            ? states[0].reason
            : '暂无可调度账号',
      }
    return {
      id,
      source,
      interfaceSupport: supported.some(
        (entry) =>
          knownNames.has(accountMappedModel(entry, upstreamModel)) &&
          modelInterfaceSupport(accountMappedModel(entry, upstreamModel), format) === 'supported',
      )
        ? 'supported'
        : 'unknown',
      availability: groupState?.state ?? state.state,
      availabilityReason: groupState?.reason ?? state.reason,
    }
  })
}

export const getRouteModels = async (...args) =>
  (await getRouteModelDetails(...args)).map(({ id }) => ({
    id,
    object: 'model',
    owned_by: args[0].provider,
  }))

export const resolveKeyModelTestTarget = async (keyData, format, body, model) => {
  if (body.apiId !== undefined && body.apiId !== keyData.id) {
    throw forbidden('当前完整 Key 与所查询的 Key 不一致，请重新输入并查询后测试')
  }
  if (body.routeCode && body.legacyProvider) {
    throw badRequest('测试只能选择一个入口')
  }
  let base
  let route = null
  if (body.legacyProvider) {
    const provider = body.legacyProvider
    if (!Object.hasOwn(LEGACY_MODEL_BASES, provider) || !Object.hasOwn(LEGACY_MODEL_BASES[provider], format)) {
      throw badRequest('此原有绑定不支持该接口格式')
    }
    if (!hasPermission(keyData.permissions, ROUTE_PROVIDERS[provider].permission)) {
      throw forbidden('此 Key 未开放该服务权限')
    }
    base = LEGACY_MODEL_BASES[provider][format]
    if (
      normalizeKeyRouting(keyData.relayRouting).defaults[format] &&
      getDefaultRouteFormat({ originalUrl: base }, format)
    ) {
      throw forbidden('该协议已设置默认入口，请使用默认入口或已授权的命名入口')
    }
  } else {
    route = await resolveRequestRoute(keyData, format, body.routeCode ?? null)
    base = route ? `/r/${route.code}` : DEFAULT_MODEL_BASES[format]
    const permission = {
      'claude-messages': 'claude',
      'openai-chat': 'openai',
      'openai-responses': 'openai',
      'gemini-generate': 'gemini',
    }[format]
    if (!route && !hasPermission(keyData.permissions, permission)) {
      throw forbidden('此 Key 未开放该服务权限')
    }
  }
  const suffix =
    format === 'gemini-generate'
      ? `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent`
      : ROUTE_FORMATS.find((entry) => entry.value === format).path
  return { route, path: `${base}${suffix}` }
}

export const getAccountSupportedModelDetails = async (type, id) => {
  const accountType = type === 'claude' ? 'claude-official' : type === 'gemini-antigravity' ? 'gemini' : type
  const account = await getAccountModelSnapshot(accountType, id)
  if (!account) {
    throw notFound('账号不存在')
  }
  const provider = Object.keys(accountSources).find(
    (value) =>
      accountSources[value].some(([, , , kind]) => kind === accountType) &&
      (!['gemini', 'antigravity'].includes(value) ||
        (account.oauthProvider === 'antigravity' ? 'antigravity' : 'gemini') === value),
  )
  return getRouteModelDetails(
    { provider, formats: ROUTE_PROVIDERS[provider].formats, modelMapping: {} },
    { permissions: 'all' },
    { kind: 'account', account, accountId: id, accountType },
  )
}

export const getLegacyProviderModelDetails = async (keyData, provider, format = null, modelCache = new Map()) => {
  if (!hasPermission(keyData.permissions, ROUTE_PROVIDERS[provider].permission)) {
    return []
  }
  const binding = {
    claude:
      keyData.claudeAccountId ||
      (keyData.claudeConsoleAccountId ? `console:${keyData.claudeConsoleAccountId}` : null) ||
      (keyData.bedrockAccountId ? `bedrock:${keyData.bedrockAccountId}` : null),
    openai: keyData.openaiAccountId,
    gemini: keyData.geminiAccountId,
    antigravity: keyData.geminiAccountId,
    grok: keyData.grokAccountId,
    droid: keyData.droidAccountId,
  }[provider]
  const target = await getLegacyModelTarget(provider, binding, modelCache)
  if (!target) {
    return []
  }
  return getRouteModelDetails(
    { provider, formats: format ? [format] : ROUTE_PROVIDERS[provider].formats, modelMapping: {} },
    keyData,
    target,
    modelCache,
    format,
  )
}

export const getLegacyProviderModels = async (...args) =>
  (await getLegacyProviderModelDetails(...args)).map(({ id }) => ({
    id,
    object: 'model',
    owned_by: args[1],
  }))
