import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { normalizeAccountApiKeyUpdate } from '../src/modules/account/account_api_key_update.js'

let account
let memberships
const groupWrites = []
const updateAccount = jest.fn(async (_id, updates) => {
  normalizeAccountApiKeyUpdate(updates)
  Object.assign(account, updates)
  return { success: true }
})
const accountService = {
  getAccount: async () => ({ ...account }),
  updateAccount,
}
const groupService = {
  getAccountGroups: async () => [...memberships].map((id) => ({ id })),
  removeAccountFromGroup: async (_id, group) => {
    groupWrites.push(['remove', group])
    memberships.delete(group)
  },
  removeAccountFromAllGroups: async () => {
    groupWrites.push(['removeAll'])
    memberships.clear()
  },
  addAccountToGroup: async (_id, group) => {
    groupWrites.push(['add', group])
    memberships.add(group)
  },
  setAccountGroups: async (_id, next) => {
    groupWrites.push(['set', ...next])
    memberships = new Set(next)
  },
}
const modules = {
  '../src/infra/middleware_auth.js': { authenticateAdmin: (_req, _res, next) => next() },
  '../src/infra/redis.js': { redis: {} },
  '../src/common/logger.js': { logger: new Proxy({}, { get: () => jest.fn() }) },
  '../src/modules/account/account_group_service.js': { accountGroupService: groupService },
  '../src/modules/apikey/apikey_service.js': { apiKeyService: {} },
  '../src/modules/webhook/webhook_notifier.js': { webhookNotifier: {} },
  '../src/modules/relay/relay_claude_console_relay_service.js': { claudeConsoleRelayService: {} },
  '../src/modules/relay/relay_test_model_config_service.js': { testModelConfigService: {} },
  '../src/modules/relay/relay_test_prompt_config_service.js': { testPromptConfigService: {} },
  '../src/modules/account/account_openai_responses_service.js': { openaiResponsesAccountService: accountService },
  '../src/modules/account/account_claude_console_service.js': { claudeConsoleAccountService: accountService },
  '../src/modules/account/account_ccr_service.js': { ccrAccountService: accountService },
  '../src/modules/account/account_gemini_api_service.js': { geminiApiAccountService: accountService },
}
for (const [name, exports] of Object.entries(modules)) {
  await jest.unstable_mockModule(name, () => exports)
}

jest.useFakeTimers()
const cases = []
for (const [type, filename, mount, url] of [
  ['OpenAI Responses', 'account_openai_responses_routes.js', '/admin', '/admin/openai-responses-accounts/a'],
  ['Claude Console', 'account_claude_console_routes.js', '/admin', '/admin/claude-console-accounts/a'],
  ['CCR', 'account_ccr_routes.js', '/admin/ccr-accounts', '/admin/ccr-accounts/a'],
  ['Gemini API', 'account_gemini_api_routes.js', '/admin', '/admin/gemini-api-accounts/a'],
]) {
  const { router } = await import(`../src/modules/account/${filename}`)
  cases.push([type, express().use(express.json()).use(mount, router), url])
}
jest.clearAllTimers()
jest.useRealTimers()

beforeEach(() => {
  account = { id: 'a', name: 'fixture', accountType: 'group', apiKey: 'existing-fixture' }
  memberships = new Set(['original'])
  groupWrites.length = 0
  updateAccount.mockClear()
})

describe.each(cases)('%s Key validation precedes group writes', (_type, app, url) => {
  test.each(['***', 'abcd***efgh', '••••••', 42, {}])(
    'invalid credential %j cannot remove the original group or move to another group',
    async (apiKey) => {
      const original = { ...account }
      for (const scope of [
        { accountType: 'shared' },
        { accountType: 'group', groupId: 'new-group', groupIds: ['new-group'] },
      ]) {
        const response = await request(app)
          .put(url)
          .send({ ...scope, name: 'must-not-change', apiKey })
        expect(response.body.code).toBe(400)
        expect(account).toEqual(original)
        expect([...memberships]).toEqual(['original'])
        expect(groupWrites).toEqual([])
        expect(updateAccount).not.toHaveBeenCalled()
      }
    },
  )

  test.each(['', '  ', null, undefined])(
    'empty credential %j preserves the key during a valid group move',
    async (apiKey) => {
      const response = await request(app)
        .put(url)
        .send({ accountType: 'group', groupId: 'new-group', groupIds: ['new-group'], apiKey })
      expect(response.body.code).toBe(200)
      expect([...memberships]).toEqual(['new-group'])
      expect(account.apiKey).toBe('existing-fixture')
      expect(updateAccount).toHaveBeenCalledTimes(1)
      expect(Object.hasOwn(updateAccount.mock.calls[0][1], 'apiKey')).toBe(false)
    },
  )

  test('an explicit valid replacement and group move are both applied', async () => {
    const response = await request(app)
      .put(url)
      .send({ accountType: 'group', groupId: 'new-group', groupIds: ['new-group'], apiKey: '  new-fixture-key  ' })
    expect(response.body.code).toBe(200)
    expect([...memberships]).toEqual(['new-group'])
    expect(account.apiKey).toBe('new-fixture-key')
    expect(updateAccount).toHaveBeenCalledTimes(1)
  })

  test('a valid switch to shared still removes old group membership without changing the key', async () => {
    const response = await request(app).put(url).send({ accountType: 'shared' })
    expect(response.body.code).toBe(200)
    expect(account).toMatchObject({ accountType: 'shared', apiKey: 'existing-fixture' })
    expect([...memberships]).toEqual([])
  })
})
