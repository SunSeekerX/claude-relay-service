import axios from 'axios'
import { config } from '../../../config/config.js'
import { LIMITS } from '../../infra/redis_key.js'
import { logger } from '../../common/logger.js'
import { timedUpstreamRequest } from '../../common/request_timing.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import { getMappedModelName } from '../../common/common_helper.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { openaiResponsesAccountService } from '../account/account_openai_responses_service.js'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { countVisibleContent } from '../tokenizer/tokenizer_service.js'
import { unifiedOpenAIScheduler } from './relay_unified_openai_scheduler.js'
import { assertOutboundModelAccess } from './relay_model_access.js'
import { applyOpenAIPublicModelAlias } from './relay_openai_model_alias.js'
import { filterForOpenAI } from './relay_header_filter.js'
import { buildClientError, extractUpstreamErrorCode } from '../../common/client_error_builder.js'

// 仅估算可见本地文本。远程会话、模板引用、文件、图片、音频和加密历史不能冒充精确输入。
export const extractResponsesCountTexts = (body) => {
  if (
    [body.previous_response_id, body.conversation, body.prompt].some((value) => value !== null && value !== undefined)
  ) {
    throw Object.assign(new Error('本地估算无法还原远程会话或提示模板，请使用支持官方计数接口的上游'), {
      statusCode: 422,
    })
  }
  const texts = []
  let visited = 0
  const visit = (value, depth = 0) => {
    if (++visited > LIMITS.responsesCountItems || depth > LIMITS.responsesCountDepth) {
      throw Object.assign(new Error('本地估算输入结构超过限制'), { statusCode: 413 })
    }
    if (typeof value === 'string') {
      texts.push(value)
      return
    }
    if (value === null || value === undefined || typeof value !== 'object') {
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1)
      }
      return
    }
    if (
      value.file_id ||
      value.file_url ||
      value.file_data ||
      value.image_url ||
      value.encrypted_content ||
      /image|audio|video|file|reference/.test(value.type ?? '') ||
      [
        'input_file',
        'input_image',
        'image',
        'input_audio',
        'audio',
        'video',
        'item_reference',
        'compaction',
        'computer_call',
        'computer_call_output',
      ].includes(value.type)
    ) {
      throw Object.assign(new Error('本地估算不支持文件、媒体、远程引用或加密输入'), { statusCode: 422 })
    }
    for (const [key, item] of Object.entries(value)) {
      if (!['type', 'role', 'id', 'status', 'call_id', 'phase'].includes(key)) {
        visit(item, depth + 1)
      }
    }
  }
  visit(body.instructions)
  visit(body.input)
  if (body.tools?.some((tool) => ['mcp', 'file_search', 'tool_search'].includes(tool.type))) {
    throw Object.assign(new Error('本地估算无法还原远程工具或检索内容，请使用上游原生计数'), { statusCode: 422 })
  }
  if (body.tools !== undefined) {
    texts.push(JSON.stringify(body.tools))
  }
  if (body.tool_choice !== undefined) {
    texts.push(JSON.stringify(body.tool_choice))
  }
  if (body.text?.format !== undefined) {
    texts.push(JSON.stringify(body.text.format))
  }
  return { texts, missing: ['protocol-framing', 'hidden-content'] }
}

export const handleResponsesInputTokens = async (req, res) => {
  const { body } = req
  const key = req.apiKey
  let detach = () => {}
  try {
    if (
      !body ||
      Array.isArray(body) ||
      typeof body !== 'object' ||
      typeof body.model !== 'string' ||
      !body.model.trim()
    ) {
      throw Object.assign(new Error('model 必须是非空字符串，请求体必须为 JSON 对象'), { statusCode: 400 })
    }
    if (body.input !== undefined && typeof body.input !== 'string' && !Array.isArray(body.input)) {
      throw Object.assign(new Error('input 必须是字符串或输入项数组'), { statusCode: 400 })
    }
    if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== 'string') {
      throw Object.assign(new Error('instructions 必须是字符串'), { statusCode: 400 })
    }
    if (body.tools !== undefined && body.tools !== null && !Array.isArray(body.tools)) {
      throw Object.assign(new Error('tools 必须是工具数组'), { statusCode: 400 })
    }
    const provider = key._relayRoute?.provider ?? 'openai'
    if (!key._relayRoute && !apiKeyService.hasPermission(key.permissions, 'openai')) {
      throw Object.assign(new Error('This API key does not have permission to access OpenAI'), { statusCode: 403 })
    }
    await assertOutboundModelAccess(key, body.model, provider)
    let estimatedModel = body.model
    let fallbackReason = 'upstream_not_supported'
    if (provider === 'openai') {
      const selected = await unifiedOpenAIScheduler.selectAccountForApiKey(key, null, body.model, {
        deferGroupAdmission: true,
      })
      if (selected.accountType === 'openai-responses') {
        const account = await openaiResponsesAccountService.getAccount(selected.accountId)
        if (!account) {
          throw Object.assign(new Error('上游账号不存在'), { statusCode: 503 })
        }
        const outbound = { ...body, model: getMappedModelName(account.supportedModels, body.model) ?? body.model }
        applyOpenAIPublicModelAlias(outbound, { originalModel: body.model, mapped: outbound.model !== body.model })
        estimatedModel = outbound.model
        await assertOutboundModelAccess(key, outbound.model, 'openai-responses')
        const base = account.baseApi.replace(/\/+$/, '')
        const url = `${base}${base.endsWith('/v1') ? '' : '/v1'}/responses/input_tokens`
        const proxy = proxyResolver.resolveAgent(account, 'openai-responses')
        const abort = new AbortController()
        detach = onClientDisconnect(res, () => abort.abort(), 'Responses token count')
        const headers = {
          ...filterForOpenAI(req.headers),
          Authorization: `Bearer ${account.apiKey}`,
          'Content-Type': 'application/json',
        }
        if (account.userAgent) {
          headers['User-Agent'] = account.userAgent
        }
        const response = await timedUpstreamRequest(req, () =>
          axios({
            url,
            method: 'POST',
            data: outbound,
            headers,
            timeout: Math.min(config.requestTimeout ?? 30000, 30000),
            validateStatus: () => true,
            signal: abort.signal,
            maxContentLength: LIMITS.responsesCountResponseBytes,
            ...(proxy.agent ? { httpAgent: proxy.agent, httpsAgent: proxy.agent, proxy: false } : {}),
          }),
        )
        if (response.status === 200) {
          if (
            response.data?.object !== 'response.input_tokens' ||
            !Number.isSafeInteger(response.data?.input_tokens) ||
            response.data.input_tokens < 0
          ) {
            throw Object.assign(new Error('上游计数接口返回非标准响应'), { statusCode: 502 })
          }
          res.setHeader('X-Token-Count-Source', 'upstream')
          return res.status(200).json(response.data)
        }
        const upstreamCode = extractUpstreamErrorCode(response.data)
        if (![404, 405, 501].includes(response.status) || upstreamCode === 'model_not_found') {
          const error = buildClientError({
            statusCode: response.status,
            protocol: 'openai',
            upstreamBody: response.data,
          })
          return res.status(error.statusCode).json(error.body)
        }
        fallbackReason = `upstream_http_${response.status}`
      } else {
        fallbackReason = 'oauth_count_endpoint_unavailable'
      }
    }
    const projected = extractResponsesCountTexts(body)
    const count = await countVisibleContent({ ...projected, model: estimatedModel })
    res.setHeader('X-Token-Count-Source', count.source)
    res.setHeader('X-Token-Count-Estimated', 'true')
    return res.json({
      object: 'response.input_tokens',
      input_tokens: count.contentTokens,
      _crs_estimate: true,
      _crs_estimate_method: count.source,
      _crs_precision: count.precision,
      _crs_tokenizer: count.selection.tokenizer,
      _crs_scope: 'visible-text',
      _crs_missing: count.missing,
      _crs_fallback_reason: fallbackReason,
    })
  } catch (error) {
    logger.error('Responses input token count failed', { error, requestId: req.requestId, model: body?.model })
    if (res.destroyed || res.writableEnded) {
      return undefined
    }
    const status = error.statusCode ?? 502
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: { type: 'invalid_request_error', message: error.message } })
    }
    const result = buildClientError({ statusCode: status, protocol: 'openai', upstreamBody: null })
    return res.status(result.statusCode).json(result.body)
  } finally {
    detach()
  }
}
