import { extractRealtimeUsageFromEvent, createRealtimeUsageAccumulator } from '../src/modules/relay/relay_codex_realtime.js'

describe('realtime usage accumulator', () => {
  test('extracts usage from response.done', () => {
    const usage = extractRealtimeUsageFromEvent({
      type: 'response.done',
      response: {
        model: 'gpt-realtime',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          input_token_details: { audio_tokens: 80, cached_tokens: 10 },
          output_token_details: { audio_tokens: 40 }
        }
      }
    })
    expect(usage.input_tokens).toBe(100)
    expect(usage.output_tokens).toBe(50)
    expect(usage.cache_read_input_tokens).toBe(10)
    expect(usage.input_audio_tokens).toBe(80)
    expect(usage.model).toBe('gpt-realtime')
  })

  test('accumulator sums multiple events', () => {
    const acc = createRealtimeUsageAccumulator()
    acc.ingestText(
      JSON.stringify({
        type: 'response.done',
        response: { usage: { input_tokens: 10, output_tokens: 5 } }
      })
    )
    acc.ingestText(
      JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 7, output_tokens: 3 }, model: 'gpt-realtime' }
      })
    )
    acc.ingestText('not-json')
    const snap = acc.snapshot()
    expect(snap.input_tokens).toBe(17)
    expect(snap.output_tokens).toBe(8)
    expect(snap.eventCount).toBe(2)
    expect(snap.lastModel).toBe('gpt-realtime')
    expect(acc.hasTokenUsage()).toBe(true)
  })
})
