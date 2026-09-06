import {
  computeClaudeCodeFingerprint,
  buildBillingAttributionText,
  ensureAlignedBillingHeader,
  stripBillingHeaderFromSystem,
  extractFirstUserText,
} from '../src/modules/relay/relay_claude_billing_header.js'

describe('relay_claude_billing_header', () => {
  test('extractFirstUserText from string and blocks', () => {
    expect(
      extractFirstUserText({
        messages: [{ role: 'user', content: 'hello-world-message' }],
      }),
    ).toBe('hello-world-message')
    expect(
      extractFirstUserText({
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'block-text-abc' }],
          },
        ],
      }),
    ).toBe('block-text-abc')
  })

  test('fingerprint is stable 3 hex chars', () => {
    const body = { messages: [{ role: 'user', content: 'abcdefghijklmnop' }] }
    const fp = computeClaudeCodeFingerprint(body, '2.1.251')
    expect(fp).toMatch(/^[0-9a-f]{3}$/)
    expect(computeClaudeCodeFingerprint(body, '2.1.251')).toBe(fp)
    expect(computeClaudeCodeFingerprint(body, '2.1.252')).not.toBe(fp)
  })

  test('buildBillingAttributionText shape', () => {
    const body = { messages: [{ role: 'user', content: 'abcdefghijklmnop' }] }
    const text = buildBillingAttributionText(body, '2.1.251')
    expect(text.startsWith('x-anthropic-billing-header: cc_version=2.1.251.')).toBe(true)
    expect(text.includes('cc_entrypoint=cli;')).toBe(true)
    expect(text.includes('cch=')).toBe(false)
  })

  test('ensureAlignedBillingHeader strips client and injects aligned block', () => {
    const body = {
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=1.0.0.abc; cc_entrypoint=cli;',
        },
        { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
      ],
      messages: [{ role: 'user', content: 'abcdefghijklmnop' }],
    }
    ensureAlignedBillingHeader(body, {
      userAgent: 'claude-cli/2.1.251 (external, cli)',
      cliVersion: '2.1.251',
    })
    expect(Array.isArray(body.system)).toBe(true)
    expect(body.system[0].text.startsWith('x-anthropic-billing-header: cc_version=2.1.251.')).toBe(
      true,
    )
    expect(body.system.filter((item) => item.text?.includes('cc_version=1.0.0')).length).toBe(0)
  })

  test('stripBillingHeaderFromSystem removes string system billing', () => {
    const body = {
      system: 'x-anthropic-billing-header: cc_version=1.0.0; cc_entrypoint=cli;',
    }
    stripBillingHeaderFromSystem(body)
    expect(body.system).toBeUndefined()
  })
})
