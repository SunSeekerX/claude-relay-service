import {
  normalizeStatusCode,
  shouldExposeUpstreamMessage,
  extractSafeMessage,
  extractUpstreamErrorCode,
  isClientActionableUpstreamError,
  buildClientError,
  resolveAnthropicErrorType,
  buildAnthropicClientErrorBody,
} from '../src/common/client_error_builder.js'

describe('clientErrorBuilder 纯函数', () => {
  describe('normalizeStatusCode', () => {
    it('401/403 → 502（隐藏认证细节）', () => {
      expect(normalizeStatusCode(401)).toBe(502)
      expect(normalizeStatusCode(403)).toBe(502)
    })

    it('529 → 503，429 → 429（保留限流语义）', () => {
      expect(normalizeStatusCode(529)).toBe(503)
      expect(normalizeStatusCode(429)).toBe(429)
    })

    it('5xx → 502', () => {
      expect(normalizeStatusCode(500)).toBe(502)
      expect(normalizeStatusCode(502)).toBe(502)
      expect(normalizeStatusCode(503)).toBe(502)
      expect(normalizeStatusCode(504)).toBe(502)
    })

    it('普通 4xx 原样', () => {
      expect(normalizeStatusCode(400)).toBe(400)
      expect(normalizeStatusCode(404)).toBe(404)
      expect(normalizeStatusCode(422)).toBe(422)
    })

    it('非整数 → 502', () => {
      expect(normalizeStatusCode(undefined)).toBe(502)
      expect(normalizeStatusCode(null)).toBe(502)
      expect(normalizeStatusCode('500')).toBe(502)
    })
  })

  describe('shouldExposeUpstreamMessage', () => {
    it('普通 4xx 暴露，429 与 5xx 不暴露', () => {
      expect(shouldExposeUpstreamMessage(400)).toBe(true)
      expect(shouldExposeUpstreamMessage(404)).toBe(true)
      expect(shouldExposeUpstreamMessage(429)).toBe(false)
      expect(shouldExposeUpstreamMessage(502)).toBe(false)
      expect(shouldExposeUpstreamMessage(503)).toBe(false)
    })
  })

  describe('extractSafeMessage', () => {
    it('去账户/渠道标记', () => {
      expect(extractSafeMessage({ error: { message: 'boom [account/abc123]' } })).toBe('boom')
    })

    it('去 URL', () => {
      expect(extractSafeMessage('failed at https://api.upstream.com/v1/x now')).toBe(
        'failed at [upstream] now',
      )
    })

    it('支持字符串/对象/嵌套 message，空输入返回空串', () => {
      expect(extractSafeMessage('plain')).toBe('plain')
      expect(extractSafeMessage({ message: 'top' })).toBe('top')
      expect(extractSafeMessage(null)).toBe('')
      expect(extractSafeMessage({})).toBe('')
    })

    it('限长 500', () => {
      const long = 'x'.repeat(800)
      expect(extractSafeMessage(long).length).toBe(500)
    })

    it('脱敏夹带的凭证形态', () => {
      expect(extractSafeMessage('bad key sk-ant-abcdefgh123456 here')).toBe('bad key *** here')
    })
  })

  describe('isClientActionableUpstreamError', () => {
    it('识别 session_blocked_by_cyber_policy', () => {
      expect(
        isClientActionableUpstreamError(403, {
          error: {
            code: 'session_blocked_by_cyber_policy',
            message:
              '该会话已被网络安全策略屏蔽，请开启新会话 / This session is blocked by cyber-security policy, please start a new session',
            type: 'permission_error',
          },
        }),
      ).toBe(true)
    })

    it('普通 401 账户鉴权不算可自愈', () => {
      expect(
        isClientActionableUpstreamError(401, {
          error: { message: 'invalid api key', type: 'authentication_error' },
        }),
      ).toBe(false)
    })

    it('5xx / 429 不算可自愈', () => {
      expect(
        isClientActionableUpstreamError(502, {
          error: { code: 'session_blocked_by_cyber_policy', message: 'blocked' },
        }),
      ).toBe(false)
      expect(
        isClientActionableUpstreamError(429, {
          error: { message: 'rate limited' },
        }),
      ).toBe(false)
    })

    it('仅靠文案也能识别', () => {
      expect(
        isClientActionableUpstreamError(403, {
          error: { message: 'This session is blocked by cyber-security policy, please start a new session' },
        }),
      ).toBe(true)
    })
  })

  describe('buildClientError', () => {
    it('openai 协议 + 上游 401 → 502 通用 upstream_error（不透传上游原文）', () => {
      const r = buildClientError({
        statusCode: 401,
        protocol: 'openai',
        upstreamBody: { error: { message: 'invalid api key sk-xxx' } },
      })
      expect(r.statusCode).toBe(502)
      expect(r.body.error.type).toBe('upstream_error')
      expect(r.body.error.message).toBe('Upstream service temporarily unavailable')
      expect(r.body.error.message).not.toContain('sk-xxx')
    })

    it('anthropic 协议 + 上游 529 → 503，anthropic 错误结构', () => {
      const r = buildClientError({ statusCode: 529, protocol: 'anthropic' })
      expect(r.statusCode).toBe(503)
      expect(r.body.type).toBe('error')
      expect(r.body.error.type).toBe('overloaded_error')
    })

    it('gemini 协议 + 上游 500 → 502，gemini 错误结构', () => {
      const r = buildClientError({ statusCode: 500, protocol: 'gemini' })
      expect(r.statusCode).toBe(502)
      expect(r.body.error.code).toBe(502)
      expect(r.body.error.status).toBe('upstream_error')
    })

    it('429 带 retryAfterSeconds（openai 透出 resets_in_seconds）', () => {
      const r = buildClientError({ statusCode: 429, protocol: 'openai', retryAfterSeconds: 30 })
      expect(r.statusCode).toBe(429)
      expect(r.body.error.type).toBe('rate_limit_error')
      expect(r.body.error.resets_in_seconds).toBe(30)
    })

    it('上游 400 → 透传脱敏后的上游 message（客户端请求问题）', () => {
      const r = buildClientError({
        statusCode: 400,
        protocol: 'openai',
        upstreamBody: { error: { message: 'model not found [account/x]' } },
      })
      expect(r.statusCode).toBe(400)
      expect(r.body.error.message).toBe('model not found')
    })

    it('session_blocked_by_cyber_policy → 保留 403 并透传具体 message（不藏成 502）', () => {
      const message =
        '该会话已被网络安全策略屏蔽，请开启新会话 / This session is blocked by cyber-security policy, please start a new session (trace: t123)'
      const r = buildClientError({
        statusCode: 403,
        protocol: 'openai',
        upstreamBody: {
          error: {
            code: 'session_blocked_by_cyber_policy',
            message,
            type: 'permission_error',
          },
        },
      })
      expect(r.statusCode).toBe(403)
      expect(r.body.error.type).toBe('permission_error')
      expect(r.body.error.code).toBe('session_blocked_by_cyber_policy')
      expect(r.body.error.message).toContain('网络安全策略')
      expect(r.body.error.message).toContain('start a new session')
      expect(r.body.error.message).not.toBe('Upstream service temporarily unavailable')
    })

    it('extractUpstreamErrorCode 只放行标识符', () => {
      expect(extractUpstreamErrorCode({ error: { code: 'session_blocked_by_cyber_policy' } })).toBe(
        'session_blocked_by_cyber_policy',
      )
      expect(extractUpstreamErrorCode({ error: { code: 'bad code with space' } })).toBe('')
    })
  })

  describe('buildAnthropicClientErrorBody', () => {
    it('恢复 type:error 信封并保留白名单 error.type', () => {
      const body = buildAnthropicClientErrorBody({
        statusCode: 429,
        upstreamBody: {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'hit limit [account/abc]' },
        },
      })
      expect(body).toEqual({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'hit limit' },
      })
    })

    it('未知 type 归 api_error；403 无 type 时兜底 permission_error', () => {
      expect(
        resolveAnthropicErrorType(500, { error: { type: 'secret_account_type', message: 'x' } }),
      ).toBe('api_error')
      expect(resolveAnthropicErrorType(403, { error: { message: 'nope' } })).toBe('permission_error')
    })

    it('禁止自定义 status/details 字段', () => {
      const body = buildAnthropicClientErrorBody({
        statusCode: 400,
        upstreamBody: { error: { type: 'invalid_request_error', message: 'bad' } },
      })
      expect(body.status).toBeUndefined()
      expect(body.details).toBeUndefined()
      expect(body.type).toBe('error')
    })
  })
})
