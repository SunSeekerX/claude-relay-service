import express from 'express'
import { authenticateApiKey } from '../../infra/middleware_auth.js'
import * as geminiHandlers from './relay_gemini_handlers_routes.js'
/**
 * Gemini API 路由模块（精简版）
 *
 * 该模块只包含 geminiRoutes 独有的路由：
 * - /messages - OpenAI 兼容格式消息处理
 * - /models - 模型列表
 * - /usage - 使用统计
 * - /key-info - API Key 信息
 * - /v1internal:listExperiments - 实验列表
 * - /v1beta/models/:modelName:listExperiments - 带模型参数的实验列表
 *
 * 其他标准 Gemini API 路由由 standardGeminiRoutes.js 处理。
 * 所有处理函数都从 geminiHandlers.js 导入，以避免代码重复。
 */

export const geminiRoutes = express.Router()

// 从 handlers/geminiHandlers.js 导入所有处理函数
// ===
// OpenAI 兼容格式路由
// ===

/**
 * POST /messages
 * OpenAI 兼容格式的消息处理端点
 */
geminiRoutes.post('/messages', authenticateApiKey, geminiHandlers.handleMessages)

// ===
// 模型和信息路由
// ===

/**
 * GET /models
 * 获取可用模型列表
 */
geminiRoutes.get('/models', authenticateApiKey, geminiHandlers.handleModels)

/**
 * GET /usage
 * 获取使用情况统计
 */
geminiRoutes.get('/usage', authenticateApiKey, geminiHandlers.handleUsage)

/**
 * GET /key-info
 * 获取 API Key 信息
 */
geminiRoutes.get('/key-info', authenticateApiKey, geminiHandlers.handleKeyInfo)

// ===
// v1internal 独有路由
// ===

/**
 * POST /v1internal:listExperiments
 * 列出实验（只有 geminiRoutes 定义此路由）
 */
geminiRoutes.post(
  '/v1internal\\:listExperiments',
  authenticateApiKey,
  geminiHandlers.handleSimpleEndpoint('listExperiments'),
)

/**
 * POST /v1internal:retrieveUserQuota
 * 获取用户配额信息（Gemini CLI 0.22.2+ 需要）
 */
geminiRoutes.post('/v1internal\\:retrieveUserQuota', authenticateApiKey, geminiHandlers.handleRetrieveUserQuota)

/**
 * POST /v1beta/models/:modelName:listExperiments
 * 带模型参数的实验列表（只有 geminiRoutes 定义此路由）
 */
geminiRoutes.post(
  '/v1beta/models/:modelName\\:listExperiments',
  authenticateApiKey,
  geminiHandlers.handleSimpleEndpoint('listExperiments'),
)
