import express from 'express'
import { authenticateApiKey } from '../../infra/middleware_auth.js'
import { logger } from '../../common/logger.js'
import { handleMessagesRequest, handleCountTokensRequest } from './relay_api_routes.js'
import { handleResponses, handleModels as handleOpenAIModels } from './relay_openai_routes.js'
import { unifiedRoutes } from './relay_unified_routes.js'
import { router as standardGeminiRoutes } from './relay_standard_gemini_routes.js'
import { modelService } from '../pricing/pricing_model_service.js'
// 官方 CLI 路径并集别名（旧 /api /openai /gemini /claude 前缀一律保留）
// 对齐：
// - Codex ChatGPT base: /backend-api/codex/responses
// - Codex/OpenAI API Key base: /v1/responses
// - Claude ANTHROPIC_BASE_URL: /v1/messages
// - Gemini: 根 /v1beta/* 与 /v1internal:*
// - CLIProxyAPI / sub2api 同名路径

// /v1/models 按客户端指纹分流（对齐 new-api）
// - client_version → Codex manifest
// - anthropic-version → Claude/全量列表
// - 默认 → OpenAI 兼容列表
export const handleV1Models = async (req, res) => {
  const hasAnthropicVersion = Boolean(req.headers['anthropic-version'])
  const clientVersion = typeof req.query?.client_version === 'string' ? req.query.client_version.trim() : ''

  if (clientVersion && typeof handleOpenAIModels === 'function') {
    return handleOpenAIModels(req, res)
  }

  if (hasAnthropicVersion) {
    try {
      let models = modelService.getAllModels()
      if (req.apiKey?.enableModelRestriction && req.apiKey.restrictedModels?.length > 0) {
        models = models.filter((model) => !req.apiKey.restrictedModels.includes(model.id))
      }
      return res.json({ object: 'list', data: models })
    } catch (error) {
      logger.error('[officialAliases] /v1/models anthropic branch failed:', error)
      console.error(error)
      return res.status(500).json({
        error: { type: 'api_error', message: 'Failed to get models list' },
      })
    }
  }

  if (typeof handleOpenAIModels === 'function') {
    return handleOpenAIModels(req, res)
  }

  return res.status(500).json({
    error: { type: 'api_error', message: 'Models handler unavailable' },
  })
}

export const createOfficialAliasRouter = () => {
  const router = express.Router()

  // ---------- Claude 官方 ----------
  if (typeof handleMessagesRequest === 'function') {
    router.post('/v1/messages', authenticateApiKey, handleMessagesRequest)
  }
  if (typeof handleCountTokensRequest === 'function') {
    router.post('/v1/messages/count_tokens', authenticateApiKey, handleCountTokensRequest)
  }

  // ---------- OpenAI Chat 智能路由（unified 自带 /v1/chat/completions）----------
  router.use(unifiedRoutes)

  // ---------- OpenAI / Codex Responses ----------
  if (typeof handleResponses === 'function') {
    router.post('/v1/responses', authenticateApiKey, handleResponses)
    router.post('/v1/responses/compact', authenticateApiKey, handleResponses)
    // 无 v1 前缀别名（sub2api / CLIProxyAPI）
    router.post('/responses', authenticateApiKey, handleResponses)
    router.post('/responses/compact', authenticateApiKey, handleResponses)
  }

  router.get('/v1/models', authenticateApiKey, handleV1Models)

  // Codex 独立搜索 / Realtime·Live 建连（API Key base 形态 /v1/...）
  // WS sideband 由 app.js upgrade 处理：/v1/realtime、/v1/live/:id、/v1/realtime/calls/:id
  if (typeof handleResponses === 'function') {
    router.post('/v1/alpha/search', authenticateApiKey, handleResponses)
    router.post('/v1/realtime/calls', authenticateApiKey, handleResponses)
    router.post('/v1/live', authenticateApiKey, handleResponses)
    router.post('/v1/realtime', authenticateApiKey, handleResponses)
  }

  // ---------- Codex ChatGPT base_url 形状 ----------
  const codexDirect = express.Router()
  if (typeof handleResponses === 'function') {
    codexDirect.post('/responses', authenticateApiKey, handleResponses)
    codexDirect.post('/responses/compact', authenticateApiKey, handleResponses)
    codexDirect.post('/alpha/search', authenticateApiKey, handleResponses)
    codexDirect.post('/realtime/calls', authenticateApiKey, handleResponses)
    codexDirect.post('/live', authenticateApiKey, handleResponses)
  }
  if (typeof handleOpenAIModels === 'function') {
    codexDirect.get('/models', authenticateApiKey, handleOpenAIModels)
  }
  router.use('/backend-api/codex', codexDirect)

  // ---------- Gemini 官方根路径（standard 内已是 /v1beta 与 /v1internal）----------
  router.use(standardGeminiRoutes)

  return router
}
