import { ClaudeBalanceProvider } from './payment_claude_balance_provider.js'
import { ClaudeConsoleBalanceProvider } from './payment_claude_console_balance_provider.js'
import { OpenAIResponsesBalanceProvider } from './payment_openai_responses_balance_provider.js'
import { GenericBalanceProvider } from './payment_generic_balance_provider.js'
import { GeminiBalanceProvider } from './payment_gemini_balance_provider.js'
export const registerAllProviders = function registerAllProviders(balanceService) {
  // Claude
  balanceService.registerProvider('claude', new ClaudeBalanceProvider())
  balanceService.registerProvider('claude-console', new ClaudeConsoleBalanceProvider())

  // OpenAI / Codex
  balanceService.registerProvider('openai-responses', new OpenAIResponsesBalanceProvider())
  balanceService.registerProvider('openai', new GenericBalanceProvider('openai'))
  balanceService.registerProvider('azure_openai', new GenericBalanceProvider('azure_openai'))

  // 其他平台（降级）
  balanceService.registerProvider('gemini', new GeminiBalanceProvider())
  balanceService.registerProvider('gemini-api', new GenericBalanceProvider('gemini-api'))
  balanceService.registerProvider('bedrock', new GenericBalanceProvider('bedrock'))
  balanceService.registerProvider('droid', new GenericBalanceProvider('droid'))
  balanceService.registerProvider('grok', new GenericBalanceProvider('grok'))
  balanceService.registerProvider('ccr', new GenericBalanceProvider('ccr'))
}
