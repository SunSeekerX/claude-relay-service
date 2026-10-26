import { jest } from '@jest/globals'
const evalScript = jest.fn()
const notify = jest.fn()
jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: { getClientSafe: () => ({ eval: evalScript, hget: async () => '测试账户' }) }
}))
jest.unstable_mockModule('../src/modules/webhook/webhook_notifier.js', () => ({
  webhookNotifier: { sendAccountAnomalyNotification: notify }
}))
const { recordAuthFailureAlert } = await import('../src/modules/relay/relay_auth_failure_alert.js')

beforeEach(() => {
  jest.clearAllMocks()
  notify.mockResolvedValue()
})
it('only dispatches the atomic threshold winner and includes no upstream credentials or body', async () => {
  evalScript.mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockResolvedValueOnce(0)
  await recordAuthFailureAlert('account-1', 'openai-responses')
  await recordAuthFailureAlert('account-1', 'openai-responses')
  await recordAuthFailureAlert('account-1', 'openai-responses')
  expect(notify).toHaveBeenCalledTimes(1)
  expect(notify.mock.calls[0][0]).toMatchObject({
    accountId: 'account-1',
    accountName: '测试账户',
    errorCode: 'UPSTREAM_AUTH_FAILURE_BURST'
  })
  expect(evalScript.mock.calls[0].slice(-3)).toEqual([5, 300, 900])
  expect(notify.mock.calls[0][0]).not.toHaveProperty('requestHeaders')
})
