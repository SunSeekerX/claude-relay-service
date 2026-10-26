import { describe, expect, test } from '@jest/globals'
import {
  getDefaultRouteFormat,
  getRequestRouteFormat,
  normalizeKeyRouting,
  normalizeRouteModelConfig,
} from '../src/modules/relay/relay_routing_contract.js'
import { runWithRelayRoute, scopeRouteSession } from '../src/modules/relay/relay_route_context.js'
import { applyRouteModel, rewriteRouteModelFrame } from '../src/modules/relay/relay_route_model.js'
import { isModelAllowed } from '../src/modules/relay/relay_model_access.js'

describe('named relay route contracts', () => {
  test('legacy keys have no new authorization or default', () => {
    expect(normalizeKeyRouting(undefined)).toEqual({ allowedRoutes: [], defaults: {} })
    expect(normalizeKeyRouting('{"allowedRoutes":[],"defaults":{}}')).toEqual({ allowedRoutes: [], defaults: {} })
  })

  test('defaults must name an authorized route and known format', () => {
    expect(() => normalizeKeyRouting({ allowedRoutes: ['a'], defaults: { 'claude-messages': 'b' } })).toThrow()
    expect(() => normalizeKeyRouting({ allowedRoutes: ['a', 'a'], defaults: {} })).toThrow()
    expect(() => normalizeKeyRouting({ allowedRoutes: ['../other'], defaults: {} })).toThrow()
    expect(() => normalizeKeyRouting({ allowedRoutes: ['a'], defaults: { unknown: 'a' } })).toThrow()
  })

  test('explicit false converter override survives normalization', () => {
    const config = normalizeRouteModelConfig({
      provider: 'openai',
      formats: ['claude-messages'],
      modelMapping: { fast: 'gpt-test' },
      converterOptions: { 'claude-messages': { parallelToolCalls: false } },
    })
    expect(config.converterOptions['claude-messages'].parallelToolCalls).toBe(false)
    expect(() =>
      normalizeRouteModelConfig({
        provider: 'claude',
        formats: ['claude-messages'],
        converterOptions: { 'claude-messages': { parallelToolCalls: false } },
      }),
    ).toThrow()
  })

  test('native Gemini and token-count paths resolve the same ingress format', () => {
    expect(getRequestRouteFormat({ path: '/v1/messages/count_tokens' })).toBe('claude-messages')
    expect(getRequestRouteFormat({ path: '/v1beta/models/alias:streamGenerateContent' })).toBe('gemini-generate')
    expect(getRequestRouteFormat({ path: '/v1/responses/compact' })).toBe('openai-responses')
    expect(getDefaultRouteFormat({ originalUrl: '/antigravity/api/v1/messages' }, 'claude-messages')).toBeNull()
    expect(getDefaultRouteFormat({ originalUrl: '/v1/messages' }, 'claude-messages')).toBe('claude-messages')
  })

  test('concurrent requests isolate sticky identities by key, entry, and target', async () => {
    const make = (id, code, binding) => ({ id, _relayRoute: { code, provider: 'claude', binding } })
    const values = await Promise.all([
      runWithRelayRoute(make('key1', 'a', 'group:1'), async () => {
        await Promise.resolve()
        return scopeRouteSession('same-session')
      }),
      runWithRelayRoute(make('key1', 'b', 'group:2'), async () => {
        await Promise.resolve()
        return scopeRouteSession('same-session')
      }),
      runWithRelayRoute(make('key2', 'a', 'group:1'), async () => scopeRouteSession('same-session')),
      runWithRelayRoute(make('key1', 'a', 'group:3'), async () => scopeRouteSession('same-session')),
    ])
    expect(new Set(values).size).toBe(4)
    expect(values.every((value) => /^[a-f0-9]{32}$/.test(value))).toBe(true)
    expect(runWithRelayRoute(make('key1', 'a', 'group:1'), () => scopeRouteSession('same-session'))).toBe(values[0])
    expect(scopeRouteSession('same-session')).toBe('same-session')
  })
})

const createResponse = (contentType = 'application/json') => {
  const output = []
  return {
    output,
    headersSent: false,
    getHeader: () => contentType,
    removeHeader: () => {},
    json: (value) => output.push(value),
    send: (value) => output.push(value),
    write: (value) => {
      output.push(value)
      return true
    },
    end: (value) => {
      if (value !== undefined) {
        output.push(value)
      }
    },
  }
}

describe('entry model mapping and echo', () => {
  test('Gemini internal model mapping uses the nested request while retaining native version metadata', () => {
    const request = {
      path: '/v1internal:generateContent',
      apiKey: {},
      body: { request: { model: 'alias', contents: [] } },
    }
    const response = createResponse()
    expect(applyRouteModel(request, response, { modelMapping: { alias: 'gemini-target' } })).toBe('gemini-target')
    expect(request.body.request.model).toBe('gemini-target')
    response.json({ modelVersion: 'gemini-target-actual-version', candidates: [] })
    expect(response.output[0].modelVersion).toBe('gemini-target-actual-version')
  })
  test('public model discovery shares canonical alias restrictions with runtime authorization', () => {
    expect(isModelAllowed({ enableModelRestriction: true, restrictedModels: ['gpt-6'] }, 'gpt-6-astra')).toBe(false)
  })
  test('mapping is one step and original and target blacklists both apply', () => {
    const route = { modelMapping: { alias: 'target', target: 'other' }, echoModel: 'upstream' }
    const request = { apiKey: {}, body: { model: 'alias' } }
    expect(applyRouteModel(request, createResponse(), route)).toBe('target')
    expect(request.body.model).toBe('target')
    expect(request._relayRouteModel).toEqual({ requestedModel: 'alias', mappedModel: 'target' })
    for (const blocked of ['alias', 'target']) {
      const denied = { apiKey: { enableModelRestriction: true, restrictedModels: [blocked] }, body: { model: 'alias' } }
      expect(() => applyRouteModel(denied, createResponse(), route)).toThrow()
      expect(denied.body.model).toBe('alias')
    }
  })

  test('mapped-only mode rejects unlisted names including direct target names', () => {
    expect(() =>
      applyRouteModel({ apiKey: {}, body: { model: 'target' } }, createResponse(), {
        modelMode: 'mapped-only',
        modelMapping: { alias: 'target' },
      }),
    ).toThrow()
  })

  test('JSON echo changes only protocol model fields', () => {
    const response = createResponse()
    applyRouteModel({ apiKey: {}, body: { model: 'alias' } }, response, { modelMapping: { alias: 'target' } })
    response.json({ model: 'target', choices: [{ text: 'target' }] })
    expect(response.output[0]).toEqual({ model: 'alias', choices: [{ text: 'target' }] })
  })

  test('SSE echo handles UTF-8 byte boundaries and preserves content and controls', () => {
    const response = createResponse('text/event-stream')
    applyRouteModel({ apiKey: {}, body: { model: '别名' } }, response, { modelMapping: { 别名: 'target' } })
    const input = Buffer.from(
      'event: message_start\ndata: {"type":"message_start",\ndata: "message":{"model":"target","content":[{"text":"中文 target"}]}}\n\ndata: [DONE]\n\n',
    )
    for (let index = 0; index < input.length; index++) {
      response.write(input.subarray(index, index + 1))
    }
    response.end()
    const output = response.output.join('')
    expect(output).toContain('"model":"别名"')
    expect(output).toContain('中文 target')
    expect(output).toContain('data: [DONE]')
    expect(rewriteRouteModelFrame(': heartbeat\n\n', 'alias')).toBe(': heartbeat\n\n')
  })
})
