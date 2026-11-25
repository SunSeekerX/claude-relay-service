import { describe, expect, it } from '@jest/globals'
import {
  GROK_MEDIA_FALLBACK_PRICING,
  resolveGrokMediaUnitPrices,
} from '../src/modules/pricing/pricing_grok_media_pricing.js'
import { convertResponsesRequestToClaude } from '../src/modules/relay/translator/relay_translator_claude_responses.js'
import { adaptResponsesTools } from '../src/modules/relay/relay_responses_tools.js'

describe('media output prices remain billable when optional tier keys are absent', () => {
  it.each([
    ['grok-imagine-image', { resolution: '1k' }, 0.02],
    ['grok-imagine-image', { resolution: '2k' }, 0.02],
    ['grok-imagine-image-quality', { resolution: '1k' }, 0.05],
    ['grok-imagine-image-quality', { resolution: '2k' }, 0.07],
    ['grok-imagine-image-2.0', { resolution: '1k', quality: 'low' }, 0.04],
    ['grok-imagine-image-2.0', { resolution: '2k', quality: 'medium' }, 0.08],
  ])('%s %j keeps the configured output price', (model, usage, price) => {
    expect(resolveGrokMediaUnitPrices(GROK_MEDIA_FALLBACK_PRICING[model], usage).imageOutputPrice).toBe(price)
  })

  it('uses the existing highest-tier policy when a requested tier is absent', () => {
    expect(
      resolveGrokMediaUnitPrices(
        { output_cost_per_image: 0.01, xai_image_output_tiers: { '2k': 0.07 } },
        { resolution: '1k' },
      ).imageOutputPrice,
    ).toBe(0.07)
    expect(
      resolveGrokMediaUnitPrices(GROK_MEDIA_FALLBACK_PRICING['grok-imagine-video'], { video_resolution: '1080p' })
        .videoOutputPerSecond,
    ).toBe(0.07)
    expect(
      resolveGrokMediaUnitPrices({ output_cost_per_video_per_second: 0.03, xai_video_output_tiers: { '720p': 0.09 } })
        .videoOutputPerSecond,
    ).toBe(0.09)
  })

  it('honors explicit free tiers, null tiers and flat administrator pricing', () => {
    expect(
      resolveGrokMediaUnitPrices(
        { output_cost_per_image: 0.2, xai_image_output_tiers: { '2k': 0 } },
        { resolution: '1k' },
      ).imageOutputPrice,
    ).toBe(0)
    expect(
      resolveGrokMediaUnitPrices(
        { output_cost_per_video_per_second: 0.2, xai_video_output_tiers: { '720p': 0 } },
        { video_resolution: '1080p' },
      ).videoOutputPerSecond,
    ).toBe(0)
    expect(resolveGrokMediaUnitPrices({ xai_image_output_tiers: { '1k_low': 0, '1k': 0.05 } }).imageOutputPrice).toBe(0)
    expect(resolveGrokMediaUnitPrices({ xai_image_output_tiers: { '1k_low': null, '1k': 0 } }).imageOutputPrice).toBe(0)
    expect(
      resolveGrokMediaUnitPrices({ xai_video_output_tiers: { '480p': 0, '720p': 0.09 } }).videoOutputPerSecond,
    ).toBe(0)
    expect(resolveGrokMediaUnitPrices({ output_cost_per_image: 0.123 }).imageOutputPrice).toBe(0.123)
  })
})

const tools = [
  { type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } },
  { type: 'function', name: 'write_file', parameters: { type: 'object', properties: {} } },
]
const source = (extra = {}) => ({ model: 'claude-sonnet-4-6', tools, input: 'Read the file', ...extra })

describe('Responses tool policy survives the actual Claude request converter', () => {
  it.each([undefined, 'auto', 'required', { type: 'function', name: 'read_file' }])(
    'disables parallel tool calls with %j',
    (tool_choice) => {
      const result = convertResponsesRequestToClaude(source({ tool_choice, parallel_tool_calls: false }))
      expect(result.tool_choice.disable_parallel_tool_use).toBe(true)
    },
  )

  it.each(['auto', 'required'])('limits allowed tools and retains %s choice', (mode) => {
    const body = source({
      parallel_tool_calls: false,
      tool_choice: { type: 'allowed_tools', mode, tools: [{ type: 'function', name: 'read_file' }] },
    })
    const original = structuredClone(body)
    const result = convertResponsesRequestToClaude(body)
    expect(result.tools.map((tool) => tool.name)).toEqual(['read_file'])
    expect(result.tool_choice).toEqual({ type: mode === 'required' ? 'any' : 'auto', disable_parallel_tool_use: true })
    expect(body).toEqual(original)
  })

  it('keeps historical tools paired even when only another tool is now allowed', () => {
    const result = convertResponsesRequestToClaude(
      source({
        input: [
          { type: 'function_call', call_id: 'old', name: 'write_file', arguments: '{}' },
          { type: 'function_call_output', call_id: 'old', output: 'done' },
        ],
        tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'read_file' }] },
      }),
    )
    expect(result.tools.map((tool) => tool.name)).toEqual(['read_file'])
    expect(result.messages[0].content[0]).toMatchObject({ id: 'old', name: 'write_file' })
    expect(result.messages[1].content[0]).toMatchObject({ tool_use_id: 'old', content: 'done' })
  })

  it('supports namespaced custom tools and explicit namespace choices', () => {
    const body = source({
      tools: [{ type: 'namespace', name: 'files', tools: [{ type: 'custom', name: 'read' }] }],
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [{ type: 'custom', namespace: 'files', name: 'read' }],
      },
    })
    const result = convertResponsesRequestToClaude(body)
    expect(result.tools.map((tool) => tool.name)).toEqual(['files__read'])
    expect(result.tool_choice).toEqual({ type: 'any' })
    expect(
      convertResponsesRequestToClaude({ ...body, tool_choice: { type: 'namespace', name: 'files' } }).tool_choice,
    ).toEqual({ type: 'any' })
    expect(
      adaptResponsesTools(body).restoreItem({
        type: 'function_call',
        name: 'files__read',
        arguments: '{"input":"raw"}',
      }),
    ).toMatchObject({ type: 'custom_tool_call', namespace: 'files', name: 'read', input: 'raw' })
  })

  it('keeps none and no-tools requests valid without adding unsupported flags', () => {
    expect(
      convertResponsesRequestToClaude(source({ tool_choice: 'none', parallel_tool_calls: false })).tool_choice,
    ).toEqual({ type: 'none' })
    expect(
      convertResponsesRequestToClaude(source({ tools: [], parallel_tool_calls: false })).tool_choice,
    ).toBeUndefined()
    expect(convertResponsesRequestToClaude(source({ parallel_tool_calls: true })).tool_choice).toBeUndefined()
  })

  it.each([
    { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'undeclared' }] },
    { type: 'allowed_tools', mode: 'invalid', tools: [{ type: 'function', name: 'read_file' }] },
    { type: 'allowed_tools', mode: 'required', tools: [] },
    { type: 'allowed_tools', mode: 'required', tools: [{ type: 'web_search' }] },
    { type: 'unrepresentable' },
  ])('rejects an unrepresentable policy instead of widening it: %j', (tool_choice) => {
    expect(() => convertResponsesRequestToClaude(source({ tool_choice }))).toThrow()
  })
})
