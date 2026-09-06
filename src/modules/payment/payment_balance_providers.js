import { BaseBalanceProvider } from './payment_base_balance_provider.js'
import { claudeAccountService } from '../account/account_claude_service.js'
import { GeminiBalanceProvider } from './payment_gemini_balance_provider.js'

class ClaudeBalanceProvider extends BaseBalanceProvider {
  constructor() {
    super('claude')
  }

  // Claude（OAuth）：优先尝试获取 OAuth usage（用于配额/使用信息），不强行提供余额金额
  async queryBalance(account) {
    this.logger.debug(`查询 Claude 余额（OAuth usage）: ${account?.id}`)

    // 仅 OAuth 账户可用；失败时降级
    const usageData = await claudeAccountService.fetchOAuthUsage(account.id).catch(() => null)
    if (!usageData) {
      return { balance: null, currency: 'USD', queryMethod: 'local' }
    }

    return {
      balance: null,
      currency: 'USD',
      queryMethod: 'api',
      rawData: usageData,
    }
  }
}

class ClaudeConsoleBalanceProvider extends BaseBalanceProvider {
  constructor() {
    super('claude-console')
  }

  async queryBalance(account) {
    this.logger.debug(`查询 Claude Console 余额（字段）: ${account?.id}`)
    return this.readQuotaFromFields(account)
  }
}

class OpenAIResponsesBalanceProvider extends BaseBalanceProvider {
  constructor() {
    super('openai-responses')
  }

  // OpenAI-Responses：
  // - 优先使用 dailyQuota 字段（如果配置了额度）
  // - 可选：尝试调用兼容 API（不同服务商实现不一，失败自动降级）
  async queryBalance(account) {
    this.logger.debug(`查询 OpenAI Responses 余额: ${account?.id}`)

    // 配置了额度时直接返回（字段法）
    if (account?.dailyQuota && Number(account.dailyQuota) > 0) {
      return this.readQuotaFromFields(account)
    }

    // 尝试调用 usage 接口（兼容性不保证）
    if (account?.apiKey && account?.baseApi) {
      const baseApi = String(account.baseApi).replace(/\/$/, '')
      const response = await this.makeRequest(
        `${baseApi}/v1/usage`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${account.apiKey}`,
            'Content-Type': 'application/json',
          },
        },
        account,
      )

      if (response.success) {
        return {
          balance: null,
          currency: this.parseCurrency(response.data),
          queryMethod: 'api',
          rawData: response.data,
        }
      }
    }

    return {
      balance: null,
      currency: 'USD',
      queryMethod: 'local',
    }
  }
}

class GenericBalanceProvider extends BaseBalanceProvider {
  constructor(platform) {
    super(platform)
  }

  async queryBalance(account) {
    this.logger.debug(`${this.platform} 暂无专用余额 API，实现降级策略`)

    if (account && Object.prototype.hasOwnProperty.call(account, 'dailyQuota')) {
      return this.readQuotaFromFields(account)
    }

    return {
      balance: null,
      currency: 'USD',
      queryMethod: 'local',
    }
  }
}

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
