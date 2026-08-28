// 跨协议转换：格式标识 + 质量分级
// 对齐 CLIProxyAPI/new-api 的 from→to 注册语义

export const TranslatorFormat = {
  openaiChat: 'openai-chat',
  openaiResponses: 'openai-responses',
  claudeMessages: 'claude-messages',
  geminiGenerate: 'gemini-generate',
  geminiInteractions: 'gemini-interactions',
  grokChat: 'grok-chat',
  grokResponses: 'grok-responses',
  grokMessages: 'grok-messages',
}

// good = 字段级保真；fair = 可用有损；discouraged = 仅兜底，调用方应告警
export const TranslatorQuality = {
  good: 'good',
  fair: 'fair',
  discouraged: 'discouraged',
}

export const buildTranslatorKey = (from, to) => `${from}->${to}`
