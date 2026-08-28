// /v1/messages 专属绑定跨协议分流（人工决策：仅专属绑定才跨协议）
// - Key 绑定 openaiAccountId（含 responses: 前缀）且 model 为 gpt/o* → Responses 桥
// - Key 绑定 grokAccountId 且 model 为 grok/composer → Grok Messages 桥
// - 否则保持 Claude 族调度

import { logger } from '../../common/logger.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { detectBackendFromModel } from './relay_unified_routes.js'
import * as claudeResponses from './translator/relay_translator_claude_responses.js'
import { grokRelayService } from './relay_grok_relay_service.js'
import { sessionHelper } from './relay_session_helper.js'
import { handleResponses } from './relay_openai_routes.js'

const hasOpenaiDedicatedBinding = (apiKey) => {
  const binding = apiKey?.openaiAccountId
  return typeof binding === 'string' && binding.trim().length > 0
}

const hasGrokDedicatedBinding = (apiKey) => {
  const binding = apiKey?.grokAccountId
  return typeof binding === 'string' && binding.trim().length > 0
}

const isOpenaiFamilyModel = (model) => {
  const backend = detectBackendFromModel(model)
  if (backend === 'openai') {
    return true
  }
  const lower = String(model || '').toLowerCase()
  return lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4') || lower.includes('codex')
}

const isGrokFamilyModel = (model) => detectBackendFromModel(model) === 'grok'

/**
 * @returns {Promise<boolean>} true 表示已接管并结束响应
 */
export const tryDedicatedBindingCrossProtocol = async (req, res) => {
  const { apiKey } = req
  const model = req.body?.model || ''
  if (!apiKey || !model) {
    return false
  }

  // Grok 专属绑定 + grok 模型
  if (isGrokFamilyModel(model) && hasGrokDedicatedBinding(apiKey)) {
    if (!apiKeyService.hasPermission(apiKey.permissions, 'grok')) {
      res.status(403).json({
        error: {
          type: 'permission_denied',
          message: 'This API key does not have Grok permission',
        },
      })
      return true
    }
    logger.info(`[messages-gateway] dedicated grok binding bridge model=${model} key=${apiKey.name || apiKey.id}`)
    try {
      const sessionHash = sessionHelper.generateSessionHash(req.body)
      req._crsProtocolBridge = 'claude-messages->grok-messages'
      await grokRelayService.relayMessages(req, res, apiKey, sessionHash)
    } catch (error) {
      console.error(error)
      if (!res.headersSent) {
        res.status(error.statusCode || 502).json({
          type: 'error',
          error: {
            type: 'api_error',
            message: error.message || 'grok messages bridge failed',
          },
        })
      }
    }
    return true
  }

  // OpenAI/Responses 专属绑定 + gpt 族模型
  if (isOpenaiFamilyModel(model) && hasOpenaiDedicatedBinding(apiKey)) {
    if (!apiKeyService.hasPermission(apiKey.permissions, 'openai')) {
      res.status(403).json({
        error: {
          type: 'permission_denied',
          message: 'This API key does not have OpenAI permission',
        },
      })
      return true
    }
    logger.info(`[messages-gateway] dedicated openai binding bridge model=${model} key=${apiKey.name || apiKey.id}`)
    return await relayClaudeMessagesViaOpenAIResponses(req, res, apiKey)
  }

  return false
}

const relayClaudeMessagesViaOpenAIResponses = async (req, res, _apiKey) => {
  const originalBody = req.body
  const restore = () => {
    req.body = originalBody
    delete req._claudeMessagesViaResponses
  }

  try {
    const responsesBody = claudeResponses.convertClaudeRequestToResponses(originalBody || {}, {})
    responsesBody.store = false
    if (!Array.isArray(responsesBody.include)) {
      responsesBody.include = ['reasoning.encrypted_content']
    }
    const wantStream = originalBody?.stream === true
    responsesBody.stream = wantStream
    req.body = responsesBody
    req._claudeMessagesViaResponses = true
    req._crsProtocolBridge = 'claude-messages->openai-responses'

    if (!wantStream) {
      const originalJson = res.json.bind(res)
      const originalStatus = res.status.bind(res)
      let statusCode = 200
      res.status = (code) => {
        statusCode = code
        return originalStatus(code)
      }
      res.json = (data) => {
        try {
          if (statusCode >= 400) {
            // 上游错误：尽量转成 Anthropic error 壳
            const message =
              data?.error?.message || data?.message || (typeof data === 'string' ? data : 'upstream error')
            return originalJson({
              type: 'error',
              error: {
                type: data?.error?.type || 'api_error',
                message,
              },
            })
          }
          const claudeMessage = claudeResponses.convertResponsesResultToClaudeMessage(data)
          return originalJson(claudeMessage)
        } catch (error) {
          console.error(error)
          return originalJson(data)
        }
      }
      try {
        await handleResponses(req, res)
      } finally {
        res.json = originalJson
        res.status = originalStatus
        restore()
      }
      return true
    }

    // 流式：拦截 Responses SSE → Anthropic SSE；错误状态原样 JSON 不再伪装 SSE
    const state = claudeResponses.createClaudeFromResponsesStreamState()
    state.model = originalBody?.model || responsesBody.model || ''
    const originalWrite = res.write.bind(res)
    const originalEnd = res.end.bind(res)
    const originalJson = res.json.bind(res)
    let buffer = ''
    let headersPrepared = false
    let bridgeFailed = false

    const ensureAnthropicHeaders = () => {
      if (headersPrepared || res.headersSent) {
        return
      }
      headersPrepared = true
      if (!res.statusCode || res.statusCode < 400) {
        res.statusCode = 200
      }
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
    }

    // 非 SSE 错误：handleResponses 可能 res.json
    res.json = (data) => {
      bridgeFailed = true
      restore()
      res.write = originalWrite
      res.end = originalEnd
      const message = data?.error?.message || data?.message || 'upstream error'
      return originalJson({
        type: 'error',
        error: { type: data?.error?.type || 'api_error', message },
      })
    }

    res.write = (chunk, encoding, callback) => {
      if (bridgeFailed) {
        return originalWrite(chunk, encoding, callback)
      }
      // 若已是错误状态且尚未发 SSE 头，不要开始 Anthropic 流
      if (res.statusCode >= 400 && !headersPrepared) {
        return originalWrite(chunk, encoding, callback)
      }
      ensureAnthropicHeaders()
      const str = typeof chunk === 'string' ? chunk : chunk.toString()
      buffer += str.replace(/\r\n/g, '\n')
      let output = ''
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const lines = block.split('\n')
        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            continue
          }
          const payload = line.slice(6).trim()
          if (!payload || payload === '[DONE]') {
            continue
          }
          try {
            const eventData = JSON.parse(payload)
            if (eventData.type === 'error' || eventData.error) {
              output += `event: error\n`
              output += `data: ${JSON.stringify({
                type: 'error',
                error: {
                  type: eventData.error?.type || 'api_error',
                  message: eventData.error?.message || eventData.message || 'stream error',
                },
              })}\n\n`
              continue
            }
            const events = claudeResponses.convertResponsesStreamEventToClaude(eventData, state)
            for (const item of events) {
              const eventName = item.event || item.data?.type
              const data = item.data || item
              if (eventName) {
                output += `event: ${eventName}\n`
              }
              output += `data: ${JSON.stringify(data)}\n\n`
            }
          } catch (error) {
            // ignore
          }
        }
      }
      if (output) {
        return originalWrite(output, encoding, callback)
      }
      if (typeof callback === 'function') {
        callback()
      }
      return true
    }

    res.end = (chunk, encoding, callback) => {
      try {
        if (chunk) {
          res.write(chunk, encoding)
        }
        if (!bridgeFailed && headersPrepared && !state.stopped) {
          const stop = `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
          originalWrite(stop)
          state.stopped = true
        }
      } finally {
        restore()
        res.write = originalWrite
        res.end = originalEnd
        res.json = originalJson
      }
      return originalEnd(null, encoding, callback)
    }

    try {
      await handleResponses(req, res)
    } catch (error) {
      restore()
      res.write = originalWrite
      res.end = originalEnd
      res.json = originalJson
      if (!res.headersSent) {
        res.status(error.statusCode || 502).json({
          type: 'error',
          error: {
            type: 'api_error',
            message: error.message || 'bridge failed',
          },
        })
        return true
      }
      throw error
    }
    return true
  } catch (error) {
    console.error(error)
    restore()
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: error.message || 'messages gateway failed',
        },
      })
      return true
    }
    throw error
  }
}
