import {
  validCodexDelegationEnvelope,
  validCodexAutomationBootstrap,
  validCodexAutomationId,
  validCodexAutomationLastRun,
  isCodexDelegationCandidate,
  isCodexAutomationCandidate,
  normalizeCodexBootstrapBody,
  isCodexDelegationTool,
} from '../src/modules/relay/relay_codex_bootstrap_normalize.js'

const delegationEnvelope =
  '<codex_delegation><source_thread_id>thread-1</source_thread_id><input>do the work</input></codex_delegation>'

const automationOutput = [
  'Automation: nightly',
  'Automation ID: job_1',
  'Automation memory: $CODEX_HOME/automations/job_1/memory.md',
  'Last run: never',
  '',
  'Run the checks',
].join('\n')

describe('codex bootstrap envelope validators', () => {
  it('accepts strict delegation xml', () => {
    expect(validCodexDelegationEnvelope(delegationEnvelope)).toBe(true)
    expect(
      validCodexDelegationEnvelope(
        '<codex_delegation><input>work</input><source_thread_id>t1</source_thread_id></codex_delegation>',
      ),
    ).toBe(true)
  })

  it('rejects incomplete or noisy delegation xml', () => {
    expect(
      validCodexDelegationEnvelope(
        '<codex_delegation><source_thread_id>thread-1</source_thread_id></codex_delegation>',
      ),
    ).toBe(false)
    expect(
      validCodexDelegationEnvelope(
        `prefix${delegationEnvelope}`,
      ),
    ).toBe(false)
    expect(
      validCodexDelegationEnvelope(
        `${delegationEnvelope}suffix`,
      ),
    ).toBe(false)
    expect(
      validCodexDelegationEnvelope(
        '<codex_delegation><source_thread_id>t</source_thread_id><input><nested>x</nested></input></codex_delegation>',
      ),
    ).toBe(false)
  })

  it('validates automation bootstrap text', () => {
    expect(validCodexAutomationBootstrap(automationOutput)).toBe(true)
    expect(validCodexAutomationId('job_1')).toBe(true)
    expect(validCodexAutomationId('../x')).toBe(false)
    expect(validCodexAutomationLastRun('never')).toBe(true)
  })

  it('rejects bad automation headers', () => {
    const bad = [
      'Automation: nightly',
      'Automation ID: bad/id',
      'Automation memory: $CODEX_HOME/automations/bad/id/memory.md',
      'Last run: never',
      '',
      'body',
    ].join('\n')
    expect(validCodexAutomationBootstrap(bad)).toBe(false)
  })

  it('recognizes delegation tools', () => {
    expect(isCodexDelegationTool('codex_app', 'create_thread')).toBe(true)
    expect(isCodexDelegationTool('codex_tui', 'send_message_to_thread')).toBe(true)
    expect(isCodexDelegationTool('codex_app', 'other')).toBe(false)
  })
})

describe('normalizeCodexBootstrapBody', () => {
  it('rewrites delegation bootstrap without call_id to user message', () => {
    const body = {
      model: 'gpt-5',
      input: [
        {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'create_thread',
          output: delegationEnvelope,
        },
      ],
    }
    expect(isCodexDelegationCandidate(body.input[0])).toBe(true)
    const result = normalizeCodexBootstrapBody(body)
    expect(result.changed).toBe(true)
    expect(result.kinds).toContain('delegation')
    expect(body.input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: delegationEnvelope }],
    })
  })

  it('rewrites empty call_id delegation bootstrap', () => {
    const body = {
      model: 'gpt-5',
      input: [
        {
          type: 'function_call_output',
          namespace: 'codex_tui',
          name: 'send_message_to_thread',
          call_id: '  ',
          output: delegationEnvelope,
        },
      ],
    }
    const result = normalizeCodexBootstrapBody(body)
    expect(result.changed).toBe(true)
    expect(body.input[0].type).toBe('message')
  })

  it('rewrites automation bootstrap', () => {
    const body = {
      model: 'gpt-5',
      input: [
        {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'automation_update',
          output: automationOutput,
        },
      ],
    }
    expect(isCodexAutomationCandidate(body.input[0])).toBe(true)
    const result = normalizeCodexBootstrapBody(body)
    expect(result.changed).toBe(true)
    expect(result.kinds).toContain('automation')
    expect(body.input[0].role).toBe('user')
    expect(body.input[0].content[0].text).toBe(automationOutput)
  })

  it('does not rewrite when call_id is present', () => {
    const item = {
      type: 'function_call_output',
      namespace: 'codex_app',
      name: 'create_thread',
      call_id: 'call-1',
      output: delegationEnvelope,
    }
    const body = { model: 'gpt-5', input: [item] }
    const result = normalizeCodexBootstrapBody(body)
    expect(result.changed).toBe(false)
    expect(body.input[0]).toBe(item)
  })

  it('does not rewrite when previous_response_id is set', () => {
    const body = {
      model: 'gpt-5',
      previous_response_id: 'resp-1',
      input: [
        {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'create_thread',
          output: delegationEnvelope,
        },
      ],
    }
    const result = normalizeCodexBootstrapBody(body)
    expect(result.changed).toBe(false)
  })

  it('allows empty previous_response_id string', () => {
    const body = {
      model: 'gpt-5',
      previous_response_id: '',
      input: [
        {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'create_thread',
          output: delegationEnvelope,
        },
      ],
    }
    const result = normalizeCodexBootstrapBody(body)
    expect(result.changed).toBe(true)
  })

  it('does not rewrite when another function_call anchor exists', () => {
    const body = {
      model: 'gpt-5',
      input: [
        {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'create_thread',
          output: delegationEnvelope,
        },
        { type: 'function_call', call_id: 'call-1', name: 'x' },
      ],
    }
    const result = normalizeCodexBootstrapBody(body)
    expect(result.changed).toBe(false)
  })

  it('does not rewrite ordinary tool output', () => {
    const body = {
      model: 'gpt-5',
      input: [
        {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'other',
          output: delegationEnvelope,
        },
      ],
    }
    const result = normalizeCodexBootstrapBody(body)
    expect(result.changed).toBe(false)
  })

  it('is idempotent after rewrite', () => {
    const body = {
      model: 'gpt-5',
      input: [
        {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'create_thread',
          output: delegationEnvelope,
        },
      ],
    }
    const first = normalizeCodexBootstrapBody(body)
    expect(first.changed).toBe(true)
    const second = normalizeCodexBootstrapBody(body)
    expect(second.changed).toBe(false)
  })
})
