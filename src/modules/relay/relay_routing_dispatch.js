import express from 'express'
import { handleResponsesInputTokens } from './relay_openai_input_tokens.js'
import { authenticateApiKey } from '../../infra/middleware_auth.js'
import { logger } from '../../common/logger.js'
import { getRouteModels } from './relay_routing_service.js'
import { handleMessagesRequest, handleCountTokensRequest } from './relay_api_routes.js'
import { handleResponses } from './relay_openai_routes.js'
import { handleUnifiedChatRequest } from './relay_unified_routes.js'
import {
  handleGenerateContent,
  handleStreamGenerateContent,
  handleStandardGenerateContent,
  handleStandardStreamGenerateContent,
  handleCountTokens,
  handleInteractions,
} from './relay_gemini_handlers_routes.js'
import { geminiInteractionsService } from './relay_gemini_interactions_service.js'
import { getCodeAssistOperation } from './relay_gemini_code_assist_contract.js'
import { createCodeAssistHandler } from './relay_gemini_code_assist_handlers.js'
import { relayResponsesViaProvider } from './relay_responses_gateway.js'
import { adaptResponsesTools, requiresResponsesToolAdapter } from './relay_responses_tools.js'
import { installResponsesToolTransport } from './relay_responses_tool_transport.js'
import { grokRelayService } from './relay_grok_relay_service.js'
import { droidRelayService } from './relay_droid_relay_service.js'
import { sessionHelper } from './relay_session_helper.js'
import { routeErrorBody } from './relay_routing_errors.js'
import { countAnthropicEstimate, anthropicEstimateResponse } from '../tokenizer/tokenizer_service.js'
import { isModelAllowedByGroup } from '../account/account_group_constants.js'
import { getRouteTarget } from './relay_routing_service.js'
import { sendModelDiscovery } from './relay_model_discovery.js'

export const namedRoutes = express.Router({ mergeParams: true })
namedRoutes.use(authenticateApiKey)

export const dispatchRoutedRequest = async (req, res, format) => {
  const route = req.apiKey._relayRoute
  try {
    const path = req.path.split('?')[0].replace(/\/+$/, '')
    const interactionPath = path.match(/^\/(v1|v1beta)\/interactions(?:\/([^/]+)(\/cancel)?)?$/)
    if (interactionPath) {
      if (!['gemini', 'antigravity'].includes(route.provider) || format !== 'gemini-generate') {
        return res.status(501).json(routeErrorBody(req, 501, '此入口不支持 Gemini Interactions'))
      }
      if (interactionPath[2]) {
        req.params = { ...req.params, id: decodeURIComponent(interactionPath[2]) }
        const action =
          req.method === 'GET' && !interactionPath[3]
            ? 'get'
            : req.method === 'DELETE' && !interactionPath[3]
              ? 'delete'
              : req.method === 'POST' && interactionPath[3]
                ? 'cancel'
                : null
        if (action) {
          return await geminiInteractionsService.resource(req, res, action)
        }
      } else if (req.method === 'POST') {
        if (req._relayRouteModel?.mappedModel) {
          req.body.model = req._relayRouteModel.mappedModel
        }
        return await handleInteractions(req, res)
      }
      return res.status(404).json(routeErrorBody(req, 404, '入口没有此接口'))
    }
    const auxiliary = getCodeAssistOperation(req.method, path)
    if (auxiliary) {
      if (route.provider !== 'gemini' || format !== 'gemini-generate') {
        return res.status(501).json(routeErrorBody(req, 501, '此入口不支持 Gemini CLI 辅助接口'))
      }
      if (auxiliary.operationId) {
        req.params = { ...req.params, operationId: auxiliary.operationId }
      }
      const handler = createCodeAssistHandler(auxiliary.name, {
        method: auxiliary.method,
        dedicatedOnly: auxiliary.name === 'setCodeAssistGlobalUserSetting',
      })
      return await handler(req, res)
    }
    if (
      req.params?.routeCode &&
      !/^\/(?:v1\/(?:messages(?:\/count_tokens)?|chat\/completions|responses(?:\/(?:compact|input_tokens))?|models)|responses(?:\/(?:compact|input_tokens))?|models|v1beta\/models|v1internal:(?:generateContent|streamGenerateContent|countTokens)|(?:v1|v1beta)\/models\/[^/]+:(?:generateContent|streamGenerateContent|countTokens))$/.test(
        path,
      )
    ) {
      return res.status(404).json(routeErrorBody(req, 404, '入口没有此接口'))
    }
    if (req.method === 'GET' && ['/v1/models', '/models', '/v1beta/models'].includes(path)) {
      const modelFormat =
        path === '/v1beta/models' ? 'gemini-generate' : req.headers['anthropic-version'] ? 'claude-messages' : null
      const models = await getRouteModels(route, req.apiKey, null, new Map(), modelFormat)
      return sendModelDiscovery(req, res, models, path === '/v1beta/models')
    }
    if (req.method !== 'POST' || !format) {
      return res.status(404).json({ error: { type: 'not_found_error', message: '入口没有此接口' } })
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: { type: 'invalid_request_error', message: '请求体必须是 JSON 对象' } })
    }
    const geminiPath = path.match(/\/models\/([^/]+):(generateContent|streamGenerateContent|countTokens)$/)
    const internalAction = path.match(/^\/v1internal:(generateContent|streamGenerateContent|countTokens)$/)?.[1]
    const mappedModel = req._relayRouteModel?.mappedModel
    if (!mappedModel) {
      return res.status(400).json({ error: { type: 'invalid_request_error', message: '必须指定模型' } })
    }
    if (route.provider === 'gemini' || route.provider === 'antigravity') {
      req._anthropicVendor = route.provider === 'antigravity' ? 'antigravity' : 'gemini-cli'
    }
    if (format === 'gemini-generate') {
      if (!geminiPath && !internalAction) {
        return res.status(404).json({ error: { type: 'not_found_error', message: '请使用标准 Gemini 模型接口路径' } })
      }
      req.params = { ...req.params, modelName: mappedModel }
      if (internalAction === 'countTokens') {
        return await handleCountTokens(req, res)
      }
      if (internalAction === 'streamGenerateContent') {
        return await handleStreamGenerateContent(req, res)
      }
      if (internalAction === 'generateContent') {
        return await handleGenerateContent(req, res)
      }
      if (geminiPath[2] === 'countTokens') {
        return await handleCountTokens(req, res)
      }
      if (geminiPath[2] === 'streamGenerateContent') {
        return await handleStandardStreamGenerateContent(req, res)
      }
      return await handleStandardGenerateContent(req, res)
    }
    if (path.endsWith('/responses/input_tokens')) {
      return await handleResponsesInputTokens(req, res)
    }
    const countTokens = path.endsWith('/messages/count_tokens')
    if (countTokens) {
      if (!['claude', 'gemini', 'antigravity'].includes(route.provider)) {
        if (!Array.isArray(req.body.messages)) {
          return res.status(400).json(routeErrorBody(req, 400, 'messages 必须为数组'))
        }
        const target = await getRouteTarget(route)
        if (target?.group && !isModelAllowedByGroup(target.group, mappedModel)) {
          return res.status(403).json(routeErrorBody(req, 403, '此分组不允许该模型'))
        }
        const count = await countAnthropicEstimate(req.body, route.tokenizerOverride)
        res.set('x-crs-token-count-source', count.source)
        res.set('x-crs-token-count-precision', 'request-estimate')
        return res.json(anthropicEstimateResponse(count))
      }
      return await handleCountTokensRequest(req, res)
    }
    if (route.provider === 'droid') {
      if (path.endsWith('/compact')) {
        return res.status(501).json(routeErrorBody(req, 501, '此目标不支持 Responses compact'))
      }
      const endpointType = { 'claude-messages': 'anthropic', 'openai-chat': 'comm', 'openai-responses': 'openai' }[
        format
      ]
      const result = await droidRelayService.relayRequest(req.body, req.apiKey, req, res, req.headers, {
        endpointType,
        sessionHash: sessionHelper.generateSessionHash(req.body),
      })
      if (!result.streaming) {
        return res.status(result.statusCode).set(result.headers).send(result.body)
      }
      return undefined
    }
    if (route.provider === 'grok') {
      const session = sessionHelper.generateSessionHash(req.body)
      if (format === 'claude-messages') {
        return await grokRelayService.relayMessages(req, res, req.apiKey, session)
      }
      if (format === 'openai-chat') {
        return await grokRelayService.relayChatCompletions(req, res, req.apiKey, session)
      }
      return await grokRelayService.relayResponses(req, res, req.apiKey, session)
    }
    if (format === 'claude-messages') {
      return await handleMessagesRequest(req, res)
    }
    if (format === 'openai-chat') {
      return await handleUnifiedChatRequest(req, res)
    }
    if (route.provider === 'claude' || route.provider === 'gemini') {
      return await relayResponsesViaProvider(req, res, {
        provider: route.provider,
        handle:
          route.provider === 'claude'
            ? handleMessagesRequest
            : req.body.stream === true && !path.endsWith('/compact')
              ? handleStandardStreamGenerateContent
              : handleStandardGenerateContent,
      })
    }
    if (route.converterOptions?.['openai-responses']?.toolMode === 'functions' && requiresResponsesToolAdapter(req.body)) {
      const adapter = adaptResponsesTools(req.body)
      const originalBody = req.body
      const restore = installResponsesToolTransport(res, adapter)
      req.body = adapter.body
      try { return await handleResponses(req, res) }
      finally { req.body = originalBody; restore() }
    }
    return await handleResponses(req, res)
  } catch (error) {
    logger.error('Named relay route failed', { error, routeCode: route.code, keyId: req.apiKey.id })
    if (!res.headersSent) {
      res
        .status(error.statusCode ?? 500)
        .json(
          routeErrorBody(
            req,
            error.statusCode ?? 500,
            error.statusCode && error.statusCode < 500 ? error.message : '调用入口当前不可用',
          ),
        )
    } else if (!res.writableEnded) {
      res.end()
    }
    return undefined
  }
}
