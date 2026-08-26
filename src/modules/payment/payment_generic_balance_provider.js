import { BaseBalanceProvider } from './payment_base_balance_provider.js'
export class GenericBalanceProvider extends BaseBalanceProvider {
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
