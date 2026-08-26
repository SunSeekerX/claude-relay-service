import { BaseBalanceProvider } from './payment_base_balance_provider.js'
export class ClaudeConsoleBalanceProvider extends BaseBalanceProvider {
  constructor() {
    super('claude-console')
  }

  async queryBalance(account) {
    this.logger.debug(`查询 Claude Console 余额（字段）: ${account?.id}`)
    return this.readQuotaFromFields(account)
  }
}
