import express from 'express'
import axios from 'axios'
import { logger } from '../../common/logger.js'
import { config } from '../../../config/config.js'
import { authenticateApiKey } from '../../infra/middleware_auth.js'
import { unifiedOpenAIScheduler } from './relay_unified_openai_scheduler.js'
import * as openaiAccountService from '../account/account_openai_service.js'
import { openaiResponsesAccountService } from '../account/account_openai_responses_service.js'
import { openaiResponsesRelayService } from './relay_openai_responses_relay_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { redis } from '../../infra/redis.js'
import crypto from 'node:crypto'
import { proxyResolver } from '../proxy/proxy_resolver.js'
import { updateRateLimitCounters } from './relay_rate_limit_helper.js'
import { IncrementalSSEParser } from './relay_sse_parser.js'
import { getSafeMessage } from '../../common/error_sanitizer.js'
import { onClientDisconnect } from '../../common/client_disconnect.js'
import * as requestBodyRuleService from './relay_request_body_rule_service.js'
import { modelService } from '../pricing/pricing_model_service.js'
import { CodexCliValidator } from '../../common/validator_client_codex_cli_validator.js'
import * as upstreamErrorHelper from './relay_upstream_error_helper.js'
import { isAutoProtectionDisabled } from '../../common/common_helper.js'
import { filterForOpenAI, codexCriticalRequestHeaders, applyFilteredResponseHeaders } from './relay_header_filter.js'
import {
  buildTokenUsagePayload,
  createRequestDetailMeta,
  extractOpenAICacheReadTokens,
  resolveOpenAIServiceTier,
} from './relay_request_detail_helper.js'
import * as codexModelsManifest from './relay_codex_models_manifest.js'
import * as codexRealtime from './relay_codex_realtime.js'
import {
  sanitizeOpenAICapacityShedForClient,
  createCapacityShedSseRewriteStream,
} from './relay_openai_capacity_shed.js'
import {
  applyOpenAIServiceTierAlias,
  hasCompactionTrigger,
  normalizeCompactionTriggerBody,
  ensureRemoteCompactionV2BetaHeader,
} from './relay_openai_compact_v2.js'
import { normalizeCodexBootstrapBody } from './relay_codex_bootstrap_normalize.js'
import { applyOpenAIPublicModelAlias } from './relay_openai_model_alias.js'
import {
  isNonProtocolUpstreamBody,
  handleNonProtocolUpstream,
  extractBodyPreview,
} from './relay_upstream_protocol_guard.js'
import { buildClientError, extractSafeMessage, summarizeErrorForLog } from '../../common/client_error_builder.js'
export const openaiRoutes = express.Router()
// Codex CLI 系统提示词（非 Codex CLI 客户端请求时注入，统一端点也使用）
export const CODEX_CLI_INSTRUCTIONS =
  "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.\n\n## General\n\n- When searching for text or files, prefer using `rg`or `rg --files`respectively because `rg`is much faster than alternatives like `grep`. (If the `rg`command is not found, then use alternatives.)\n\n## Editing constraints\n\n- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.\n- Add succinct code comments that explain what is going on if code is not self-explanatory. You should not add comments like \"Assigns the value to the variable\", but a brief comment might be useful ahead of a complex code block that the user would otherwise have to spend time parsing out. Usage of these comments should be rare.\n- Try to use apply_patch for single file edits, but it is fine to explore other options to make the edit if it does not work well. Do not use apply_patch for changes that are auto-generated (i.e. generating package.json or running a lint or format command like gofmt) or when scripting is more efficient (such as search and replacing a string across a codebase).\n- You may be in a dirty git worktree.\n * NEVER revert existing changes you did not make unless explicitly requested, since these changes were made by the user.\n * If asked to make a commit or code edits and there are unrelated changes to your work or changes that you didn't make in those files, don't revert those changes.\n * If the changes are in files you've touched recently, you should read carefully and understand how you can work with the changes rather than reverting them.\n * If the changes are in unrelated files, just ignore them and don't revert them.\n- Do not amend a commit unless explicitly requested to do so.\n- While you are working, you might notice unexpected changes that you didn't make. If this happens, STOP IMMEDIATELY and ask the user how they would like to proceed.\n- **NEVER** use destructive commands like `git reset --hard`or `git checkout --`unless specifically requested or approved by the user.\n\n## Plan tool\n\nWhen using the planning tool:\n- Skip using the planning tool for straightforward tasks (roughly the easiest 25%).\n- Do not make single-step plans.\n- When you made a plan, update it after having performed one of the sub-tasks that you shared on the plan.\n\n## Codex CLI harness, sandboxing, and approvals\n\nThe Codex CLI harness supports several different configurations for sandboxing and escalation approvals that the user can choose from.\n\nFilesystem sandboxing defines which files can be read or written. The options for `sandbox_mode`are:\n- **read-only**: The sandbox only permits reading files.\n- **workspace-write**: The sandbox permits reading files, and editing files in `cwd`and `writable_roots`. Editing files in other directories requires approval.\n- **danger-full-access**: No filesystem sandboxing - all commands are permitted.\n\nNetwork sandboxing defines whether network can be accessed without approval. Options for `network_access`are:\n- **restricted**: Requires approval\n- **enabled**: No approval needed\n\nApprovals are your mechanism to get user consent to run shell commands without the sandbox. Possible configuration options for `approval_policy`are\n- **untrusted**: The harness will escalate most commands for user approval, apart from a limited allowlist of safe \"read\"commands.\n- **on-failure**: The harness will allow all commands to run in the sandbox (if enabled), and failures will be escalated to the user for approval to run again without the sandbox.\n- **on-request**: Commands will be run in the sandbox by default, and you can specify in your tool call if you want to escalate a command to run without sandboxing. (Note that this mode is not always available. If it is, you'll see parameters for it in the `shell`command description.)\n- **never**: This is a non-interactive mode where you may NEVER ask the user for approval to run commands. Instead, you must always persist and work around constraints to solve the task for the user. You MUST do your utmost best to finish the task and validate your work before yielding. If this mode is paired with `danger-full-access`, take advantage of it to deliver the best outcome for the user. Further, in this mode, your default testing philosophy is overridden: Even if you don't see local patterns for testing, you may add tests and scripts to validate your work. Just remove them before yielding.\n\nWhen you are running with `approval_policy == on-request`, and sandboxing enabled, here are scenarios where you'll need to request approval:\n- You need to run a command that writes to a directory that requires it (e.g. running tests that write to /var)\n- You need to run a GUI app (e.g., open/xdg-open/osascript) to open browsers or files.\n- You are running sandboxed and need to run a command that requires network access (e.g. installing packages)\n- If you run a command that is important to solving the user's query, but it fails because of sandboxing, rerun the command with approval. ALWAYS proceed to use the `with_escalated_permissions`and `justification`parameters - do not message the user before requesting approval for the command.\n- You are about to take a potentially destructive action such as an `rm`or `git reset`that the user did not explicitly ask for\n- (for all of these, you should weigh alternative paths that do not require approval)\n\nWhen `sandbox_mode`is set to read-only, you'll need to request approval for any command that isn't a read.\n\nYou will be told what filesystem sandboxing, network sandboxing, and approval mode are active in a developer or user message. If you are not told about this, assume that you are running with workspace-write, network sandboxing enabled, and approval on-failure.\n\nAlthough they introduce friction to the user because your work is paused until the user responds, you should leverage them when necessary to accomplish important work. If the completing the task requires escalated permissions, Do not let these settings or the sandbox deter you from attempting to accomplish the user's task unless it is set to \"never\", in which case never ask for approvals.\n\nWhen requesting approval to execute a command that will require escalated privileges:\n - Provide the `with_escalated_permissions`parameter with the boolean value true\n - Include a short, 1 sentence explanation for why you need to enable `with_escalated_permissions`in the justification parameter\n\n## Special user requests\n\n- If the user makes a simple request (such as asking for the time) which you can fulfill by running a terminal command (such as `date`), you should do so.\n- If the user asks for a \"review\", default to a code review mindset: prioritise identifying bugs, risks, behavioural regressions, and missing tests. Findings must be the primary focus of the response - keep summaries or overviews brief and only after enumerating the issues. Present findings first (ordered by severity with file/line references), follow with open questions or assumptions, and offer a change-summary only as a secondary detail. If no findings are discovered, state that explicitly and mention any residual risks or testing gaps.\n\n## Frontend tasks\nWhen doing frontend design tasks, avoid collapsing into \"AI slop\"or safe, average-looking layouts.\nAim for interfaces that feel intentional, bold, and a bit surprising.\n- Typography: Use expressive, purposeful fonts and avoid default stacks (Inter, Roboto, Arial, system).\n- Color & Look: Choose a clear visual direction; define CSS variables; avoid purple-on-white defaults. No purple bias or dark mode bias.\n- Motion: Use a few meaningful animations (page-load, staggered reveals) instead of generic micro-motions.\n- Background: Don't rely on flat, single-color backgrounds; use gradients, shapes, or subtle patterns to build atmosphere.\n- Overall: Avoid boilerplate layouts and interchangeable UI patterns. Vary themes, type families, and visual languages across outputs.\n- Ensure the page loads properly on both desktop and mobile\n\nException: If working within an existing website or design system, preserve the established patterns, structure, and visual language.\n\n## Presenting your work and final message\n\nYou are producing plain text that will later be styled by the CLI. Follow these rules exactly. Formatting should make results easy to scan, but not feel mechanical. Use judgment to decide how much structure adds value.\n\n- Default: be very concise; friendly coding teammate tone.\n- Ask only when needed; suggest ideas; mirror the user's style.\n- For substantial work, summarize clearly; follow final‑answer formatting.\n- Skip heavy formatting for simple confirmations.\n- Don't dump large files you've written; reference paths only.\n- No \"save/copy this file\" - User is on the same machine.\n- Offer logical next steps (tests, commits, build) briefly; add verify steps if you couldn't do something.\n- For code changes:\n * Lead with a quick explanation of the change, and then give more details on the context covering where and why a change was made. Do not start this explanation with \"summary\", just jump right in.\n * If there are natural next steps the user may want to take, suggest them at the end of your response. Do not make suggestions if there are no natural next steps.\n * When suggesting multiple options, use numeric lists for the suggestions so the user can quickly respond with a single number.\n- The user does not command execution outputs. When asked to show the output of a command (e.g. `git show`), relay the important details in your answer or summarize the key lines so the user understands the result.\n\n### Final answer structure and style guidelines\n\n- Plain text; CLI handles styling. Use structure only when it helps scanability.\n- Headers: optional; short Title Case (1-3 words) wrapped in **…**; no blank line before the first bullet; add only if they truly help.\n- Bullets: use - ; merge related points; keep to one line when possible; 4–6 per list ordered by importance; keep phrasing consistent.\n- Monospace: backticks for commands/paths/env vars/code ids and inline examples; use for literal keyword bullets; never combine with **.\n- Code samples or multi-line snippets should be wrapped in fenced code blocks; include an info string as often as possible.\n- Structure: group related bullets; order sections general → specific → supporting; for subsections, start with a bolded keyword bullet, then items; match complexity to the task.\n- Tone: collaborative, concise, factual; present tense, active voice; self‑contained; no \"above/below\"; parallel wording.\n- Don'ts: no nested bullets/hierarchies; no ANSI codes; don't cram unrelated keywords; keep keyword lists short—wrap/reformat if long; avoid naming formatting styles in answers.\n- Adaptation: code explanations → precise, structured with code refs; simple tasks → lead with outcome; big changes → logical walkthrough + rationale + next actions; casual one-offs → plain sentences, no headers/bullets.\n- File References: When referencing files in your response follow the below rules:\n * Use inline code to make file paths clickable.\n * Each reference should have a stand alone path. Even if it's the same file.\n * Accepted: absolute, workspace‑relative, a/ or b/ diff prefixes, or bare filename/suffix.\n * Optionally include line/column (1‑based): :line[:column] or #Lline[Ccolumn] (column defaults to 1).\n * Do not use URIs like file://, vscode://, or https://.\n * Do not provide range of lines\n * Examples: src/app.ts, src/app.ts:42, b/server/index.js#L10, C:\\repo\\project\\main.rs:12:5\n"

// 检查 API Key 是否具备 OpenAI 权限
const checkOpenAIPermissions = function checkOpenAIPermissions(apiKeyData) {
  return apiKeyService.hasPermission(apiKeyData?.permissions, 'openai')
}

const normalizeHeaders = function normalizeHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') {
    return {}
  }
  const normalized = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!key) {
      continue
    }
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value
  }
  return normalized
}

const toNumberSafe = function toNumberSafe(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

const extractCodexUsageHeaders = function extractCodexUsageHeaders(headers) {
  const normalized = normalizeHeaders(headers)
  if (!normalized || Object.keys(normalized).length === 0) {
    return null
  }

  const snapshot = {
    primaryUsedPercent: toNumberSafe(normalized['x-codex-primary-used-percent']),
    primaryResetAfterSeconds: toNumberSafe(normalized['x-codex-primary-reset-after-seconds']),
    primaryWindowMinutes: toNumberSafe(normalized['x-codex-primary-window-minutes']),
    secondaryUsedPercent: toNumberSafe(normalized['x-codex-secondary-used-percent']),
    secondaryResetAfterSeconds: toNumberSafe(normalized['x-codex-secondary-reset-after-seconds']),
    secondaryWindowMinutes: toNumberSafe(normalized['x-codex-secondary-window-minutes']),
    primaryOverSecondaryPercent: toNumberSafe(normalized['x-codex-primary-over-secondary-limit-percent']),
  }

  const hasData = Object.values(snapshot).some((value) => value !== null)
  return hasData ? snapshot : null
}

const isCompactResponsesRoute = function isCompactResponsesRoute(req) {
  return (
    req.path === '/responses/compact' ||
    req.path === '/v1/responses/compact' ||
    (req.originalUrl && req.originalUrl.includes('/responses/compact'))
  )
}

const isStandardResponsesRoute = function isStandardResponsesRoute(req) {
  if (req._fromUnifiedEndpoint) {
    return false
  }

  return req.path === '/responses' || req.path === '/v1/responses'
}

const getRequestFullPath = function getRequestFullPath(req) {
  return `${req.baseUrl || ''}${req.path || ''}${req.originalUrl || ''}`
}

// Codex 独立搜索：普通 JSON，非 SSE
const isCodexSearchRoute = function isCodexSearchRoute(req) {
  const full = getRequestFullPath(req)
  return full.includes('/alpha/search') || /\/search(\?|$)/.test(req.path || '')
}

// Codex Realtime/Live 建连 POST：返回 SDP + Location，后续靠 WebSocket sideband
// 官方路径：realtime/calls（V1/V2）与 live（FramelessBidi）
const isCodexRealtimeRoute = function isCodexRealtimeRoute(req) {
  const full = getRequestFullPath(req)
  return codexRealtime.isRealtimeHttpCreatePath(full) || codexRealtime.isRealtimeHttpCreatePath(req.path || '')
}

const getCodexCompatibleModel = function getCodexCompatibleModel(requestedModel = null) {
  const isCodexModel = typeof requestedModel === 'string' && requestedModel.toLowerCase().includes('codex')

  if (requestedModel && requestedModel.startsWith('gpt-5-') && !isCodexModel) {
    return 'gpt-5'
  }

  return requestedModel
}

const normalizeGpt5ModelForCodex = function normalizeGpt5ModelForCodex(body = {}) {
  const requestedModel = body?.model || null
  const compatibleModel = getCodexCompatibleModel(requestedModel)

  if (compatibleModel !== requestedModel) {
    logger.info(`Model ${requestedModel} detected, normalizing to gpt-5 for Codex API`)
    body.model = compatibleModel
  }

  return compatibleModel
}

const applyCodexCliAdaptation = function applyCodexCliAdaptation(body = {}, options = {}) {
  // 仅剥 OAuth Codex 后端不接受/会干扰的采样与安全字段
  // 保留 text（json_schema/verbosity）与 service_tier（priority/flex 计费档）
  // DEC_20260904_170000 instructions 仅 OAuth Codex 注入；API Key 永不注入
  const fieldsToRemove = [
    'temperature',
    'top_p',
    'max_output_tokens',
    'user',
    'text_formatting',
    'truncation',
    'prompt_cache_retention',
    'safety_identifier',
  ]

  fieldsToRemove.forEach((field) => {
    delete body[field]
  })

  const injectInstructions = options.injectInstructions === true
  if (injectInstructions) {
    body.instructions = CODEX_CLI_INSTRUCTIONS
  }

  applyOpenAIServiceTierAlias(body)
  // 公开别名不在选号前改写 body.model，避免覆盖账户映射键；出站阶段再归一
}

const applyRateLimitTracking = async function applyRateLimitTracking(
  req,
  usageSummary,
  model,
  context = '',
  accountType = null,
  preCalculatedCost = null,
) {
  if (!req.rateLimitInfo) {
    return
  }

  const label = context ? ` (${context})` : ''

  try {
    const { totalTokens, totalCost } = await updateRateLimitCounters(
      req.rateLimitInfo,
      usageSummary,
      model,
      req.apiKey?.id,
      accountType,
      preCalculatedCost,
    )

    if (totalTokens > 0) {
      logger.api(`Updated rate limit token count${label}: +${totalTokens} tokens`)
    }
    if (typeof totalCost === 'number' && totalCost > 0) {
      logger.api(`Updated rate limit cost count${label}: +$${totalCost.toFixed(6)}`)
    }
  } catch (error) {
    logger.error(`Failed to update rate limit counters${label}:`, error)
  }
}

// 使用统一调度器选择 OpenAI 账户
const getOpenAIAuthToken = async function getOpenAIAuthToken(apiKeyData, sessionId = null, requestedModel = null) {
  try {
    // 生成会话哈希（如果有会话ID）
    const sessionHash = sessionId ? crypto.createHash('sha256').update(sessionId).digest('hex') : null

    // 使用统一调度器选择账户
    const result = await unifiedOpenAIScheduler.selectAccountForApiKey(apiKeyData, sessionHash, requestedModel)

    if (!result || !result.accountId) {
      const error = new Error('No available OpenAI account found')
      error.statusCode = 402 // Payment Required - 资源耗尽
      throw error
    }

    // 根据账户类型获取账户详情
    let account,
      accessToken,
      proxy = null

    if (result.accountType === 'openai-responses') {
      // 处理 OpenAI-Responses 账户
      account = await openaiResponsesAccountService.getAccount(result.accountId)
      if (!account || !account.apiKey) {
        const error = new Error(`OpenAI-Responses account ${result.accountId} has no valid apiKey`)
        error.statusCode = 403 // Forbidden - 账户配置错误
        throw error
      }

      // OpenAI-Responses 账户不需要 accessToken，直接返回账户信息
      accessToken = null // OpenAI-Responses 使用账户内的 apiKey

      // 解析代理配置
      if (account.proxy) {
        try {
          proxy = typeof account.proxy === 'string' ? JSON.parse(account.proxy) : account.proxy
        } catch (e) {
          logger.warn('Failed to parse proxy configuration:', e)
        }
      }

      logger.info(`Selected OpenAI-Responses account: ${account.name} (${result.accountId})`)
    } else {
      // 处理普通 OpenAI 账户
      account = await openaiAccountService.getAccount(result.accountId)
      if (!account || !account.accessToken) {
        const error = new Error(`OpenAI account ${result.accountId} has no valid accessToken`)
        error.statusCode = 403 // Forbidden - 账户配置错误
        throw error
      }

      // 检查 token 是否过期并自动刷新（双重保护）
      if (openaiAccountService.isTokenExpired(account)) {
        if (account.refreshToken) {
          logger.info(`Token expired, auto-refreshing for account ${account.name} (fallback)`)
          try {
            await openaiAccountService.refreshAccountToken(result.accountId)
            // 重新获取更新后的账户
            account = await openaiAccountService.getAccount(result.accountId)
            logger.info(`Token refreshed successfully in route handler`)
          } catch (refreshError) {
            logger.error(`Failed to refresh token for ${account.name}:`, refreshError)
            const error = new Error(`Token expired and refresh failed: ${refreshError.message}`)
            error.statusCode = 403 // Forbidden - 认证失败
            throw error
          }
        } else {
          const error = new Error(`Token expired and no refresh token available for account ${account.name}`)
          error.statusCode = 403 // Forbidden - 认证失败
          throw error
        }
      }

      // 解密 accessToken（account.accessToken 是加密的）
      accessToken = openaiAccountService.decrypt(account.accessToken)
      if (!accessToken) {
        const error = new Error('Failed to decrypt OpenAI accessToken')
        error.statusCode = 403 // Forbidden - 配置/权限错误
        throw error
      }

      // 解析代理配置
      if (account.proxy) {
        try {
          proxy = typeof account.proxy === 'string' ? JSON.parse(account.proxy) : account.proxy
        } catch (e) {
          logger.warn('Failed to parse proxy configuration:', e)
        }
      }

      logger.info(`Selected OpenAI account: ${account.name} (${result.accountId})`)
    }

    return {
      accessToken,
      accountId: result.accountId,
      accountName: account.name,
      accountType: result.accountType,
      proxy,
      account,
    }
  } catch (error) {
    logger.error('Failed to get OpenAI auth token:', error)
    throw error
  }
}

// 主处理函数，供两个路由共享
export const handleResponses = async (req, res) => {
  let upstream = null
  let accountId = null
  let accountType = 'openai'
  let sessionHash = null
  let account
  let accessToken
  let proxyResolution = null
  let upstreamAbort = null
  let detachUpstreamAbort = () => {}

  try {
    // 从中间件获取 API Key 数据
    const apiKeyData = req.apiKey || {}

    if (!checkOpenAIPermissions(apiKeyData)) {
      logger.security(`API Key ${apiKeyData.id || 'unknown'} 缺少 OpenAI 权限，拒绝访问 ${req.originalUrl}`)
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access OpenAI',
          type: 'permission_denied',
          code: 'permission_denied',
        },
      })
    }

    // 是否为 Codex 客户端：与 CodexCliValidator 单一契约同源
    // （UA+originator；responses 路径还要求 session-id）
    // 识别为 Codex 时跳过适配改包，原样转发
    const isCodexCLI = CodexCliValidator.isCodexClientRequest(req)

    const standardResponsesRoute = isStandardResponsesRoute(req)
    const compactRoute = isCompactResponsesRoute(req)
    const shouldUseToggleControlledFlow = standardResponsesRoute && !compactRoute

    // OAuth Codex（chatgpt backend-api）才允许注入 CLI instructions；openai-responses API Key 永不注入
    const requestPath = `${req.baseUrl || ''}${req.originalUrl || ''}${req.path || ''}`
    const isOauthCodexRoute = requestPath.includes('/backend-api/codex')
    const compactV2 = hasCompactionTrigger(req.body)
    if (compactV2) {
      normalizeCompactionTriggerBody(req.body)
      req._crsCompactV2 = true
      logger.info('Detected Responses compact v2 (compaction_trigger)')
    }

    if (shouldUseToggleControlledFlow) {
      const shouldApplyCodexAdaptation = apiKeyData.enableOpenAIResponsesCodexAdaptation === true && !isCodexCLI
      const shouldApplyPayloadRules = apiKeyData.enableOpenAIResponsesPayloadRules === true

      if (shouldApplyCodexAdaptation) {
        normalizeGpt5ModelForCodex(req.body)
        // API Key 标准 responses：只剥字段 + tier 别名，不注入 Codex system prompt
        applyCodexCliAdaptation(req.body, { injectInstructions: false })
        logger.info('Standard Responses request applied Codex CLI adaptation (no instructions inject)')
      } else if (isCodexCLI) {
        applyOpenAIServiceTierAlias(req.body)
        logger.info('Codex CLI request detected, forwarding current payload')
      } else {
        applyOpenAIServiceTierAlias(req.body)
        logger.info('Standard Responses request is passing through without Codex adaptation')
      }

      if (shouldApplyPayloadRules) {
        req.body = requestBodyRuleService.applyRules(req.body, apiKeyData.openaiResponsesPayloadRules)
        logger.info('Standard Responses request applied API key payload rules')
      }
    } else {
      normalizeGpt5ModelForCodex(req.body)

      if (!isCodexCLI && !req._fromUnifiedEndpoint) {
        const injectInstructions =
          isOauthCodexRoute && !compactRoute && !isCodexSearchRoute(req) && !isCodexRealtimeRoute(req)
        applyCodexCliAdaptation(req.body, { injectInstructions })
        logger.info(
          `Non-Codex CLI request adaptation injectInstructions=${injectInstructions} oauthRoute=${isOauthCodexRoute}`,
        )
      } else {
        applyOpenAIServiceTierAlias(req.body)
        logger.info('Codex CLI request detected, forwarding as-is')
      }
    }

    // 计费档取「出站实际值」：改包后读；fast 已归一 priority
    // （旧注释写 adaptation 会删 service_tier 已过时，现保留 tier）
    req._serviceTier = req.body?.service_tier || null

    // Codex delegation / automation bootstrap：无 call_id 启动引导 → user message
    // DEC_20260904_173000 对齐 sub2api，HTTP Responses 出站前归一
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      const bootstrap = normalizeCodexBootstrapBody(req.body)
      if (bootstrap.changed) {
        req.body = bootstrap.body
        logger.info(`Codex bootstrap normalized kinds=${bootstrap.kinds.join(',')} path=${req.originalUrl || req.path}`)
      }
      // 保留客户端原始 model 供选号/映射；出站前再 applyOpenAIPublicModelAlias
      req._crsClientModel = typeof req.body.model === 'string' && req.body.model.trim() ? req.body.model.trim() : null
    }

    // 从最终请求体中提取模型、会话 ID 和流式标志
    // 官方 Codex 头是 session-id / thread-id；兼容历史 session_id / x-session-id
    // NOTE: For some clients, prompt_cache_key is the only stable per-session key.
    const sessionId =
      req.headers['session-id'] ||
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      req.headers['thread-id'] ||
      req.body?.session_id ||
      req.body?.conversation_id ||
      req.body?.prompt_cache_key ||
      null

    sessionHash = sessionId ? crypto.createHash('sha256').update(sessionId).digest('hex') : null

    const requestedModel = req.body?.model || null
    // 选号用客户端原始 model，避免公开别名归一破坏账户映射键（gpt-6 → deployment-x）
    // 公开别名由调度白名单候选 + 出站 applyOpenAIPublicModelAlias 处理
    const schedulerModel = getCodexCompatibleModel(requestedModel) || requestedModel
    const searchRoute = isCodexSearchRoute(req)
    const realtimeRoute = isCodexRealtimeRoute(req)
    // responses 默认流式；search/realtime 官方为非 SSE
    const isStream = searchRoute || realtimeRoute ? false : req.body?.stream !== false

    if (schedulerModel !== requestedModel) {
      logger.info(`Using Codex-compatible model ${schedulerModel} for account selection (requested: ${requestedModel})`)
    }

    // 使用调度器选择账户
    ;({ accessToken, accountId, accountType, account } = await getOpenAIAuthToken(
      apiKeyData,
      sessionId,
      schedulerModel,
    ))

    // 失败明细采集：OAuth/Responses 选号后挂账户上下文
    req._crsAccountId = accountId || account?.id || null
    req._crsAccountType = accountType || null
    if (req.body && typeof req.body.model === 'string') {
      req._crsRequestedModel = req.body.model
    }

    // Codex search / realtime 是 ChatGPT OAuth 协议面，openai-responses（第三方 JSON API）不能承接
    if (accountType === 'openai-responses') {
      if (searchRoute || realtimeRoute) {
        logger.warn(`openai-responses account cannot serve Codex ${searchRoute ? 'search' : 'realtime'}`)
        return res.status(400).json({
          error: {
            message: 'Codex search/realtime requires an OpenAI OAuth (ChatGPT) account, not openai-responses',
            type: 'invalid_request_error',
            code: 'unsupported_account_type',
          },
        })
      }
      logger.info(`Using OpenAI-Responses relay service for account: ${account.name}`)
      return await openaiResponsesRelayService.handleRequest(req, res, account, apiKeyData)
    }

    // OAuth Codex：仅做 gpt-5-* → gpt-5 兼容缩名；公开别名在出站阶段再套
    if (schedulerModel !== requestedModel && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      logger.info(
        `Standard Responses request normalized model ${requestedModel} -> ${schedulerModel} for OpenAI Codex backend`,
      )
      req.body.model = schedulerModel
    }

    const upstreamRequestedModel = req.body?.model || requestedModel

    // 出站头：黑名单过滤 + 强制补齐 Codex 关键头（含 x-client-request-id / x-openai-subagent）
    const incoming = req.headers || {}
    const headers = filterForOpenAI(incoming)

    // 统一补官方 session-id
    if (headers['session-id'] === undefined) {
      if (incoming['session-id'] !== undefined) {
        headers['session-id'] = incoming['session-id']
      } else if (incoming.session_id !== undefined) {
        headers['session-id'] = incoming.session_id
      } else if (incoming['x-session-id'] !== undefined) {
        headers['session-id'] = incoming['x-session-id']
      }
    }

    // 确保关键头不因大小写丢失
    for (const key of codexCriticalRequestHeaders) {
      if (headers[key] === undefined && incoming[key] !== undefined) {
        headers[key] = incoming[key]
      }
    }

    // compact v2：仅 compaction_trigger 路径补 remote_compaction_v2；legacy compact 不注入
    // DEC_20260905_155232
    if (req._crsCompactV2) {
      Object.assign(headers, ensureRemoteCompactionV2BetaHeader(headers))
    }

    headers['authorization'] = `Bearer ${accessToken}`
    headers['chatgpt-account-id'] =
      headers['chatgpt-account-id'] || account.accountId || account.chatgptUserId || accountId
    headers['host'] = 'chatgpt.com'

    if (realtimeRoute) {
      // Realtime 建连：保留客户端 content-type（application/sdp 或 multipart）
      const ct = incoming['content-type'] || incoming['Content-Type']
      if (ct) {
        headers['content-type'] = ct
      }
      headers['accept'] = incoming.accept || incoming.Accept || '*/*'
    } else {
      headers['accept'] = isStream ? 'text/event-stream' : 'application/json'
      headers['content-type'] = 'application/json'
    }

    // store 仅对 responses 有意义
    if (!searchRoute && !realtimeRoute) {
      if (!compactRoute) {
        if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
          req.body['store'] = false
        }
      } else if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'store')) {
        delete req.body['store']
      }
    }

    // 选号后出站：公开别名归一（不覆盖账户映射；oauth 路径无映射）
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      applyOpenAIPublicModelAlias(req.body, {
        originalModel: req._crsClientModel || requestedModel || null,
      })
    }

    // 创建代理 agent（保留 proxyId/contextKey 供被动健康检查上报）
    proxyResolution = proxyResolver.resolveAgent(account, 'codex')
    const proxyAgent = proxyResolution.agent

    // 断开即停止上游工作：signal 必须在发请求前就绪，否则等上游响应头期间断开无法中止，
    // 那条上游请求会一直挂到上游返回或 timeout(默认 600s)。同一个 controller 供下方流式 cleanup 复用
    upstreamAbort = new AbortController()
    // 流式：断连不 abort，继续 drain 收 response.completed.usage（对齐 openai-responses / sub2api）
    // 非流式：断连立即 abort 上游
    let streamClientGone = false
    detachUpstreamAbort = onClientDisconnect(
      res,
      () => {
        if (isStream) {
          streamClientGone = true
          logger.info('Codex client disconnected during stream; draining upstream for usage')
          return
        }
        upstreamAbort.abort()
      },
      'Codex upstream request',
    )

    // 配置请求选项
    const axiosConfig = {
      headers,
      timeout: config.requestTimeout || 600000,
      validateStatus: () => true,
      signal: upstreamAbort.signal,
    }

    // 如果有代理，添加代理配置
    if (proxyAgent) {
      axiosConfig.httpAgent = proxyAgent
      axiosConfig.httpsAgent = proxyAgent
      axiosConfig.proxy = false
      logger.info('Using proxy for OpenAI request')
    } else {
      logger.debug('No proxy configured for OpenAI request')
    }

    // 按请求路径选择 Codex 上游端点（官方并集：responses/compact/search/realtime）
    const resolveCodexUpstreamUrl = () => {
      const fullPath = `${req.baseUrl || ''}${req.path || ''}`
      if (compactRoute || fullPath.includes('/responses/compact')) {
        return 'https://chatgpt.com/backend-api/codex/responses/compact'
      }
      if (fullPath.includes('/alpha/search') || fullPath.endsWith('/search')) {
        return 'https://chatgpt.com/backend-api/codex/alpha/search'
      }
      if (
        fullPath.includes('/realtime/calls') ||
        fullPath.includes('/v1/realtime') ||
        fullPath.includes('/v1/live') ||
        fullPath.endsWith('/live')
      ) {
        // ChatGPT OAuth 建连统一走 backend realtime/calls（CLIProxy/sub2api 同）
        return 'https://chatgpt.com/backend-api/codex/realtime/calls'
      }
      return 'https://chatgpt.com/backend-api/codex/responses'
    }
    const codexEndpoint = resolveCodexUpstreamUrl()

    // 请求体：realtime 可能是 SDP raw / multipart；search 与 responses 为 JSON
    let outboundBody = req.body
    if (realtimeRoute) {
      if (Buffer.isBuffer(req.rawBody)) {
        outboundBody = req.rawBody
      } else if (req.body && Buffer.isBuffer(req.body._sdpRaw)) {
        outboundBody = req.body._sdpRaw
      } else if (typeof req.body === 'string') {
        outboundBody = req.body
      }
    }

    if (isStream) {
      upstream = await axios.post(codexEndpoint, outboundBody, {
        ...axiosConfig,
        responseType: 'stream',
      })
    } else {
      upstream = await axios.post(codexEndpoint, outboundBody, {
        ...axiosConfig,
        responseType: realtimeRoute ? 'arraybuffer' : 'json',
        // realtime 需要原始状态码/头（含 Location）
        maxRedirects: 0,
      })
    }

    // 被动健康检查：拿到 HTTP 响应即代理传输成功（含 429/4xx/5xx，不归咎代理）
    proxyResolver.report(proxyResolution.proxyId, proxyResolution.contextKey, null)

    // DEC_20260905_194420 上游响应头挂 req，request detail 可落 upstreamRequestId
    if (req && typeof req === 'object') {
      req._crsUpstreamHeaders = upstream.headers || null
      req._crsUpstreamRequestIdHeader =
        account?.upstreamRequestIdHeader || account?.extra?.upstreamRequestIdHeader || null
    }

    const codexUsageSnapshot = extractCodexUsageHeaders(upstream.headers)
    if (codexUsageSnapshot) {
      try {
        await openaiAccountService.updateCodexUsageSnapshot(accountId, codexUsageSnapshot)
      } catch (codexError) {
        logger.error('更新 Codex 使用统计失败:', codexError)
      }
    }

    // 非协议体（HTML/纯文本网关错页等）：断 sticky，避免坏会话连打
    if (upstream.status >= 400) {
      try {
        const preview = await extractBodyPreview(upstream.data, 2048)
        const contentType = upstream.headers?.['content-type'] || upstream.headers?.['Content-Type']
        if (
          isNonProtocolUpstreamBody({
            statusCode: upstream.status,
            contentType,
            bodyText: preview,
          })
        ) {
          const oaiAutoOff = isAutoProtectionDisabled(account)
          await handleNonProtocolUpstream({
            accountId,
            accountType: 'openai',
            sessionHash,
            statusCode: upstream.status,
            disableAutoProtection: oaiAutoOff,
            errorContext: upstreamErrorHelper.buildErrorContext({
              url: codexEndpoint,
              method: 'POST',
              requestHeaders: headers,
              requestBody: outboundBody,
              model: upstreamRequestedModel,
              sessionId: sessionHash,
              responseStatus: upstream.status,
              responseHeaders: upstream.headers,
              responseBody: preview,
            }),
            clearSticky: sessionHash ? () => unifiedOpenAIScheduler._deleteSessionMapping(sessionHash) : null,
          })
        }
      } catch (guardError) {
        console.error(guardError)
        logger.warn('[Codex] non-protocol guard failed:', guardError.message)
      }
    }

    // 处理 429 限流错误
    if (upstream.status === 429) {
      logger.warn(`Rate limit detected for OpenAI account ${accountId} (Codex API)`)

      // 解析响应体中的限流信息
      let resetsInSeconds = null
      let errorData = null

      try {
        // 对于429错误，无论是否是流式请求，响应都会是完整的JSON错误对象
        if (isStream && upstream.data) {
          // 流式响应需要先收集数据
          const chunks = []
          await new Promise((resolve, reject) => {
            upstream.data.on('data', (chunk) => chunks.push(chunk))
            upstream.data.on('end', resolve)
            upstream.data.on('error', reject)
            // 设置超时防止无限等待
            setTimeout(resolve, 5000)
          })

          const fullResponse = Buffer.concat(chunks).toString()
          try {
            errorData = JSON.parse(fullResponse)
          } catch (e) {
            logger.error('Failed to parse 429 error response:', e)
            // 禁止日志打上游原文
            // DEC_20260905_162636
            logger.debug('Raw 429 response preview:', extractSafeMessage(fullResponse) || '(empty)')
          }
        } else {
          // 非流式响应直接使用data
          errorData = upstream.data
        }

        // 提取重置时间
        if (errorData && errorData.error && errorData.error.resets_in_seconds) {
          resetsInSeconds = errorData.error.resets_in_seconds
          logger.info(
            `Codex rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes / ${Math.ceil(resetsInSeconds / 3600)} hours)`,
          )
        } else {
          logger.warn('Could not extract resets_in_seconds from 429 response, using default 60 minutes')
        }
      } catch (e) {
        logger.error('Failed to parse rate limit error:', e)
      }

      // 标记账户为限流状态（账户层在关闭自动防护时会跳过暂停，但历史必须写）
      await unifiedOpenAIScheduler.markAccountRateLimited(accountId, 'openai', sessionHash, resetsInSeconds)
      await upstreamErrorHelper
        .markTempUnavailable(
          accountId,
          'openai',
          429,
          resetsInSeconds,
          upstreamErrorHelper.buildErrorContext({
            url: codexEndpoint,
            method: 'POST',
            requestHeaders: headers,
            requestBody: outboundBody,
            model: upstreamRequestedModel,
            sessionId: sessionHash,
            responseStatus: 429,
            responseHeaders: upstream.headers,
            responseBody: errorData,
          }),
        )
        .catch(() => {})

      // 返回错误响应给客户端：buildClientError 脱敏，禁止 errorData 原文
      // DEC_20260905_161107
      const clientError = buildClientError({
        statusCode: 429,
        protocol: 'openai',
        upstreamBody: errorData,
        retryAfterSeconds: resetsInSeconds,
      })
      {
        const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
        const clientErrorBody = sanitized.payload
        if (isStream) {
          res.status(clientError.statusCode)
          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          res.write(`data: ${JSON.stringify(clientErrorBody)}\n\n`)
          res.end()
        } else {
          res.status(clientError.statusCode).json(clientErrorBody)
        }
      }

      return
    } else if (upstream.status === 401 || upstream.status === 402) {
      const unauthorizedStatus = upstream.status
      const statusDescription = unauthorizedStatus === 401 ? 'Unauthorized' : 'Payment required'
      logger.warn(`${statusDescription} error detected for OpenAI account ${accountId} (Codex API)`)

      let errorData = null

      try {
        if (isStream && upstream.data && typeof upstream.data.on === 'function') {
          const chunks = []
          await new Promise((resolve, reject) => {
            upstream.data.on('data', (chunk) => chunks.push(chunk))
            upstream.data.on('end', resolve)
            upstream.data.on('error', reject)
            setTimeout(resolve, 5000)
          })

          const fullResponse = Buffer.concat(chunks).toString()
          try {
            errorData = JSON.parse(fullResponse)
          } catch (parseError) {
            logger.error(`Failed to parse ${unauthorizedStatus} error response:`, parseError)
            logger.debug(`Raw ${unauthorizedStatus} response preview:`, extractSafeMessage(fullResponse) || '(empty)')
            errorData = { error: { message: 'Unauthorized' } }
          }
        } else {
          errorData = upstream.data
        }
      } catch (parseError) {
        logger.error(`Failed to handle ${unauthorizedStatus} error response:`, parseError)
      }

      const statusLabel = unauthorizedStatus === 401 ? '401错误' : '402错误'
      const extraHint = unauthorizedStatus === 402 ? '，可能欠费' : ''
      let reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）`
      if (errorData) {
        const messageCandidate = extractSafeMessage(errorData)
        if (messageCandidate) {
          reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${messageCandidate}`
        }
      }

      try {
        await unifiedOpenAIScheduler.markAccountUnauthorized(accountId, 'openai', sessionHash, reason)
      } catch (markError) {
        logger.error(`Failed to mark OpenAI account unauthorized after ${unauthorizedStatus}:`, markError)
      }
      // 关闭自动防护时 markAccountUnauthorized 会跳过，仍必须记详细错误历史
      await upstreamErrorHelper
        .markTempUnavailable(
          accountId,
          'openai',
          unauthorizedStatus,
          null,
          upstreamErrorHelper.buildErrorContext({
            url: codexEndpoint,
            method: 'POST',
            requestHeaders: headers,
            requestBody: outboundBody,
            model: upstreamRequestedModel,
            sessionId: sessionHash,
            responseStatus: unauthorizedStatus,
            responseHeaders: upstream.headers,
            responseBody: errorData,
            message: reason,
          }),
        )
        .catch(() => {})

      // 401/402 出站：buildClientError 脱敏，禁止 errorData 原文
      // DEC_20260905_161107
      const clientError = buildClientError({
        statusCode: unauthorizedStatus,
        protocol: 'openai',
        upstreamBody: errorData,
      })
      {
        const sanitizedAuth = sanitizeOpenAICapacityShedForClient(clientError.body)
        res.status(clientError.statusCode).json(sanitizedAuth.payload)
      }
      return
    } else if (upstream.status === 200 || upstream.status === 201) {
      // 请求成功，检查并移除限流状态
      const isRateLimited = await unifiedOpenAIScheduler.isAccountRateLimited(accountId)
      if (isRateLimited) {
        logger.info(`Removing rate limit for OpenAI account ${accountId} after successful request`)
        await unifiedOpenAIScheduler.removeAccountRateLimit(accountId, 'openai')
      }
    }

    res.status(upstream.status)

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
    } else if (realtimeRoute) {
      // Realtime：保留上游 Content-Type（通常 application/sdp）与改写后的 Location
      const upCt = upstream.headers?.['content-type']
      if (upCt) {
        res.setHeader('Content-Type', upCt)
      }
      const upstreamLocation = upstream.headers?.location || upstream.headers?.Location
      const callId = codexRealtime.extractCallIdFromLocation(upstreamLocation)
      if (callId) {
        const clientPath = `${req.baseUrl || ''}${req.path || ''}` || req.originalUrl || ''
        const clientLocation = codexRealtime.rewriteClientLocation(clientPath, callId)
        if (clientLocation) {
          res.setHeader('Location', clientLocation)
        }
        // sideband 必须打同一 OAuth 号
        codexRealtime
          .bindRealtimeCallAccount(callId, accountId, {
            apiKeyId: apiKeyData?.id || null,
            chatgptAccountId: account?.accountId || account?.chatgptUserId || null,
            model:
              (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && req.body.model) ||
              req.query?.model ||
              'gpt-realtime',
          })
          .catch((e) => console.error(e))
      } else if (upstreamLocation) {
        // 抽不出 call_id 时原样透传，避免彻底丢头
        res.setHeader('Location', upstreamLocation)
      }
      applyFilteredResponseHeaders(res, upstream.headers)
    } else if (searchRoute) {
      res.setHeader('Content-Type', upstream.headers?.['content-type'] || 'application/json')
      applyFilteredResponseHeaders(res, upstream.headers)
    } else {
      res.setHeader('Content-Type', 'application/json')
    }

    // 透传关键诊断头
    const passThroughHeaderKeys = ['openai-version', 'x-request-id', 'openai-processing-ms']
    for (const key of passThroughHeaderKeys) {
      const val = upstream.headers?.[key]
      if (val !== undefined) {
        res.setHeader(key, val)
      }
    }

    if (isStream) {
      // 立即刷新响应头，开始 SSE
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders()
      }
    }

    // 处理响应并捕获 usage 数据和真实的 model
    let usageData = null
    let actualModel = null
    // 上游实际生效的 service_tier（response.completed 回包里带），供计费定档
    let streamServiceTierFromUpstream = null
    let usageReported = false
    let rateLimitDetected = false
    let rateLimitResetsInSeconds = null
    let rateLimitErrorData = null

    if (!isStream) {
      // 非流式响应处理（含 Codex search JSON、realtime SDP）
      try {
        const responseData = upstream.data

        // search / realtime：不走 responses usage 计费，按上游形状原样返回
        if (searchRoute || realtimeRoute) {
          detachUpstreamAbort()
          if (realtimeRoute) {
            const raw = Buffer.isBuffer(responseData)
              ? responseData
              : typeof responseData === 'string'
                ? Buffer.from(responseData)
                : Buffer.from(
                    typeof responseData === 'object' && responseData !== null
                      ? JSON.stringify(responseData)
                      : String(responseData ?? ''),
                  )
            res.end(raw)
            return
          }
          // alpha/search：普通 JSON
          if (Buffer.isBuffer(responseData)) {
            try {
              res.json(JSON.parse(responseData.toString('utf8')))
            } catch {
              res.end(responseData)
            }
            return
          }
          res.json(responseData)
          return
        }

        logger.info(`Processing OpenAI non-stream response for model: ${upstreamRequestedModel}`)

        // 从响应中获取实际的 model 和 usage（仅 responses 类 JSON）
        actualModel =
          (responseData && typeof responseData === 'object' && responseData.model) || upstreamRequestedModel || 'gpt-4'
        usageData = responseData && typeof responseData === 'object' ? responseData.usage : null

        logger.debug(`Non-stream response - Model: ${actualModel}, Usage:`, usageData)

        // 记录使用统计
        if (usageData) {
          const totalInputTokens = usageData.input_tokens || usageData.prompt_tokens || 0
          const outputTokens = usageData.output_tokens || usageData.completion_tokens || 0
          const cacheReadTokens = extractOpenAICacheReadTokens(usageData)
          // 计算实际输入token（总输入减去缓存部分）
          const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

          // 实际生效档以上游回包为准（请求 auto 时上游才定档），请求体兜底
          const nonStreamServiceTier = resolveOpenAIServiceTier(
            responseData?.service_tier ?? responseData?.response?.service_tier,
            req._serviceTier,
          )
          const nonStreamCosts = await apiKeyService.recordUsage(
            apiKeyData.id,
            buildTokenUsagePayload({
              inputTokens: actualInputTokens, // 实际输入（不含缓存）
              outputTokens,
              cacheReadTokens,
              rawUsage: usageData,
            }),
            actualModel,
            accountId,
            'openai',
            nonStreamServiceTier,
            createRequestDetailMeta(req, {
              requestBody: req.body,
              stream: false,
              statusCode: upstream.status,
            }),
          )

          logger.info(
            `Recorded OpenAI non-stream usage - Input: ${totalInputTokens}(actual:${actualInputTokens}+cached:${cacheReadTokens}), Output: ${outputTokens}, Total: ${usageData.total_tokens || totalInputTokens + outputTokens}, Model: ${actualModel}`,
          )

          await applyRateLimitTracking(
            req,
            {
              inputTokens: actualInputTokens,
              outputTokens,
              cacheCreateTokens: 0,
              cacheReadTokens,
            },
            actualModel,
            'openai-non-stream',
            'openai',
            nonStreamCosts,
          )
        }

        // 返回响应（search/realtime 已在上方 early-return）
        detachUpstreamAbort()
        if (responseData && typeof responseData === 'object') {
          const sanitized = sanitizeOpenAICapacityShedForClient(responseData)
          res.json(sanitized.payload)
        } else {
          res.json(responseData)
        }
        return
      } catch (error) {
        detachUpstreamAbort()
        logger.error('Failed to process non-stream response:', error)
        if (!res.headersSent) {
          res.status(500).json({ error: { message: 'Failed to process response' } })
        }
        return
      }
    }

    // 使用增量 SSE 解析器
    const sseParser = new IncrementalSSEParser()

    // 处理解析出的事件
    const processSSEEvent = (eventData) => {
      // 检查是否是 response.completed 事件
      if (eventData.type === 'response.completed' && eventData.response) {
        // 从响应中获取真实的 model
        if (eventData.response.model) {
          actualModel = eventData.response.model
          logger.debug(`Captured actual model: ${actualModel}`)
        }

        if (eventData.response.service_tier) {
          streamServiceTierFromUpstream = eventData.response.service_tier
          logger.debug(`Captured service_tier: ${streamServiceTierFromUpstream}`)
        }

        // 获取 usage 数据
        if (eventData.response.usage) {
          usageData = eventData.response.usage
          logger.debug('Captured OpenAI usage data:', usageData)
        }
      }

      // 检查是否有限流错误
      if (eventData.error && eventData.error.type === 'usage_limit_reached') {
        rateLimitDetected = true
        rateLimitErrorData = eventData.error
        if (eventData.error.resets_in_seconds) {
          rateLimitResetsInSeconds = eventData.error.resets_in_seconds
          logger.warn(`Rate limit detected in stream, resets in ${rateLimitResetsInSeconds} seconds`)
        }
      }
    }

    const capacityShedSseRewriter = createCapacityShedSseRewriteStream()

    upstream.data.on('data', (chunk) => {
      try {
        // 客户端已断则只解析 usage，不再写回
        if (!streamClientGone && !res.destroyed && !res.writableEnded) {
          // capacity shed：跨 chunk 缓冲按完整 SSE 事件改写
          try {
            const rewritten = capacityShedSseRewriter.push(chunk)
            if (rewritten) {
              res.write(rewritten)
              if (rewritten.includes('"error"') || rewritten.includes('server_error')) {
                res._responseBody = res._responseBody || rewritten.slice(0, 2000)
              }
            }
          } catch (e) {
            console.error(e)
            res.write(chunk)
          }
        }

        // 使用增量解析器处理数据
        const events = sseParser.feed(chunk.toString())
        for (const event of events) {
          if (event.type === 'data' && event.data) {
            processSSEEvent(event.data)
          }
        }
      } catch (error) {
        logger.error('Error processing OpenAI stream chunk:', error)
      }
    })

    upstream.data.on('end', async () => {
      try {
        const rest = capacityShedSseRewriter.flush()
        if (rest && !streamClientGone && !res.destroyed && !res.writableEnded) {
          res.write(rest)
        }
      } catch (e) {
        console.error(e)
      }

      // 处理剩余的 buffer
      const remaining = sseParser.getRemaining()
      if (remaining.trim()) {
        const events = sseParser.feed('\n\n') // 强制刷新剩余内容
        for (const event of events) {
          if (event.type === 'data' && event.data) {
            processSSEEvent(event.data)
          }
        }
      }

      // 记录使用统计
      if (!usageReported && usageData) {
        try {
          const totalInputTokens = usageData.input_tokens || 0
          const outputTokens = usageData.output_tokens || 0
          const cacheReadTokens = extractOpenAICacheReadTokens(usageData)
          // 计算实际输入token（总输入减去缓存部分）
          const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

          // 使用响应中的真实 model，如果没有则使用请求中的 model，最后回退到默认值
          const modelToRecord = actualModel || upstreamRequestedModel || 'gpt-4'

          const streamServiceTier = resolveOpenAIServiceTier(streamServiceTierFromUpstream, req._serviceTier)
          const streamCosts = await apiKeyService.recordUsage(
            apiKeyData.id,
            buildTokenUsagePayload({
              inputTokens: actualInputTokens, // 实际输入（不含缓存）
              outputTokens,
              cacheReadTokens,
              rawUsage: usageData,
            }),
            modelToRecord,
            accountId,
            'openai',
            streamServiceTier,
            createRequestDetailMeta(req, {
              requestBody: req.body,
              stream: true,
              statusCode: res.statusCode,
            }),
          )

          logger.info(
            `Recorded OpenAI usage - Input: ${totalInputTokens}(actual:${actualInputTokens}+cached:${cacheReadTokens}), Output: ${outputTokens}, Total: ${usageData.total_tokens || totalInputTokens + outputTokens}, Model: ${modelToRecord} (actual: ${actualModel}, requested: ${upstreamRequestedModel})`,
          )
          usageReported = true

          await applyRateLimitTracking(
            req,
            {
              inputTokens: actualInputTokens,
              outputTokens,
              cacheCreateTokens: 0,
              cacheReadTokens,
            },
            modelToRecord,
            'openai-stream',
            'openai',
            streamCosts,
          )
        } catch (error) {
          logger.error('Failed to record OpenAI usage:', error)
        }
      }

      // 如果在流式响应中检测到限流
      if (rateLimitDetected) {
        logger.warn(`Processing rate limit for OpenAI account ${accountId} from stream`)
        await unifiedOpenAIScheduler.markAccountRateLimited(accountId, 'openai', sessionHash, rateLimitResetsInSeconds)
        await upstreamErrorHelper
          .markTempUnavailable(
            accountId,
            'openai',
            429,
            rateLimitResetsInSeconds,
            upstreamErrorHelper.buildErrorContext({
              url: codexEndpoint,
              method: 'POST',
              requestHeaders: headers,
              requestBody: outboundBody,
              model: upstreamRequestedModel,
              sessionId: sessionHash,
              responseStatus: 429,
              responseHeaders: upstream.headers,
              responseBody: rateLimitErrorData,
            }),
          )
          .catch(() => {})
      } else if (upstream.status === 200) {
        // 流式请求成功，检查并移除限流状态
        const isRateLimited = await unifiedOpenAIScheduler.isAccountRateLimited(accountId)
        if (isRateLimited) {
          logger.info(`Removing rate limit for OpenAI account ${accountId} after successful stream`)
          await unifiedOpenAIScheduler.removeAccountRateLimit(accountId, 'openai')
        }
      }

      detachUpstreamAbort()
      if (!streamClientGone && !res.destroyed && !res.writableEnded) {
        res.end()
      }
    })

    upstream.data.on('error', (err) => {
      detachUpstreamAbort()
      logger.error('Upstream stream error:', summarizeErrorForLog(err))
      if (!res.headersSent && !streamClientGone) {
        const clientError = buildClientError({
          statusCode: 502,
          protocol: 'openai',
          upstreamBody: null,
        })
        res.status(clientError.statusCode).json(clientError.body)
      } else if (!res.destroyed && !res.writableEnded && !streamClientGone) {
        // headers 已发：写 SSE 终端 error 帧，禁止静默断流
        // DEC_20260905_163148
        try {
          const clientError = buildClientError({
            statusCode: 502,
            protocol: 'openai',
            upstreamBody: null,
          })
          const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
          res.write(`data: ${JSON.stringify(sanitized.payload)}\n\n`)
        } catch (e) {
          console.error(summarizeErrorForLog(e))
        }
        res.end()
      }
    })

    // 流式断连：只 unpipe，禁止 destroy 上游（否则 drain 计费失效）。
    // 非流式 abort 已在发请求前的 onClientDisconnect 处理。
    onClientDisconnect(
      res,
      () => {
        streamClientGone = true
        try {
          upstream.data?.unpipe?.(res)
        } catch (_) {
          //
        }
      },
      'Codex stream',
    )
  } catch (error) {
    detachUpstreamAbort()
    // 客户端断开导致的主动 abort 不是上游/代理故障：既不上报代理健康，也不按 5xx 归因账号。
    // 判据只认 AbortError/CanceledError/ERR_CANCELED（AbortController 主动取消），
    // 不含 ECONNABORTED（axios timeout 超时，应走正常故障路径上报代理健康）。
    if (error.name === 'AbortError' || error.name === 'CanceledError' || error.code === 'ERR_CANCELED') {
      logger.info('Codex request aborted due to client disconnect')
      if (!res.headersSent && !res.destroyed) {
        res.status(499).end()
      }
      return
    }
    logger.error('Proxy to ChatGPT codex/responses failed:', summarizeErrorForLog(error))
    // 被动健康检查：上报连接级故障（classifyBusinessTraffic 区分传输错误 vs 上游响应，不误熔断）
    proxyResolver.report(proxyResolution?.proxyId, proxyResolution?.contextKey, error)
    // 优先使用主动设置的 statusCode，然后是上游响应的状态码，最后默认 500
    const status = error.statusCode || error.response?.status || 500

    if ((status === 401 || status === 402) && accountId) {
      const statusLabel = status === 401 ? '401错误' : '402错误'
      const extraHint = status === 402 ? '，可能欠费' : ''
      let reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）`
      const errorData = error.response?.data
      if (errorData) {
        const safe = extractSafeMessage(errorData)
        if (safe) {
          reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${safe}`
        }
      } else {
        const safeMsg = extractSafeMessage(error.message) || ''
        if (safeMsg) {
          reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${safeMsg}`
        }
      }

      try {
        await unifiedOpenAIScheduler.markAccountUnauthorized(accountId, accountType || 'openai', sessionHash, reason)
      } catch (markError) {
        logger.error('Failed to mark OpenAI account unauthorized in catch handler:', summarizeErrorForLog(markError))
      }
    }

    let responsePayload = error.response?.data
    if (!responsePayload) {
      responsePayload = { error: { message: getSafeMessage(error) } }
    } else if (typeof responsePayload === 'string') {
      responsePayload = { error: { message: getSafeMessage(responsePayload) } }
    } else if (typeof responsePayload === 'object' && !responsePayload.error) {
      responsePayload = {
        error: { message: getSafeMessage(responsePayload.message || error) },
      }
    } else if (responsePayload.error?.message) {
      responsePayload.error.message = getSafeMessage(responsePayload.error.message)
    }

    if (!res.headersSent) {
      res.status(status).json(responsePayload)
    }
  }
}

// 注册两个路由路径，都使用相同的处理函数
// OpenAI-compatible images endpoint. Bridges /v1/images/generations to the
// Codex responses backend via the image_generation tool (gpt-image-*). See #1239.
const handleImages = async function handleImages(req, res) {
  const apiKeyData = req.apiKey || {}
  let accountId = null
  let sessionHash = null
  try {
    if (!checkOpenAIPermissions(apiKeyData)) {
      logger.security(`API Key ${apiKeyData.id || 'unknown'} 缺少 OpenAI 权限，拒绝访问 ${req.originalUrl}`)
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access OpenAI',
          type: 'permission_denied',
          code: 'permission_denied',
        },
      })
    }

    const body = req.body || {}
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) {
      return res.status(400).json({ error: { message: 'prompt is required', type: 'invalid_request_error' } })
    }
    const imageModel = (body.model || 'gpt-image-2').toString().trim()
    if (!/^gpt-image-/i.test(imageModel)) {
      return res.status(400).json({
        error: {
          message: `images endpoint requires a gpt-image-* model, got "${imageModel}"`,
          type: 'invalid_request_error',
        },
      })
    }
    // OpenAI Images API 约定：n 为 1-10 的整数
    if (body.n !== undefined && (!Number.isInteger(body.n) || body.n < 1 || body.n > 10)) {
      return res.status(400).json({
        error: { message: 'n must be an integer between 1 and 10', type: 'invalid_request_error' },
      })
    }
    const n = body.n || 1
    // 与 handleResponses 同源：官方 session-id + 历史 session_id / x-session-id；thread-id 仅作粘性 fallback
    const sessionId =
      req.headers['session-id'] ||
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      req.headers['thread-id'] ||
      req.body?.session_id ||
      null
    sessionHash = sessionId ? crypto.createHash('sha256').update(sessionId).digest('hex') : null

    const authResult = await getOpenAIAuthToken(apiKeyData, sessionId, 'gpt-5.4-mini')
    const { accessToken, accountType, account } = authResult
    ;({ accountId } = authResult)
    if (accountType === 'openai-responses' || !accessToken) {
      return res.status(400).json({
        error: {
          message: 'images bridge requires an OpenAI OAuth (Codex) account',
          type: 'invalid_request_error',
        },
      })
    }

    const tool = { type: 'image_generation', action: 'generate', model: imageModel }
    if (body.size) {
      tool.size = String(body.size)
    }
    if (body.quality) {
      tool.quality = String(body.quality)
    }
    if (body.background) {
      tool.background = String(body.background)
    }
    if (body.output_format) {
      tool.output_format = String(body.output_format)
    }
    if (body.moderation) {
      tool.moderation = String(body.moderation)
    }
    if (Number.isInteger(body.output_compression)) {
      tool.output_compression = body.output_compression
    }
    if (n !== 1) {
      tool.n = n
    }

    const payload = {
      instructions: '',
      stream: true,
      reasoning: { effort: 'medium', summary: 'auto' },
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
      model: 'gpt-5.4-mini',
      store: false,
      tool_choice: { type: 'image_generation' },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      tools: [tool],
    }

    const headers = {
      authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': (account && (account.accountId || account.chatgptUserId)) || accountId,
      host: 'chatgpt.com',
      accept: 'text/event-stream',
      'content-type': 'application/json',
      originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/0.144.5',
      version: '0.144.5',
    }
    // 与 /responses 主路径一致：经 proxyResolver 拿 agent（支持代理池/账户代理）
    const proxyAgent = proxyResolver.resolveAgent(account, 'codex').agent
    const axiosConfig = {
      headers,
      timeout: config.requestTimeout || 600000,
      validateStatus: () => true,
      responseType: 'stream',
    }
    if (proxyAgent) {
      axiosConfig.httpAgent = proxyAgent
      axiosConfig.httpsAgent = proxyAgent
      axiosConfig.proxy = false
    }

    const upstream = await axios.post('https://chatgpt.com/backend-api/codex/responses', payload, axiosConfig)
    if (upstream.status < 200 || upstream.status >= 300) {
      // 先收集完整的错误响应体（上游以流返回）
      const chunks = []
      await new Promise((resolve) => {
        upstream.data.on('data', (chunk) => chunks.push(chunk))
        upstream.data.on('end', resolve)
        upstream.data.on('error', resolve)
        // 设置超时防止无限等待
        setTimeout(resolve, 5000)
      })
      const rawBody = Buffer.concat(chunks).toString()
      let errorData = null
      try {
        errorData = JSON.parse(rawBody)
      } catch (parseError) {
        logger.debug('Failed to parse images upstream error response:', parseError.message)
      }

      if (upstream.status === 429) {
        logger.warn(`Rate limit detected for OpenAI account ${accountId} (images bridge)`)
        const resetsInSeconds = (errorData && errorData.error && errorData.error.resets_in_seconds) || null

        // 标记账户为限流状态
        await unifiedOpenAIScheduler.markAccountRateLimited(accountId, 'openai', sessionHash, resetsInSeconds)
        await upstreamErrorHelper
          .markTempUnavailable(
            accountId,
            'openai',
            429,
            resetsInSeconds,
            upstreamErrorHelper.buildErrorContext({
              url: 'https://chatgpt.com/backend-api/codex/responses',
              method: 'POST',
              requestHeaders: headers,
              requestBody: payload,
              sessionId: sessionHash,
              responseStatus: 429,
              responseHeaders: upstream.headers,
              responseBody: errorData,
            }),
          )
          .catch(() => {})

        const errorResponse = buildClientError({
          statusCode: 429,
          protocol: 'openai',
          upstreamBody: errorData,
          retryAfterSeconds: resetsInSeconds,
        })
        {
          const sanitized = sanitizeOpenAICapacityShedForClient(errorResponse.body)
          return res.status(errorResponse.statusCode).json(sanitized.payload)
        }
      }

      if (upstream.status === 401 || upstream.status === 402) {
        const statusLabel = upstream.status === 401 ? '401错误' : '402错误'
        const extraHint = upstream.status === 402 ? '，可能欠费' : ''
        let reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）`
        const messageCandidate = extractSafeMessage(errorData)
        if (messageCandidate) {
          reason = `${reason}：${messageCandidate}`
        }
        logger.warn(`${statusLabel} detected for OpenAI account ${accountId} (images bridge)`)

        try {
          await unifiedOpenAIScheduler.markAccountUnauthorized(accountId, 'openai', sessionHash, reason)
        } catch (markError) {
          logger.error('Failed to mark OpenAI account unauthorized (images bridge):', markError)
        }
        await upstreamErrorHelper
          .markTempUnavailable(
            accountId,
            'openai',
            upstream.status,
            null,
            upstreamErrorHelper.buildErrorContext({
              url: 'https://chatgpt.com/backend-api/codex/responses',
              method: 'POST',
              requestHeaders: headers,
              requestBody: payload,
              sessionId: sessionHash,
              responseStatus: upstream.status,
              responseHeaders: upstream.headers,
              responseBody: errorData,
              message: reason,
            }),
          )
          .catch(() => {})

        // DEC_20260905_161107 图片桥 401/402 禁止 errorData 原文出站
        const clientError = buildClientError({
          statusCode: upstream.status,
          protocol: 'openai',
          upstreamBody: errorData,
        })
        {
          const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
          return res.status(clientError.statusCode).json(sanitized.payload)
        }
      }

      logger.error(
        `Images upstream error ${upstream.status}: ${extractSafeMessage(errorData) || extractSafeMessage(rawBody) || '(no message)'}`,
      )
      // DEC_20260905_162636 非 429/401/402 也走 buildClientError，禁止 errorData 原文
      {
        const clientError = buildClientError({
          statusCode: upstream.status,
          protocol: 'openai',
          upstreamBody: errorData || rawBody,
        })
        const sanitized = sanitizeOpenAICapacityShedForClient(clientError.body)
        return res.status(clientError.statusCode).json(sanitized.payload)
      }
    }

    // 请求成功，检查并移除限流状态
    const isRateLimited = await unifiedOpenAIScheduler.isAccountRateLimited(accountId)
    if (isRateLimited) {
      logger.info(`Removing rate limit for OpenAI account ${accountId} after successful request`)
      await unifiedOpenAIScheduler.removeAccountRateLimit(accountId, 'openai')
    }

    const best = {}
    let buf = ''
    let meta = {}
    let usageData = null
    let actualModel = null
    upstream.data.on('data', (chunk) => {
      buf += chunk.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) {
          continue
        }
        const p = line.slice(5).trim()
        if (!p || p === '[DONE]') {
          continue
        }
        let j
        try {
          j = JSON.parse(p)
        } catch (e) {
          continue
        }
        if (j && typeof j.partial_image_b64 === 'string') {
          const i = Number.isInteger(j.partial_image_index) ? j.partial_image_index : 0
          if (!best[i] || j.partial_image_b64.length >= best[i].length) {
            best[i] = j.partial_image_b64
          }
        }
        if (j && j.type === 'response.completed' && j.response) {
          if (Array.isArray(j.response.tools) && j.response.tools[0]) {
            meta = j.response.tools[0]
          }
          if (j.response.model) {
            actualModel = j.response.model
          }
          if (j.response.usage) {
            usageData = j.response.usage
          }
        }
      }
    })
    upstream.data.on('end', async () => {
      const keys = Object.keys(best).sort((a, b) => Number(a) - Number(b))
      if (!keys.length) {
        if (!res.headersSent) {
          res.status(502).json({ error: { message: 'no image produced by upstream', type: 'upstream_error' } })
        }
      } else if (!res.headersSent) {
        const data = keys.map((k) => ({ b64_json: best[k] }))
        res.status(200).json({
          created: Math.floor(Date.now() / 1000),
          data,
          size: meta.size,
          quality: meta.quality,
          background: meta.background,
          output_format: meta.output_format,
        })
      }

      // 记录使用统计：有图产出或有上游 usage 都落账。
      // image_count 必须传入，否则仅配置了 output_cost_per_image 的模型会 0 元。
      const producedImageCount = keys.length
      if (usageData || producedImageCount > 0) {
        try {
          const totalInputTokens = (usageData && usageData.input_tokens) || 0
          const outputTokens = (usageData && usageData.output_tokens) || 0
          const cacheReadTokens = usageData ? extractOpenAICacheReadTokens(usageData) : 0
          // 计算实际输入token（总输入减去缓存部分）
          const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)
          // [计费模型] 必须用客户端请求的 gpt-image-*，禁止用上游桥接宿主 model（固定 gpt-5.4-mini）
          // actualModel 仅日志；否则管理员配置的 gpt-image 内部价永远不生效
          const modelToRecord = imageModel
          // 张数：实际产出优先，否则回落请求 n
          const imageCount = producedImageCount > 0 ? producedImageCount : n || 1

          const imageCosts = await apiKeyService.recordUsage(
            apiKeyData.id,
            buildTokenUsagePayload({
              inputTokens: actualInputTokens,
              outputTokens,
              cacheReadTokens,
              rawUsage: usageData || {},
            }),
            modelToRecord,
            accountId,
            'openai',
            null,
            createRequestDetailMeta(req, {
              requestBody: req.body,
              stream: false,
              statusCode: res.statusCode,
              billingUsage: { image_count: imageCount },
            }),
          )

          logger.info(
            `Recorded OpenAI images usage - Input: ${totalInputTokens}(actual:${actualInputTokens}+cached:${cacheReadTokens}), Output: ${outputTokens}, Images: ${imageCount}, BillModel: ${modelToRecord}, UpstreamModel: ${actualModel || '-'}`,
          )

          await applyRateLimitTracking(
            req,
            {
              inputTokens: actualInputTokens,
              outputTokens,
              cacheCreateTokens: 0,
              cacheReadTokens,
            },
            modelToRecord,
            'openai-images',
            'openai',
            imageCosts,
          )
        } catch (usageError) {
          logger.error('Failed to record OpenAI images usage:', usageError)
        }
      }
    })
    upstream.data.on('error', (e) => {
      logger.error('Images upstream stream error:', e)
      if (!res.headersSent) {
        res.status(502).json({
          error: { message: getSafeMessage(e), type: 'upstream_error' },
        })
      }
    })

    // 客户端断开时清理上游流（只用 res 判据，禁止 req.on('close') 误杀）
    onClientDisconnect(
      res,
      () => {
        try {
          upstream.data?.unpipe?.(res)
          upstream.data?.destroy?.()
        } catch (_) {
          //
        }
      },
      'OpenAI images stream',
    )
  } catch (error) {
    // DEC_20260905_165339 禁止整包异常进日志
    logger.error('handleImages error:', summarizeErrorForLog(error))
    const status = error.statusCode || error.response?.status || 500

    if ((status === 401 || status === 402) && accountId) {
      const statusLabel = status === 401 ? '401错误' : '402错误'
      const extraHint = status === 402 ? '，可能欠费' : ''
      try {
        await unifiedOpenAIScheduler.markAccountUnauthorized(
          accountId,
          'openai',
          sessionHash,
          `OpenAI账号认证失败（${statusLabel}${extraHint}）`,
        )
      } catch (markError) {
        logger.error('Failed to mark OpenAI account unauthorized (images bridge):', summarizeErrorForLog(markError))
      }
    }

    if (!res.headersSent) {
      const clientError = buildClientError({
        statusCode: status,
        protocol: 'openai',
        upstreamBody: error.response?.data || null,
      })
      res.status(clientError.statusCode).json(clientError.body)
    }
  }
}

openaiRoutes.post('/images/generations', authenticateApiKey, handleImages)
openaiRoutes.post('/v1/images/generations', authenticateApiKey, handleImages)

openaiRoutes.post('/responses', authenticateApiKey, handleResponses)
openaiRoutes.post('/v1/responses', authenticateApiKey, handleResponses)
openaiRoutes.post('/responses/compact', authenticateApiKey, handleResponses)
openaiRoutes.post('/v1/responses/compact', authenticateApiKey, handleResponses)

// Codex CLI / VS Code 插件会请求 GET /models?client_version=...
// 带 client_version 时返回 Codex ModelsResponse（{ models: ModelInfo[] }）
// 不带时返回 OpenAI 兼容列表，数据源走 modelService 权威 OpenAI 支持集
const applyModelBlacklist = (modelIds, apiKeyData) => {
  if (!apiKeyData?.enableModelRestriction || !Array.isArray(apiKeyData.restrictedModels)) {
    return modelIds
  }
  const restricted = new Set(
    apiKeyData.restrictedModels
      .filter((model) => typeof model === 'string')
      .map((model) => model.trim())
      .filter(Boolean),
  )
  if (restricted.size === 0) {
    return modelIds
  }
  // 空数组是合法结果（黑名单清空），禁止回退全量
  return modelIds.filter((id) => !restricted.has(id))
}

export const handleModels = async (req, res) => {
  try {
    const apiKeyData = req.apiKey
    if (!checkOpenAIPermissions(apiKeyData)) {
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access OpenAI',
          type: 'permission_denied',
        },
      })
    }

    const clientVersion = typeof req.query?.client_version === 'string' ? req.query.client_version.trim() : ''

    if (clientVersion) {
      const codexModelIds = applyModelBlacklist(codexModelsManifest.getDefaultCodexModelIds(), apiKeyData)
      const manifest = codexModelsManifest.buildCodexModelsManifest(codexModelIds)
      const etag = codexModelsManifest.codexManifestEtag(manifest)
      res.setHeader('ETag', etag)
      logger.debug(`[openai/models] client_version=${clientVersion} models=${manifest.models.length} etag=${etag}`)
      if (codexModelsManifest.codexManifestETagMatches(req.headers['if-none-match'], etag)) {
        return res.status(304).end()
      }
      return res.json(manifest)
    }

    // 无 client_version：OpenAI 兼容列表，用 modelService 权威目录
    const openAIModelIds = applyModelBlacklist(
      modelService.getModelsByProvider('openai').map((model) => model.id),
      apiKeyData,
    )
    return res.json(codexModelsManifest.buildOpenAIModelsList(openAIModelIds))
  } catch (error) {
    logger.error('Failed to get OpenAI/Codex models:', summarizeErrorForLog(error))
    console.error(summarizeErrorForLog(error))
    return res.status(500).json({
      error: {
        message: 'Failed to retrieve models',
        type: 'api_error',
      },
    })
  }
}

// OpenAI Embeddings（openai-responses / 自定义 base 透传；OAuth Codex 无 embeddings）
const handleEmbeddings = async function handleEmbeddings(req, res) {
  try {
    const apiKeyData = req.apiKey
    if (!checkOpenAIPermissions(apiKeyData)) {
      logger.security(`API Key ${apiKeyData?.id || 'unknown'} 缺少 OpenAI 权限，拒绝访问 ${req.originalUrl}`)
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access OpenAI',
          type: 'permission_denied',
          code: 'permission_denied',
        },
      })
    }
    const sessionId =
      req.headers['session-id'] || req.headers['session_id'] || req.headers['x-session-id'] || req.body?.user || null
    const { accountType, account, accessToken } = await getOpenAIAuthToken(
      apiKeyData,
      sessionId,
      req.body?.model || 'text-embedding-3-small',
    )

    if (accountType !== 'openai-responses' && accountType !== 'openai') {
      return res.status(501).json({
        error: {
          message: 'Embeddings require openai-responses (API base) account',
          type: 'not_implemented',
          code: 'embeddings_unsupported_account',
        },
      })
    }

    if (accountType === 'openai') {
      // ChatGPT OAuth 无标准 embeddings；拒绝明确
      return res.status(501).json({
        error: {
          message: 'ChatGPT OAuth accounts do not support /v1/embeddings; bind an openai-responses API account',
          type: 'not_implemented',
        },
      })
    }

    // openai-responses：透传到账户 baseApi/embeddings
    return await openaiResponsesRelayService.handleEmbeddingsRequest(req, res, account, apiKeyData, accessToken)
  } catch (error) {
    console.error(summarizeErrorForLog(error))
    logger.error('Failed embeddings request:', summarizeErrorForLog(error))
    if (!res.headersSent) {
      // DEC_20260905_162636 禁止 error.message 原文出站
      const clientError = buildClientError({
        statusCode: error.statusCode || 500,
        protocol: 'openai',
        upstreamBody: null,
      })
      res.status(clientError.statusCode).json(clientError.body)
    }
  }
}

openaiRoutes.post('/embeddings', authenticateApiKey, handleEmbeddings)
openaiRoutes.post('/v1/embeddings', authenticateApiKey, handleEmbeddings)

// OpenAI Audio 透传（openai-responses base）
const handleOpenAIAudioPassthrough = async function handleOpenAIAudioPassthrough(req, res) {
  try {
    const apiKeyData = req.apiKey
    if (!checkOpenAIPermissions(apiKeyData)) {
      logger.security(`API Key ${apiKeyData?.id || 'unknown'} 缺少 OpenAI 权限，拒绝访问 ${req.originalUrl}`)
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access OpenAI',
          type: 'permission_denied',
          code: 'permission_denied',
        },
      })
    }
    const sessionId = req.headers['session-id'] || req.headers['session_id'] || req.headers['x-session-id'] || null
    const { accountType, account, accessToken } = await getOpenAIAuthToken(
      apiKeyData,
      sessionId,
      req.body?.model || 'whisper-1',
    )
    if (accountType !== 'openai-responses') {
      return res.status(501).json({
        error: {
          message: 'Audio endpoints require openai-responses API account',
          type: 'not_implemented',
        },
      })
    }
    return await openaiResponsesRelayService.handleGenericPassthrough(req, res, account, apiKeyData, accessToken)
  } catch (error) {
    console.error(summarizeErrorForLog(error))
    logger.error('Failed audio passthrough:', summarizeErrorForLog(error))
    if (!res.headersSent) {
      // DEC_20260905_162636 禁止 error.message 原文出站
      const clientError = buildClientError({
        statusCode: error.statusCode || 500,
        protocol: 'openai',
        upstreamBody: null,
      })
      res.status(clientError.statusCode).json(clientError.body)
    }
  }
}

openaiRoutes.post(
  [
    '/audio/transcriptions',
    '/v1/audio/transcriptions',
    '/audio/translations',
    '/v1/audio/translations',
    '/audio/speech',
    '/v1/audio/speech',
  ],
  authenticateApiKey,
  handleOpenAIAudioPassthrough,
)

openaiRoutes.post(['/moderations', '/v1/moderations'], authenticateApiKey, async (req, res) => {
  try {
    const apiKeyData = req.apiKey
    if (!checkOpenAIPermissions(apiKeyData)) {
      logger.security(`API Key ${apiKeyData?.id || 'unknown'} 缺少 OpenAI 权限，拒绝访问 ${req.originalUrl}`)
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access OpenAI',
          type: 'permission_denied',
          code: 'permission_denied',
        },
      })
    }
    const { accountType, account, accessToken } = await getOpenAIAuthToken(
      apiKeyData,
      null,
      req.body?.model || 'omni-moderation-latest',
    )
    if (accountType !== 'openai-responses') {
      return res.status(501).json({
        error: { message: 'Moderations require openai-responses API account', type: 'not_implemented' },
      })
    }
    return await openaiResponsesRelayService.handleGenericPassthrough(req, res, account, apiKeyData, accessToken)
  } catch (error) {
    console.error(summarizeErrorForLog(error))
    if (!res.headersSent) {
      // DEC_20260905_162636 禁止 error.message 原文出站
      const clientError = buildClientError({
        statusCode: error.statusCode || 500,
        protocol: 'openai',
        upstreamBody: null,
      })
      res.status(clientError.statusCode).json(clientError.body)
    }
  }
})

openaiRoutes.get('/models', authenticateApiKey, handleModels)
openaiRoutes.get('/v1/models', authenticateApiKey, handleModels)

// 使用情况统计端点
openaiRoutes.get('/usage', authenticateApiKey, async (req, res) => {
  try {
    const keyData = req.apiKey
    // 按需查询 usage 数据
    const usage = await redis.getUsageStats(keyData.id)

    res.json({
      object: 'usage',
      total_tokens: usage?.total?.tokens || 0,
      total_requests: usage?.total?.requests || 0,
      daily_tokens: usage?.daily?.tokens || 0,
      daily_requests: usage?.daily?.requests || 0,
      monthly_tokens: usage?.monthly?.tokens || 0,
      monthly_requests: usage?.monthly?.requests || 0,
    })
  } catch (error) {
    logger.error('Failed to get usage stats:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve usage statistics',
        type: 'api_error',
      },
    })
  }
})

// API Key 信息端点
openaiRoutes.get('/key-info', authenticateApiKey, async (req, res) => {
  try {
    const keyData = req.apiKey
    // 按需查询 usage 数据（仅 key-info 端点需要）
    const usage = await redis.getUsageStats(keyData.id)
    const tokensUsed = usage?.total?.tokens || 0
    res.json({
      id: keyData.id,
      name: keyData.name,
      description: keyData.description,
      permissions: keyData.permissions,
      token_limit: keyData.tokenLimit,
      tokens_used: tokensUsed,
      tokens_remaining: keyData.tokenLimit > 0 ? Math.max(0, keyData.tokenLimit - tokensUsed) : null,
      rate_limit: {
        window: keyData.rateLimitWindow,
        requests: keyData.rateLimitRequests,
      },
      usage: {
        total: usage?.total || {},
        daily: usage?.daily || {},
        monthly: usage?.monthly || {},
      },
    })
  } catch (error) {
    logger.error('Failed to get key info:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve API key information',
        type: 'api_error',
      },
    })
  }
})
