import express from 'express'

import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, badRequest, notFound } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'
import * as azureOpenaiAccountService from './account_azure_openai_service.js'
import { bedrockAccountService } from './account_bedrock_service.js'
import { ccrAccountService } from './account_ccr_service.js'
import { claudeAccountService } from './account_claude_service.js'
import { claudeConsoleAccountService } from './account_claude_console_service.js'
import { droidAccountService } from './account_droid_service.js'
import * as geminiAccountService from './account_gemini_service.js'
import { grokAccountService } from './account_grok_service.js'
import * as openaiAccountService from './account_openai_service.js'
import { openaiResponsesAccountService } from './account_openai_responses_service.js'
import { accountGroupService } from './account_group_service.js'

export const router = express.Router()

const resolveMemberAccount = async (memberId, platform) => {
  if (platform === 'droid') {
    return droidAccountService.getAccount(memberId)
  }
  if (platform === 'grok') {
    return grokAccountService.getAccount(memberId)
  }
  if (platform === 'gemini' || platform === 'antigravity') {
    return geminiAccountService.getAccount(memberId)
  }
  if (platform === 'openai') {
    let account = await openaiAccountService.getAccount(memberId)
    if (!account) {
      account = await openaiResponsesAccountService.getAccount(memberId)
    }
    if (!account) {
      account = await azureOpenaiAccountService.getAccount(memberId)
    }
    return account
  }
  let account = await claudeAccountService.getAccount(memberId)
  if (!account) {
    account = await claudeConsoleAccountService.getAccount(memberId)
  }
  if (!account) {
    account = await bedrockAccountService.getAccount(memberId)
  }
  if (!account) {
    account = await ccrAccountService.getAccount(memberId)
  }
  return account
}

router.post(
  '/',
  authenticateAdmin,
  asyncRoute('Failed to create account group', async (req) => {
    try {
      return await accountGroupService.createGroup(parseObjectBody(req.body, '创建账户分组'))
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.get(
  '/',
  authenticateAdmin,
  asyncRoute('Failed to get account groups', async (req) => {
    const { platform } = req.query
    return accountGroupService.getAllGroups(platform)
  }),
)

router.get(
  '/:groupId',
  authenticateAdmin,
  asyncRoute('Failed to get account group', async (req) => {
    const group = await accountGroupService.getGroup(req.params.groupId)
    if (!group) {
      throw notFound('分组不存在')
    }
    return group
  }),
)

router.put(
  '/:groupId',
  authenticateAdmin,
  asyncRoute('Failed to update account group', async (req) => {
    try {
      return await accountGroupService.updateGroup(req.params.groupId, parseObjectBody(req.body, '更新账户分组'))
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.delete(
  '/:groupId',
  authenticateAdmin,
  asyncRoute('Failed to delete account group', async (req) => {
    try {
      await accountGroupService.deleteGroup(req.params.groupId)
      return ok(undefined, '分组删除成功')
    } catch (error) {
      throw badRequest(error.message)
    }
  }),
)

router.get(
  '/:groupId/members',
  authenticateAdmin,
  asyncRoute('Failed to get group members', async (req) => {
    const { groupId } = req.params
    const group = await accountGroupService.getGroup(groupId)
    if (!group) {
      throw notFound('分组不存在')
    }
    const memberIds = await accountGroupService.getGroupMembers(groupId)
    const members = []
    for (const memberId of memberIds) {
      let account = await resolveMemberAccount(memberId, group.platform)
      if (!account) {
        account = await claudeAccountService.getAccount(memberId)
      }
      if (!account) {
        account = await claudeConsoleAccountService.getAccount(memberId)
      }
      if (!account) {
        account = await bedrockAccountService.getAccount(memberId)
      }
      if (!account) {
        account = await ccrAccountService.getAccount(memberId)
      }
      if (!account) {
        account = await geminiAccountService.getAccount(memberId)
      }
      if (!account) {
        account = await openaiAccountService.getAccount(memberId)
      }
      if (!account) {
        account = await openaiResponsesAccountService.getAccount(memberId)
      }
      if (!account) {
        account = await azureOpenaiAccountService.getAccount(memberId)
      }
      if (!account) {
        account = await droidAccountService.getAccount(memberId)
      }
      if (!account) {
        account = await grokAccountService.getAccount(memberId)
      }
      if (account) {
        members.push(account)
      }
    }
    return members
  }),
)
