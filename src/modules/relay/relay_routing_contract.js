import { LIMITS } from '../../infra/redis_key.js'

export const ROUTE_FORMATS = [
  { value: 'claude-messages', label: 'Claude Messages', path: '/v1/messages' },
  { value: 'openai-chat', label: 'OpenAI Chat Completions', path: '/v1/chat/completions' },
  { value: 'openai-responses', label: 'OpenAI Responses', path: '/v1/responses' },
  { value: 'gemini-generate', label: 'Gemini generateContent', path: '/v1beta/models' },
]

export const ROUTE_PROVIDERS = {
  claude: { label: 'Claude', permission: 'claude', formats: ['claude-messages', 'openai-chat'] },
  openai: {
    label: 'OpenAI / Codex',
    permission: 'openai',
    formats: ['claude-messages', 'openai-chat', 'openai-responses'],
  },
  gemini: {
    label: 'Gemini',
    permission: 'gemini',
    formats: ['claude-messages', 'openai-chat', 'gemini-generate'],
  },
  antigravity: {
    label: 'Antigravity',
    permission: 'gemini',
    formats: ['claude-messages', 'openai-chat', 'gemini-generate'],
  },
  droid: {
    label: 'Droid',
    permission: 'droid',
    formats: ['claude-messages', 'openai-chat', 'openai-responses'],
  },
  grok: {
    label: 'Grok',
    permission: 'grok',
    formats: ['claude-messages', 'openai-chat', 'openai-responses'],
  },
}

export const LEGACY_MODEL_BASES = {
  claude: { 'claude-messages': '/api', 'openai-chat': '/openai/claude' },
  openai: { 'openai-chat': '/openai/native', 'openai-responses': '/openai' },
  gemini: { 'openai-chat': '/openai/gemini', 'gemini-generate': '/gemini' },
  droid: { 'claude-messages': '/droid/claude', 'openai-chat': '/droid/comm', 'openai-responses': '/droid/openai' },
  grok: { 'claude-messages': '/grok', 'openai-chat': '/grok', 'openai-responses': '/grok' },
}

export const DEFAULT_MODEL_BASES = {
  'claude-messages': '/api',
  'openai-chat': '/openai/native',
  'openai-responses': '/openai',
  'gemini-generate': '/gemini',
}

export const isRouteCode = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value)

export const normalizeRouteModelConfig = (input) => {
  const tokenizerOverride = input.tokenizerOverride ?? ''
  if (
    typeof tokenizerOverride !== 'string' ||
    (tokenizerOverride && !/^[a-z][a-z0-9_-]{0,63}$/.test(tokenizerOverride))
  ) {
    throw new Error('词表覆盖标识无效')
  }
  const modelMapping = input.modelMapping ?? {}
  if (!modelMapping || typeof modelMapping !== 'object' || Array.isArray(modelMapping)) {
    throw new Error('模型映射必须是别名到实际模型的对象')
  }
  if (Object.keys(modelMapping).length > 200) {
    throw new Error('模型映射最多 200 项')
  }
  const mapping = Object.create(null)
  for (const [alias, model] of Object.entries(modelMapping)) {
    if (
      !alias.trim() ||
      alias !== alias.trim() ||
      alias.length > 200 ||
      typeof model !== 'string' ||
      !model.trim() ||
      model.length > 200
    ) {
      throw new Error('模型别名和目标模型必须是非空字符串，且不能超过 200 字符')
    }
    if (['__proto__', 'prototype', 'constructor'].includes(alias)) {
      throw new Error('模型别名包含保留名称')
    }
    mapping[alias] = model.trim()
  }
  const modelMode = input.modelMode ?? 'upstream'
  if (!['upstream', 'mapped-only'].includes(modelMode)) {
    throw new Error('请选择有效的模型开放方式')
  }
  const echoModel = input.echoModel ?? 'requested'
  if (!['requested', 'upstream'].includes(echoModel)) {
    throw new Error('请选择有效的模型回显方式')
  }
  const converterOptions = input.converterOptions ?? {}
  if (!converterOptions || typeof converterOptions !== 'object' || Array.isArray(converterOptions)) {
    throw new Error('转换配置必须按接口格式设置')
  }
  for (const [format, options] of Object.entries(converterOptions)) {
    if (format !== 'claude-messages' || input.provider !== 'openai' || !input.formats.includes(format)) {
      throw new Error('此入口没有可配置的该方向转换器')
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('转换器参数必须是对象')
    }
    for (const [key, value] of Object.entries(options)) {
      if (key !== 'parallelToolCalls' || typeof value !== 'boolean') {
        throw new Error('不支持的转换参数或参数值')
      }
    }
  }
  return { modelMapping: mapping, modelMode, echoModel, converterOptions, tokenizerOverride }
}

export const normalizeKeyRouting = (value) => {
  if (value === undefined || value === null || value === '') {
    return { allowedRoutes: [], defaults: {} }
  }
  const input = typeof value === 'string' ? JSON.parse(value) : value
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('入口授权必须是对象')
  }
  const { allowedRoutes, defaults } = input
  if (
    !Array.isArray(allowedRoutes) ||
    allowedRoutes.length > LIMITS.relayRoutes ||
    allowedRoutes.some((code) => !isRouteCode(code)) ||
    new Set(allowedRoutes).size !== allowedRoutes.length
  ) {
    throw new Error('入口授权必须是不重复的有效入口标识列表')
  }
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error('默认入口必须按接口格式设置')
  }
  for (const [format, code] of Object.entries(defaults)) {
    if (!ROUTE_FORMATS.some((item) => item.value === format) || !allowedRoutes.includes(code)) {
      throw new Error('默认入口必须属于已授权入口，且使用有效的接口格式')
    }
  }
  return { allowedRoutes: [...allowedRoutes], defaults: { ...defaults } }
}

export const getRequestRouteFormat = (req) => {
  const path = (req.path ?? req.url ?? '').split('?')[0].replace(/\/+$/, '')
  if (/\/messages(?:\/count_tokens)?$/.test(path)) {
    return 'claude-messages'
  }
  if (/\/chat\/completions$/.test(path)) {
    return 'openai-chat'
  }
  if (/\/responses(?:\/compact)?$/.test(path)) {
    return 'openai-responses'
  }
  if (
    /\/(?:models\/[^/]+:(?:generateContent|streamGenerateContent|countTokens)|v1internal:(?:generateContent|streamGenerateContent|countTokens))$/.test(
      path,
    )
  ) {
    return 'gemini-generate'
  }
  return null
}

export const getDefaultRouteFormat = (req, format) => {
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0]
  return /^\/(?:grok|droid|antigravity|gemini-cli)(?:\/|$)/.test(path) ? null : format
}
