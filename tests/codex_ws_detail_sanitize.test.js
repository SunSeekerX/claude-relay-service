import { sanitizeUpstreamBodyForDetail } from '../src/modules/relay/relay_codex_responses_ws_bridge.js'

describe('sanitizeUpstreamBodyForDetail', () => {
  test('scrubs Bearer even when message contains tab before token', () => {
    const body = {
      error: {
        message: 'auth failed Bearer\tok_live_abc123XYZ',
        type: 'api_error',
      },
    }
    const sanitized = sanitizeUpstreamBodyForDetail(body)
    expect(sanitized.error.message).toContain('Bearer ***')
    expect(sanitized.error.message).not.toContain('ok_live_abc123XYZ')
  })

  test('scrubs sk-proj and sk-ant prefixes', () => {
    const body = {
      error: {
        message: 'bad key sk-proj-abcdefghijklmnop and sk-ant-abcdefghijklmnop',
      },
    }
    const sanitized = sanitizeUpstreamBodyForDetail(body)
    expect(sanitized.error.message).not.toMatch(/sk-proj-abcdefghijklmnop/)
    expect(sanitized.error.message).not.toMatch(/sk-ant-abcdefghijklmnop/)
    expect(sanitized.error.message).toContain('sk-***')
  })

  test('string body path still scrubs', () => {
    const sanitized = sanitizeUpstreamBodyForDetail('Authorization Bearer tok_abcdefgh')
    expect(sanitized).toContain('Bearer ***')
    expect(sanitized).not.toContain('tok_abcdefgh')
  })
})
