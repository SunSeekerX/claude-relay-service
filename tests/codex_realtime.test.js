import { isRealtimeCallIdSegment, extractCallIdFromLocation, rewriteClientLocation, extractCallIdFromWsRequest, resolveUpstreamWebSocketUrl, isRealtimeHttpCreatePath, isRealtimeWebSocketPath } from '../src/modules/relay/relay_codex_realtime.js'

describe('codexRealtime protocol helpers', () => {
  test('extractCallIdFromLocation supports rtc_ and uuid', () => {
    expect(extractCallIdFromLocation('/v1/realtime/calls/rtc_test')).toBe('rtc_test')
    expect(
      extractCallIdFromLocation('/v1/realtime/calls/019eb97d-8e9a-7ff3-94b0-ea019babd5d7')
    ).toBe('019eb97d-8e9a-7ff3-94b0-ea019babd5d7')
    expect(extractCallIdFromLocation('/v1/realtime/calls')).toBeNull()
    expect(isRealtimeCallIdSegment('rtc_x')).toBe(true)
    expect(isRealtimeCallIdSegment('not-a-call')).toBe(false)
  })

  test('rewriteClientLocation matches CLIProxy/sub2api shapes', () => {
    expect(rewriteClientLocation('/v1/realtime/calls', 'rtc_1')).toBe('/v1/realtime/calls/rtc_1')
    expect(rewriteClientLocation('/v1/live', 'rtc_1')).toBe('/v1/live/rtc_1')
    expect(rewriteClientLocation('/backend-api/codex/realtime/calls', 'rtc_1')).toBe(
      '/backend-api/codex/rtc_1'
    )
  })

  test('resolveUpstreamWebSocketUrl ChatGPT OAuth sideband', () => {
    expect(
      resolveUpstreamWebSocketUrl({
        pathname: '/v1/realtime',
        search: '?call_id=rtc_1',
        callId: 'rtc_1',
        isChatGptOAuth: true
      })
    ).toBe('wss://chatgpt.com/backend-api/codex/rtc_1')

    expect(
      resolveUpstreamWebSocketUrl({
        pathname: '/backend-api/codex/rtc_1',
        callId: 'rtc_1',
        isChatGptOAuth: true
      })
    ).toBe('wss://chatgpt.com/backend-api/codex/rtc_1')
  })

  test('resolveUpstreamWebSocketUrl API key shapes', () => {
    expect(
      resolveUpstreamWebSocketUrl({
        pathname: '/v1/realtime',
        search: '?call_id=rtc_1',
        callId: 'rtc_1',
        isChatGptOAuth: false
      })
    ).toBe('wss://api.openai.com/v1/realtime?call_id=rtc_1')

    expect(
      resolveUpstreamWebSocketUrl({
        pathname: '/v1/live/rtc_1',
        callId: 'rtc_1',
        isChatGptOAuth: false
      })
    ).toBe('wss://api.openai.com/v1/live/rtc_1')
  })

  test('path detectors', () => {
    expect(isRealtimeHttpCreatePath('/v1/realtime/calls')).toBe(true)
    expect(isRealtimeHttpCreatePath('/v1/live')).toBe(true)
    expect(isRealtimeHttpCreatePath('/v1/realtime')).toBe(true)
    expect(isRealtimeHttpCreatePath('/v1/responses')).toBe(false)
    expect(isRealtimeWebSocketPath('/v1/realtime')).toBe(true)
    expect(isRealtimeWebSocketPath('/backend-api/codex/rtc_1')).toBe(true)
    expect(isRealtimeWebSocketPath('/v1/responses')).toBe(false)
  })

  test('extractCallIdFromWsRequest from query and path', () => {
    const params = new URLSearchParams('call_id=rtc_q')
    expect(extractCallIdFromWsRequest('/v1/realtime', params)).toBe('rtc_q')
    expect(extractCallIdFromWsRequest('/v1/live/rtc_path', new URLSearchParams())).toBe('rtc_path')
  })
})
