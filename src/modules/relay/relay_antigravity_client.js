import axios from 'axios'
import https from 'node:https'
import { ProxyHelper } from '../proxy/proxy_helper.js'
import { logger } from '../../common/logger.js'
import { cleanJsonSchemaForGemini } from './relay_gemini_schema_cleaner.js'
import { dumpAntigravityUpstreamRequest } from './relay_antigravity_upstream_dump.js'
import {
  mapAntigravityUpstreamModel,
  normalizeAntigravityModelInput,
  getAntigravityModelMetadata,
} from './relay_antigravity_model.js'
import crypto from 'node:crypto'
import { env } from '../../../config/env.js'

const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  timeout: 120000,
  maxSockets: 100,
  maxFreeSockets: 10,
})

export const getAntigravityApiUrl = function getAntigravityApiUrl() {
  return env.ANTIGRAVITY_API_URL || 'https://daily-cloudcode-pa.sandbox.googleapis.com'
}

const normalizeBaseUrl = function normalizeBaseUrl(url) {
  const str = String(url || '').trim()
  return str.endsWith('/') ? str.slice(0, -1) : str
}

export const getAntigravityApiUrlCandidates = function getAntigravityApiUrlCandidates() {
  const configured = normalizeBaseUrl(getAntigravityApiUrl())
  const daily = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
  const prod = 'https://cloudcode-pa.googleapis.com'

  // 若显式配置了自定义 base url，则只使用该地址（不做 fallback，避免意外路由到别的环境）。
  if (env.ANTIGRAVITY_API_URL) {
    return [configured]
  }

  // 默认行为：优先 daily（与旧逻辑一致），失败时再尝试 prod（对齐 CLIProxyAPI）。
  if (configured === normalizeBaseUrl(daily)) {
    return [configured, prod]
  }
  if (configured === normalizeBaseUrl(prod)) {
    return [configured, daily]
  }

  return [configured, prod, daily].filter(Boolean)
}

export const getAntigravityHeaders = function getAntigravityHeaders(accessToken, baseUrl) {
  const resolvedBaseUrl = baseUrl || getAntigravityApiUrl()
  let host = 'daily-cloudcode-pa.sandbox.googleapis.com'
  try {
    host = new URL(resolvedBaseUrl).host || host
  } catch (e) {
    // ignore
  }

  return {
    Host: host,
    'User-Agent': env.ANTIGRAVITY_USER_AGENT || 'antigravity/1.15.8 windows/amd64',
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
    requestType: 'agent',
  }
}

const generateAntigravityProjectId = function generateAntigravityProjectId() {
  return `ag-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

const generateAntigravitySessionId = function generateAntigravitySessionId() {
  return `sess-${crypto.randomUUID()}`
}

const resolveAntigravityProjectId = function resolveAntigravityProjectId(projectId, requestData) {
  const candidate = projectId || requestData?.project || requestData?.projectId || null
  return candidate || generateAntigravityProjectId()
}

const resolveAntigravitySessionId = function resolveAntigravitySessionId(sessionId, requestData) {
  const candidate = sessionId || requestData?.request?.sessionId || requestData?.request?.session_id || null
  return candidate || generateAntigravitySessionId()
}

export const buildAntigravityEnvelope = function buildAntigravityEnvelope({
  requestData,
  projectId,
  sessionId,
  userPromptId,
}) {
  const model = mapAntigravityUpstreamModel(requestData?.model)
  const resolvedProjectId = resolveAntigravityProjectId(projectId, requestData)
  const resolvedSessionId = resolveAntigravitySessionId(sessionId, requestData)
  const requestPayload = {
    ...(requestData?.request || {}),
  }

  if (requestPayload.session_id !== undefined) {
    delete requestPayload.session_id
  }
  requestPayload.sessionId = resolvedSessionId

  const envelope = {
    project: resolvedProjectId,
    requestId: `req-${crypto.randomUUID()}`,
    model,
    userAgent: 'antigravity',
    request: {
      ...requestPayload,
    },
  }

  if (userPromptId) {
    envelope.user_prompt_id = userPromptId
    envelope.userPromptId = userPromptId
  }

  normalizeAntigravityEnvelope(envelope)
  return { model, envelope }
}

const normalizeAntigravityThinking = function normalizeAntigravityThinking(model, requestPayload) {
  if (!requestPayload || typeof requestPayload !== 'object') {
    return
  }

  const { generationConfig } = requestPayload
  if (!generationConfig || typeof generationConfig !== 'object') {
    return
  }
  const { thinkingConfig } = generationConfig
  if (!thinkingConfig || typeof thinkingConfig !== 'object') {
    return
  }

  const normalizedModel = normalizeAntigravityModelInput(model)
  if (thinkingConfig.thinkingLevel && !normalizedModel.startsWith('gemini-3-')) {
    delete thinkingConfig.thinkingLevel
  }

  const metadata = getAntigravityModelMetadata(normalizedModel)
  if (metadata && !metadata.thinking) {
    delete generationConfig.thinkingConfig
    return
  }
  if (!metadata || !metadata.thinking) {
    return
  }

  const budgetRaw = Number(thinkingConfig.thinkingBudget)
  if (!Number.isFinite(budgetRaw)) {
    return
  }
  let budget = Math.trunc(budgetRaw)

  const minBudget = Number.isFinite(metadata.thinking.min) ? metadata.thinking.min : null
  const maxBudget = Number.isFinite(metadata.thinking.max) ? metadata.thinking.max : null

  if (maxBudget !== null && budget > maxBudget) {
    budget = maxBudget
  }

  let effectiveMax = Number.isFinite(generationConfig.maxOutputTokens) ? generationConfig.maxOutputTokens : null
  let setDefaultMax = false
  if (!effectiveMax && metadata.maxCompletionTokens) {
    effectiveMax = metadata.maxCompletionTokens
    setDefaultMax = true
  }

  if (effectiveMax && budget >= effectiveMax) {
    budget = Math.max(0, effectiveMax - 1)
  }

  if (minBudget !== null && budget >= 0 && budget < minBudget) {
    delete generationConfig.thinkingConfig
    return
  }

  thinkingConfig.thinkingBudget = budget
  if (setDefaultMax) {
    generationConfig.maxOutputTokens = effectiveMax
  }
}

const normalizeAntigravityEnvelope = function normalizeAntigravityEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return
  }
  const model = String(envelope.model || '')
  const requestPayload = envelope.request
  if (!requestPayload || typeof requestPayload !== 'object') {
    return
  }

  if (requestPayload.safetySettings !== undefined) {
    delete requestPayload.safetySettings
  }

  // 对齐 CLIProxyAPI：有 tools 时默认启用 VALIDATED（除非显式 NONE）
  if (Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
    const existing = requestPayload?.toolConfig?.functionCallingConfig || null
    if (existing?.mode !== 'NONE') {
      const nextCfg = { ...(existing || {}), mode: 'VALIDATED' }
      requestPayload.toolConfig = { functionCallingConfig: nextCfg }
    }
  }

  // 对齐 CLIProxyAPI：非 Claude 模型移除 maxOutputTokens（Antigravity 环境不稳定）
  normalizeAntigravityThinking(model, requestPayload)
  if (!model.includes('claude')) {
    if (requestPayload.generationConfig && typeof requestPayload.generationConfig === 'object') {
      delete requestPayload.generationConfig.maxOutputTokens
    }
    return
  }

  // Claude 模型：parametersJsonSchema -> parameters + schema 清洗（避免 $schema / additionalProperties 等触发 400）
  if (!Array.isArray(requestPayload.tools)) {
    return
  }

  for (const tool of requestPayload.tools) {
    if (!tool || typeof tool !== 'object') {
      continue
    }
    const decls = Array.isArray(tool.functionDeclarations)
      ? tool.functionDeclarations
      : Array.isArray(tool.function_declarations)
        ? tool.function_declarations
        : null

    if (!decls) {
      continue
    }

    for (const decl of decls) {
      if (!decl || typeof decl !== 'object') {
        continue
      }
      let schema = decl.parametersJsonSchema !== undefined ? decl.parametersJsonSchema : decl.parameters
      if (typeof schema === 'string' && schema) {
        try {
          schema = JSON.parse(schema)
        } catch (_) {
          schema = null
        }
      }

      decl.parameters = cleanJsonSchemaForGemini(schema)
      delete decl.parametersJsonSchema
    }
  }
}

export const request = async function request({
  accessToken,
  proxyConfig = null,
  requestData,
  projectId = null,
  sessionId = null,
  userPromptId = null,
  stream = false,
  signal = null,
  params = null,
  timeoutMs = null,
}) {
  const { model, envelope } = buildAntigravityEnvelope({
    requestData,
    projectId,
    sessionId,
    userPromptId,
  })

  const proxyAgent = ProxyHelper.createProxyAgent(proxyConfig)
  let endpoints = getAntigravityApiUrlCandidates()

  // Claude 模型在 sandbox(daily) 环境下对 tool_use/tool_result 的兼容性不稳定，优先走 prod。
  // 保持可配置优先：若用户显式设置了 ANTIGRAVITY_API_URL，则不改变顺序。
  if (!env.ANTIGRAVITY_API_URL && String(model).includes('claude')) {
    const prodHost = 'cloudcode-pa.googleapis.com'
    const dailyHost = 'daily-cloudcode-pa.sandbox.googleapis.com'
    const ordered = []
    for (const u of endpoints) {
      if (String(u).includes(prodHost)) {
        ordered.push(u)
      }
    }
    for (const u of endpoints) {
      if (!String(u).includes(prodHost)) {
        ordered.push(u)
      }
    }
    // 去重并保持 prod -> daily 的稳定顺序
    endpoints = Array.from(new Set(ordered)).sort((a, b) => {
      const av = String(a)
      const bv = String(b)
      const aScore = av.includes(prodHost) ? 0 : av.includes(dailyHost) ? 1 : 2
      const bScore = bv.includes(prodHost) ? 0 : bv.includes(dailyHost) ? 1 : 2
      return aScore - bScore
    })
  }

  const isRetryable = (error) => {
    // 处理网络层面的连接重置或超时（常见于长请求被中间节点切断）
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return true
    }

    const status = error?.response?.status
    if (status === 429) {
      return true
    }

    // 400/404 的 “model unavailable / not found” 在不同环境间可能表现不同，允许 fallback。
    if (status === 400 || status === 404) {
      const data = error?.response?.data
      const safeToString = (value) => {
        if (typeof value === 'string') {
          return value
        }
        if (value === null || value === undefined) {
          return ''
        }
        // axios responseType=stream 时，data 可能是 stream（存在循环引用），不能 JSON.stringify
        if (typeof value === 'object' && typeof value.pipe === 'function') {
          return ''
        }
        if (Buffer.isBuffer(value)) {
          try {
            return value.toString('utf8')
          } catch (_) {
            return ''
          }
        }
        if (typeof value === 'object') {
          try {
            return JSON.stringify(value)
          } catch (_) {
            return ''
          }
        }
        return String(value)
      }

      const text = safeToString(data)
      const msg = (text || '').toLowerCase()
      return (
        msg.includes('requested model is currently unavailable') ||
        msg.includes('tool_use') ||
        msg.includes('tool_result') ||
        msg.includes('requested entity was not found') ||
        msg.includes('not found')
      )
    }

    return false
  }

  let lastError = null
  let retriedAfterDelay = false

  const attemptRequest = async () => {
    for (let index = 0; index < endpoints.length; index += 1) {
      const baseUrl = endpoints[index]
      const url = `${baseUrl}/v1internal:${stream ? 'streamGenerateContent' : 'generateContent'}`

      const axiosConfig = {
        url,
        method: 'POST',
        ...(params ? { params } : {}),
        headers: getAntigravityHeaders(accessToken, baseUrl),
        data: envelope,
        timeout: stream ? 0 : timeoutMs || 600000,
        ...(stream ? { responseType: 'stream' } : {}),
      }

      if (proxyAgent) {
        axiosConfig.httpsAgent = proxyAgent
        axiosConfig.proxy = false
        if (index === 0) {
          logger.info(
            `🌐 Using proxy for Antigravity ${stream ? 'streamGenerateContent' : 'generateContent'}: ${ProxyHelper.getProxyDescription(proxyConfig)}`,
          )
        }
      } else {
        axiosConfig.httpsAgent = keepAliveAgent
      }

      if (signal) {
        axiosConfig.signal = signal
      }

      try {
        dumpAntigravityUpstreamRequest({
          requestId: envelope.requestId,
          model,
          stream,
          url,
          baseUrl,
          params: axiosConfig.params || null,
          headers: axiosConfig.headers,
          envelope,
        }).catch(() => {})
        const response = await axios(axiosConfig)
        return { model, response }
      } catch (error) {
        lastError = error
        const status = error?.response?.status || null

        const hasNext = index + 1 < endpoints.length
        if (hasNext && isRetryable(error)) {
          logger.warn('⚠️ Antigravity upstream error, retrying with fallback baseUrl', {
            status,
            from: baseUrl,
            to: endpoints[index + 1],
            model,
          })
          continue
        }
        throw error
      }
    }

    throw lastError || new Error('Antigravity request failed')
  }

  try {
    return await attemptRequest()
  } catch (error) {
    // 如果是 429 RESOURCE_EXHAUSTED 且尚未重试过，等待 2 秒后重试一次
    const status = error?.response?.status
    if (status === 429 && !retriedAfterDelay && !signal?.aborted) {
      const data = error?.response?.data

      // 安全地将 data 转为字符串，避免 stream 对象导致循环引用崩溃
      const safeDataToString = (value) => {
        if (typeof value === 'string') {
          return value
        }
        if (value === null || value === undefined) {
          return ''
        }
        // stream 对象存在循环引用，不能 JSON.stringify
        if (typeof value === 'object' && typeof value.pipe === 'function') {
          return ''
        }
        if (Buffer.isBuffer(value)) {
          try {
            return value.toString('utf8')
          } catch (_) {
            return ''
          }
        }
        if (typeof value === 'object') {
          try {
            return JSON.stringify(value)
          } catch (_) {
            return ''
          }
        }
        return String(value)
      }

      const msg = safeDataToString(data)
      if (msg.toLowerCase().includes('resource_exhausted') || msg.toLowerCase().includes('no capacity')) {
        // 递归重试读闭包变量；赋值后本帧不再读，eslint 会误报 no-useless-assignment
        // eslint-disable-next-line no-useless-assignment -- recursive attemptRequest reads this flag
        retriedAfterDelay = true
        logger.warn('⏳ Antigravity 429 RESOURCE_EXHAUSTED, waiting 2s before retry', { model })
        await new Promise((resolve) => setTimeout(resolve, 2000))
        return await attemptRequest()
      }
    }
    throw error
  }
}

export const fetchAvailableModels = async function fetchAvailableModels({
  accessToken,
  proxyConfig = null,
  timeoutMs = 30000,
}) {
  const proxyAgent = ProxyHelper.createProxyAgent(proxyConfig)
  const endpoints = getAntigravityApiUrlCandidates()

  let lastError = null
  for (let index = 0; index < endpoints.length; index += 1) {
    const baseUrl = endpoints[index]
    const url = `${baseUrl}/v1internal:fetchAvailableModels`

    const axiosConfig = {
      url,
      method: 'POST',
      headers: getAntigravityHeaders(accessToken, baseUrl),
      data: {},
      timeout: timeoutMs,
    }

    if (proxyAgent) {
      axiosConfig.httpsAgent = proxyAgent
      axiosConfig.proxy = false
      if (index === 0) {
        logger.info(
          `🌐 Using proxy for Antigravity fetchAvailableModels: ${ProxyHelper.getProxyDescription(proxyConfig)}`,
        )
      }
    } else {
      axiosConfig.httpsAgent = keepAliveAgent
    }

    try {
      const response = await axios(axiosConfig)
      return response.data
    } catch (error) {
      lastError = error
      const status = error?.response?.status
      const hasNext = index + 1 < endpoints.length
      if (hasNext && (status === 429 || status === 404)) {
        continue
      }
      throw error
    }
  }

  throw lastError || new Error('Antigravity fetchAvailableModels failed')
}

export const countTokens = async function countTokens({
  accessToken,
  proxyConfig = null,
  contents,
  model,
  timeoutMs = 30000,
}) {
  const upstreamModel = mapAntigravityUpstreamModel(model)

  const proxyAgent = ProxyHelper.createProxyAgent(proxyConfig)
  const endpoints = getAntigravityApiUrlCandidates()

  let lastError = null
  for (let index = 0; index < endpoints.length; index += 1) {
    const baseUrl = endpoints[index]
    const url = `${baseUrl}/v1internal:countTokens`
    const axiosConfig = {
      url,
      method: 'POST',
      headers: getAntigravityHeaders(accessToken, baseUrl),
      data: {
        request: {
          model: `models/${upstreamModel}`,
          contents,
        },
      },
      timeout: timeoutMs,
    }

    if (proxyAgent) {
      axiosConfig.httpsAgent = proxyAgent
      axiosConfig.proxy = false
      if (index === 0) {
        logger.info(`🌐 Using proxy for Antigravity countTokens: ${ProxyHelper.getProxyDescription(proxyConfig)}`)
      }
    } else {
      axiosConfig.httpsAgent = keepAliveAgent
    }

    try {
      const response = await axios(axiosConfig)
      return response.data
    } catch (error) {
      lastError = error
      const status = error?.response?.status
      const hasNext = index + 1 < endpoints.length
      if (hasNext && (status === 429 || status === 404)) {
        continue
      }
      throw error
    }
  }

  throw lastError || new Error('Antigravity countTokens failed')
}
