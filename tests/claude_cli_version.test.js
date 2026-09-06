import {
  CLAUDE_CLI_BASELINE_VERSION,
  isSemverGte,
  isSupportedClaudeCliVersion,
  resolveClaudeCliVersion,
  extractClaudeCliVersionFromUserAgent,
  buildClaudeCliUserAgent,
} from '../src/modules/relay/relay_claude_cli_version.js'

describe('relay_claude_cli_version', () => {
  test('baseline is 2.1.251', () => {
    expect(CLAUDE_CLI_BASELINE_VERSION).toBe('2.1.251')
  })

  test('isSemverGte', () => {
    expect(isSemverGte('2.1.251', '2.1.251')).toBe(true)
    expect(isSemverGte('2.1.252', '2.1.251')).toBe(true)
    expect(isSemverGte('2.1.250', '2.1.251')).toBe(false)
  })

  test('isSupportedClaudeCliVersion rejects junk and older', () => {
    expect(isSupportedClaudeCliVersion('2.1.251')).toBe(true)
    expect(isSupportedClaudeCliVersion('2.1.300')).toBe(true)
    expect(isSupportedClaudeCliVersion('2.1.250')).toBe(false)
    expect(isSupportedClaudeCliVersion('2.1.251-local')).toBe(false)
    expect(isSupportedClaudeCliVersion('2.1')).toBe(false)
    expect(isSupportedClaudeCliVersion('')).toBe(false)
  })

  test('resolveClaudeCliVersion falls back on invalid', () => {
    expect(resolveClaudeCliVersion('')).toBe(CLAUDE_CLI_BASELINE_VERSION)
    expect(resolveClaudeCliVersion('2.1.250')).toBe(CLAUDE_CLI_BASELINE_VERSION)
    expect(resolveClaudeCliVersion('2.1.300')).toBe('2.1.300')
  })

  test('extract and build user agent', () => {
    expect(extractClaudeCliVersionFromUserAgent('claude-cli/2.1.251 (external, cli)')).toBe('2.1.251')
    expect(buildClaudeCliUserAgent('2.1.251')).toBe('claude-cli/2.1.251 (external, cli)')
  })
})
