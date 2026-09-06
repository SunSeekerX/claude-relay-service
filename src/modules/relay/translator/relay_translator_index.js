// 转换器注册入口：导入即注册全部方向
import { TranslatorFormat, TranslatorQuality } from './relay_translator_formats.js'
import { registerTranslator, listTranslators } from './relay_translator_registry.js'
import { openaiToClaude } from '../relay_openai_to_claude.js'
import { CodexToOpenAIConverter } from '../relay_codex_to_openai.js'
import { GeminiToOpenAIConverter } from '../relay_gemini_to_openai.js'
import { registerClaudeResponsesTranslators } from './relay_translator_claude_responses.js'
import { registerInteractionsTranslators } from './relay_translator_interactions.js'

let initialized = false

export const initTranslatorRegistry = () => {
  if (initialized) {
    return listTranslators()
  }
  initialized = true

  // OpenAI Chat ↔ Claude Messages
  registerTranslator({
    from: TranslatorFormat.openaiChat,
    to: TranslatorFormat.claudeMessages,
    quality: TranslatorQuality.good,
    convertRequest: (request) => openaiToClaude.convertRequest(request),
    convertResponse: (response, options = {}) =>
      openaiToClaude.convertResponse(response, options.model || response?.model),
    convertStreamChunk: (chunk, state, options = {}) =>
      openaiToClaude.convertStreamChunk(chunk, options.model, state?.sessionId || options.sessionId),
    createStreamState: (options = {}) => ({ sessionId: options.sessionId || `chatcmpl-${Date.now()}` }),
  })

  // Codex/Responses ↔ OpenAI Chat
  // convertRequest 方向：from 请求体 → to 请求体
  // convertResponse / stream：上游 to 响应 → 客户端 from 格式
  const codexConverter = new CodexToOpenAIConverter()
  registerTranslator({
    from: TranslatorFormat.openaiResponses,
    to: TranslatorFormat.openaiChat,
    // request：Responses input/tools → Chat messages/tools（与 buildRequestFromOpenAI 对称）
    quality: TranslatorQuality.good,
    convertRequest: (request) => codexConverter.buildChatRequestFromResponses(request),
    convertResponse: (response, options = {}) => {
      if (typeof codexConverter.convertResponse === 'function') {
        return codexConverter.convertResponse(response, options.model)
      }
      return response
    },
    createStreamState: () => codexConverter.createStreamState(),
    convertStreamChunk: (eventData, state, options = {}) =>
      codexConverter.convertStreamChunk(eventData, options.model || state.model, state),
  })
  registerTranslator({
    from: TranslatorFormat.openaiChat,
    to: TranslatorFormat.openaiResponses,
    quality: TranslatorQuality.good,
    convertRequest: (request) => {
      if (typeof codexConverter.buildRequestFromOpenAI === 'function') {
        return codexConverter.buildRequestFromOpenAI(request)
      }
      return request
    },
  })

  // Gemini → OpenAI Chat
  const geminiConverter = new GeminiToOpenAIConverter()
  registerTranslator({
    from: TranslatorFormat.geminiGenerate,
    to: TranslatorFormat.openaiChat,
    quality: TranslatorQuality.good,
    createStreamState: () => geminiConverter.createStreamState(),
    convertStreamChunk: (chunk, state, options = {}) => geminiConverter.convertStreamChunk(chunk, options.model, state),
    convertResponse: (response, options = {}) => {
      if (typeof geminiConverter.convertResponse === 'function') {
        return geminiConverter.convertResponse(response, options.model)
      }
      return response
    },
  })

  registerClaudeResponsesTranslators()
  registerInteractionsTranslators()

  // 同格式透传占位（质量 good）
  for (const format of Object.values(TranslatorFormat)) {
    registerTranslator({
      from: format,
      to: format,
      quality: TranslatorQuality.good,
      convertRequest: (request) => request,
      convertResponse: (response) => response,
      convertStreamChunk: (chunk) => chunk,
      createStreamState: () => ({}),
    })
  }

  return listTranslators()
}

export { listTranslators }
