import { createRealtimeUsageAccumulator } from '../src/modules/relay/relay_codex_realtime.js'

describe('realtime usage per-turn buckets', () => {
  test('does not merge two turns of same tier into one long-context bill', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.6-sol',
          service_tier: 'ultrafast',
          usage: { input_tokens: 200000, output_tokens: 10 },
        },
      }),
    )
    acc.ingestText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.6-sol',
          service_tier: 'ultrafast',
          usage: { input_tokens: 200000, output_tokens: 10 },
        },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.tierUsages).toHaveLength(2)
    expect(snap.tierUsages[0].input_tokens).toBe(200000)
    expect(snap.tierUsages[1].input_tokens).toBe(200000)
    expect(snap.input_tokens).toBe(400000)
  })

  test('keeps separate entries when model changes under same tier', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.6-sol',
          service_tier: 'priority',
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }),
    )
    acc.ingestText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-6-astra',
          service_tier: 'priority',
          usage: { input_tokens: 20, output_tokens: 2 },
        },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.tierUsages).toHaveLength(2)
    expect(snap.tierUsages[0].lastModel).toBe('gpt-5.6-sol')
    expect(snap.tierUsages[1].lastModel).toBe('gpt-6-astra')
  })

  test('falls back to request service_tier when response omits it', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'ultrafast',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 11, output_tokens: 2 },
        },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.tierUsages[0].serviceTier).toBe('ultrafast')
  })

  test('sticky cyber policy event not overwritten by later error', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestText(
      JSON.stringify({
        type: 'response.failed',
        response: {
          error: { code: 'session_blocked_by_cyber_policy', message: 'start a new session' },
        },
      }),
    )
    acc.ingestText(
      JSON.stringify({
        type: 'error',
        error: { code: 'invalid_request_error', message: 'bad' },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.cyberPolicyEvent).toBeTruthy()
    expect(snap.lastErrorEvent.error.code).toBe('invalid_request_error')
  })


  test('clears request tier when next create omits it', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'ultrafast',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      }),
    )
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 7, output_tokens: 1 },
        },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.tierUsages[0].serviceTier).toBe('ultrafast')
    expect(snap.tierUsages[1].serviceTier).toBe(null)
  })

  test('client forged usage is ignored', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.6-sol',
          service_tier: 'ultrafast',
          usage: { input_tokens: 999999, output_tokens: 999999 },
        },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.tierUsages).toHaveLength(0)
    expect(acc.hasTokenUsage()).toBe(false)
  })

  test('FIFO + response id keeps concurrent request tiers aligned', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'ultrafast',
      }),
    )
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'priority',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_a', model: 'gpt-5.6-sol' },
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_b', model: 'gpt-5.6-sol' },
      }),
    )
    // B 先完成且省略档位：应按 priority，而不是被后到的 A 覆盖
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_b',
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_a',
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 4, output_tokens: 1 },
        },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.tierUsages).toHaveLength(2)
    expect(snap.tierUsages[0].serviceTier).toBe('priority')
    expect(snap.tierUsages[1].serviceTier).toBe('ultrafast')
  })

  test('plain error without created releases FIFO so next request is not mispriced', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'ultrafast',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'error',
        error: { code: 'invalid_request_error', message: 'bad' },
      }),
    )
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'priority',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_b', model: 'gpt-5.6-sol' },
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_b',
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.tierUsages).toHaveLength(1)
    expect(snap.tierUsages[0].serviceTier).toBe('priority')
  })

  test('failed with usage does not steal the next request tier', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'ultrafast',
      }),
    )
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'priority',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_a', model: 'gpt-5.6-sol' },
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.failed',
        response: {
          id: 'resp_a',
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 9, output_tokens: 1 },
        },
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_b', model: 'gpt-5.6-sol' },
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_b',
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 4, output_tokens: 1 },
        },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.tierUsages).toHaveLength(2)
    expect(snap.tierUsages[0].serviceTier).toBe('ultrafast')
    expect(snap.tierUsages[1].serviceTier).toBe('priority')
  })

  test('already bound id still drains after overflow freeze', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'ultrafast',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_a', model: 'gpt-5.6-sol' },
      }),
    )
    for (let index = 0; index < 64; index += 1) {
      acc.ingestClientText(
        JSON.stringify({
          type: 'response.create',
          model: 'gpt-5.6-sol',
          service_tier: 'priority',
        }),
      )
    }
    // 第 65 条才冻结；此前 64 条只是填满 FIFO
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'flex',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_a',
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.tierUsages[0].serviceTier).toBe('ultrafast')
  })

  test('overflow freeze does not let a skipped response steal leftover FIFO', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'ultrafast',
      }),
    )
    for (let index = 0; index < 64; index += 1) {
      acc.ingestClientText(
        JSON.stringify({
          type: 'response.create',
          model: 'gpt-5.6-sol',
          service_tier: 'priority',
        }),
      )
    }
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'flex',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_skipped', model: 'gpt-5.6-sol' },
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_skipped',
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.tierUsages).toHaveLength(1)
    expect(snap.tierUsages[0].serviceTier).toBe(null)
  })

  test('completed with id and no created still consumes FIFO head', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'ultrafast',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_a',
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      }),
    )
    acc.ingestClientText(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        service_tier: 'priority',
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_b', model: 'gpt-5.6-sol' },
      }),
    )
    acc.ingestUpstreamText(
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_b',
          model: 'gpt-5.6-sol',
          usage: { input_tokens: 6, output_tokens: 1 },
        },
      }),
    )
    const snap = acc.snapshot()
    expect(snap.tierUsages[0].serviceTier).toBe('ultrafast')
    expect(snap.tierUsages[1].serviceTier).toBe('priority')
  })
})
