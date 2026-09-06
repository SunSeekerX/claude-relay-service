import * as openaiAccountService from '../src/modules/account/account_openai_service.js'
import { openaiResponsesAccountService } from '../src/modules/account/account_openai_responses_service.js'
import * as upstreamErrorHelper from '../src/modules/relay/relay_upstream_error_helper.js'
import { unifiedOpenAIScheduler } from '../src/modules/relay/relay_unified_openai_scheduler.js'
jest.mock('../src/modules/account/account_openai_service.js', () => ({
  setAccountRateLimited: jest.fn(),
  getAllAccounts: jest.fn(),
  getAccount: jest.fn()
}))

jest.mock('../src/modules/account/account_openai_responses_service.js', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn(),
  isSubscriptionExpired: jest.fn(),
  isAccountQuotaExceeded: jest.fn(),
  checkAndClearRateLimit: jest.fn(),
  markAccountRateLimited: jest.fn(),
  updateAccount: jest.fn()
}))

jest.mock('../src/modules/account/account_group_service.js', () => ({}))
jest.mock('../src/infra/redis.js', () => ({}))
jest.mock('../src/common/logger.js', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/common/common_helper.js', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  isAutoProtectionDisabled: jest.fn(
    (account) =>
      !!account &&
      (account.disableAutoProtection === true || account.disableAutoProtection === 'true')
  ),
  sortAccountsByPriority: jest.fn((accounts) => accounts),
  getMappedModelName: jest.fn((mapping, requested) => {
    if (!mapping || typeof mapping !== 'object') {
      return requested
    }
    if (Object.prototype.hasOwnProperty.call(mapping, requested)) {
      return mapping[requested]
    }
    return requested
  }),
}))
jest.mock('../src/modules/relay/relay_upstream_error_helper.js', () => ({
  isTempUnavailable: jest.fn()
}))


describe('UnifiedOpenAIScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // clearAllMocks 不清 mockReturnValue 实现，显式复位默认值，避免跨用例泄漏
    openaiResponsesAccountService.isSubscriptionExpired.mockReturnValue(false)
    openaiResponsesAccountService.isAccountQuotaExceeded.mockReturnValue(false)
    openaiResponsesAccountService.checkAndClearRateLimit.mockResolvedValue(true)
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([])
    upstreamErrorHelper.isTempUnavailable.mockResolvedValue(false)
    openaiAccountService.getAccount.mockResolvedValue(null)
    openaiAccountService.getAllAccounts.mockResolvedValue([])
    openaiAccountService.isTokenExpired = jest.fn(() => false)
    openaiAccountService.refreshAccountToken = jest.fn().mockResolvedValue(undefined)
  })

  describe('markAccountRateLimited', () => {
    it('does not disable scheduling again when OpenAI-Responses auto protection is disabled', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'true'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.markAccountRateLimited).toHaveBeenCalledWith(
        'account-1',
        2
      )
      expect(openaiResponsesAccountService.updateAccount).not.toHaveBeenCalled()
    })

    it('keeps disabling scheduling for protected OpenAI-Responses accounts', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'false'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          schedulable: 'false'
        })
      )
    })
  })

  describe('_isAccountAvailable disableAutoProtection 守卫', () => {
    it('apikey 类开 disableAutoProtection：历史 status=error 仍可调度（修 review#1）', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'a1',
        isActive: 'true',
        status: 'error',
        schedulable: 'true',
        disableAutoProtection: 'true'
      })
      const ok = await unifiedOpenAIScheduler._isAccountAvailable('a1', 'openai-responses')
      expect(ok).toBe(true)
    })

    it('issue1: 手动 schedulable=false 即使开关开也不可调度', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'a1',
        isActive: 'true',
        status: 'active',
        schedulable: 'false',
        disableAutoProtection: 'true'
      })
      const ok = await unifiedOpenAIScheduler._isAccountAvailable('a1', 'openai-responses')
      expect(ok).toBe(false)
    })

    it('issue5: 预算超额(方案甲)即使开关开也不可调度', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'a1',
        isActive: 'true',
        status: 'active',
        schedulable: 'true',
        disableAutoProtection: 'true'
      })
      openaiResponsesAccountService.isAccountQuotaExceeded.mockReturnValue(true)
      const ok = await unifiedOpenAIScheduler._isAccountAvailable('a1', 'openai-responses')
      expect(ok).toBe(false)
    })

    it('开关关：status=error 仍被排除', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'a1',
        isActive: 'true',
        status: 'error',
        disableAutoProtection: 'false'
      })
      const ok = await unifiedOpenAIScheduler._isAccountAvailable('a1', 'openai-responses')
      expect(ok).toBe(false)
    })

    it('底线：手动停用账户(isActive=false)即使开关开也不可调度', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'a1',
        isActive: 'false',
        status: 'active',
        disableAutoProtection: 'true'
      })
      const ok = await unifiedOpenAIScheduler._isAccountAvailable('a1', 'openai-responses')
      expect(ok).toBe(false)
    })
  })

  describe('_getAllAvailableAccounts 选择阶段 disableAutoProtection 守卫', () => {
    it('刷新成功后使用新账户状态，不再被旧 status=error 挡掉', async () => {
      openaiAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'o1',
          name: 'o1',
          isActive: true,
          status: 'error',
          schedulable: 'true',
          accountType: 'shared',
          refreshToken: 'r1',
          supportedModels: []
        }
      ])
      openaiAccountService.isTokenExpired.mockReturnValueOnce(true).mockReturnValueOnce(false)
      openaiAccountService.getAccount.mockResolvedValue({
        id: 'o1',
        name: 'o1',
        isActive: true,
        status: 'active',
        schedulable: 'true',
        accountType: 'shared',
        refreshToken: 'r1',
        supportedModels: []
      })
      const accounts = await unifiedOpenAIScheduler._getAllAvailableAccounts({}, null)
      expect(openaiAccountService.refreshAccountToken).toHaveBeenCalledWith('o1')
      expect(accounts.map((a) => a.accountId)).toContain('o1')
    })

    it('apikey 开关 ON：历史 status=error 账户仍入选（修 review#1 fresh-selection 路径）', async () => {
      openaiAccountService.getAllAccounts.mockResolvedValue([])
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'r1',
          name: 'r1',
          isActive: 'true',
          status: 'error',
          schedulable: 'true',
          accountType: 'shared',
          disableAutoProtection: 'true'
        }
      ])
      openaiResponsesAccountService.isSubscriptionExpired.mockReturnValue(false)
      const accounts = await unifiedOpenAIScheduler._getAllAvailableAccounts({}, null)
      expect(accounts.map((a) => a.accountId)).toContain('r1')
    })

    it('issue1: 手动 schedulable=false 即使开关开也在选择阶段被排除', async () => {
      openaiAccountService.getAllAccounts.mockResolvedValue([])
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'r1',
          name: 'r1',
          isActive: 'true',
          status: 'active',
          schedulable: 'false',
          accountType: 'shared',
          disableAutoProtection: 'true'
        }
      ])
      openaiResponsesAccountService.isSubscriptionExpired.mockReturnValue(false)
      const accounts = await unifiedOpenAIScheduler._getAllAvailableAccounts({}, null)
      expect(accounts.map((a) => a.accountId)).not.toContain('r1')
    })

    it('issue5: 预算超额(方案甲)即使开关开也在选择阶段被排除', async () => {
      openaiAccountService.getAllAccounts.mockResolvedValue([])
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'r1',
          name: 'r1',
          isActive: 'true',
          status: 'error',
          schedulable: 'true',
          accountType: 'shared',
          disableAutoProtection: 'true'
        }
      ])
      openaiResponsesAccountService.isSubscriptionExpired.mockReturnValue(false)
      openaiResponsesAccountService.isAccountQuotaExceeded.mockReturnValue(true)
      const accounts = await unifiedOpenAIScheduler._getAllAvailableAccounts({}, null)
      expect(accounts.map((a) => a.accountId)).not.toContain('r1')
    })

    it('finding3: openai-responses 正常分支(开关关)预算超额也被排除（方案甲闭合）', async () => {
      openaiAccountService.getAllAccounts.mockResolvedValue([])
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'r1',
          name: 'r1',
          isActive: 'true',
          status: 'active',
          schedulable: 'true',
          accountType: 'shared',
          disableAutoProtection: 'false'
        }
      ])
      openaiResponsesAccountService.isSubscriptionExpired.mockReturnValue(false)
      openaiResponsesAccountService.isAccountQuotaExceeded.mockReturnValue(true)
      const accounts = await unifiedOpenAIScheduler._getAllAvailableAccounts({}, null)
      expect(accounts.map((a) => a.accountId)).not.toContain('r1')
    })

    it('开关关：status=error 账户在选择阶段被排除', async () => {
      openaiAccountService.getAllAccounts.mockResolvedValue([])
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'r1',
          name: 'r1',
          isActive: 'true',
          status: 'error',
          accountType: 'shared',
          disableAutoProtection: 'false'
        }
      ])
      const accounts = await unifiedOpenAIScheduler._getAllAvailableAccounts({}, null)
      expect(accounts.map((a) => a.accountId)).not.toContain('r1')
    })

    it('开关 ON 但订阅过期：仍被排除（订阅过期是本地约束，开关不覆盖）', async () => {
      openaiAccountService.getAllAccounts.mockResolvedValue([])
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'r1',
          name: 'r1',
          isActive: 'true',
          status: 'error',
          accountType: 'shared',
          disableAutoProtection: 'true'
        }
      ])
      openaiResponsesAccountService.isSubscriptionExpired.mockReturnValue(true)
      const accounts = await unifiedOpenAIScheduler._getAllAvailableAccounts({}, null)
      expect(accounts.map((a) => a.accountId)).not.toContain('r1')
    })
  })


  test('openai-responses allowedModels accepts mapped upstream model', () => {
    const account = {
      allowedModels: ['gpt-6-astra'],
      supportedModels: { 'gpt-6': 'gpt-6-astra' },
    }
    expect(unifiedOpenAIScheduler._isOpenAIModelSupported(account, 'openai-responses', 'gpt-6')).toBe(true)
    expect(unifiedOpenAIScheduler._isOpenAIModelSupported(account, 'openai-responses', 'gpt-6-astra')).toBe(true)
    expect(unifiedOpenAIScheduler._isOpenAIModelSupported(account, 'openai-responses', 'gpt-5.5')).toBe(false)
  })


  test('empty supportedModels json string without model is unrestricted', () => {
    const account = {
      supportedModels: '[]',
      allowedModels: '[]',
    }
    expect(unifiedOpenAIScheduler._isOpenAIModelSupported(account, 'openai', null)).toBe(true)
    expect(unifiedOpenAIScheduler._isOpenAIModelSupported(account, 'openai-responses', null)).toBe(true)
  })
})
