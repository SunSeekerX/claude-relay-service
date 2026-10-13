import { jest } from '@jest/globals'
import {
  cleanJsonSchemaForGemini,
  convertAntigravityToolSchema
} from '../src/modules/relay/relay_gemini_schema_cleaner.js'
import { GeminiToOpenAIConverter } from '../src/modules/relay/relay_gemini_to_openai.js'

jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: new Proxy({}, { get: () => jest.fn() })
}))
jest.unstable_mockModule('../src/infra/middleware_auth.js', () => ({
  authenticateApiKey: jest.fn()
}))
jest.unstable_mockModule('../src/modules/apikey/apikey_service.js', () => ({ apiKeyService: {} }))
jest.unstable_mockModule('../src/modules/relay/relay_openai_claude_routes.js', () => ({
  handleChatCompletion: jest.fn()
}))
jest.unstable_mockModule('../src/modules/relay/relay_openai_routes.js', () => ({
  handleOpenAIChatRequest: jest.fn()
}))
jest.unstable_mockModule('../src/modules/relay/relay_grok_relay_service.js', () => ({
  grokRelayService: {}
}))
jest.unstable_mockModule('../src/modules/relay/relay_gemini_handlers_routes.js', () => ({
  handleStandardGenerateContent: jest.fn(),
  handleStandardStreamGenerateContent: jest.fn()
}))
const { buildGeminiRequestFromOpenAI } =
  await import('../src/modules/relay/relay_unified_routes.js')

const schema = {
  type: 'object',
  $defs: { 'a/b': { type: 'string' } },
  properties: { value: { anyOf: [{ $ref: '#/$defs/a~1b' }, { type: 'null' }] } },
  required: ['value']
}

describe('Gemini JSON Schema and tool continuation', () => {
  it('keeps native references, unions and object constraints without mutating the client schema', () => {
    const input = { ...schema, additionalProperties: false }
    const cleaned = cleanJsonSchemaForGemini(input, { preserveConstraints: true })
    expect(cleaned).toEqual(input)
    cleaned.properties.value.anyOf[0].$ref = 'changed'
    expect(input.properties.value.anyOf[0].$ref).toBe('#/$defs/a~1b')
    const request = buildGeminiRequestFromOpenAI({
      messages: [],
      response_format: { type: 'json_schema', json_schema: { schema: input } }
    })
    expect(request.generationConfig.responseJsonSchema).toEqual(input)
    expect(request.generationConfig.responseSchema).toBeUndefined()
  })

  it('inlines escaped local references and represents nullable unions in the narrow carrier', () => {
    expect(convertAntigravityToolSchema(schema)).toMatchObject({
      type: 'object',
      properties: { value: { type: 'string', nullable: true } },
      required: ['value']
    })
    expect(convertAntigravityToolSchema({ type: ['integer', 'null'] })).toMatchObject({
      type: 'integer',
      nullable: true
    })
    expect(
      convertAntigravityToolSchema({
        type: 'string',
        anyOf: [{ type: 'string' }, { type: 'null' }]
      }).nullable
    ).toBe(false)
  })

  it.each([
    { type: 'object', additionalProperties: false },
    { type: 'string', pattern: '^a$' },
    { type: 'string', enum: ['only'] },
    { anyOf: [{ type: 'string' }, { type: 'number' }] },
    { $ref: 'https://example.invalid/schema' },
    { $defs: { loop: { $ref: '#/$defs/loop' } }, $ref: '#/$defs/loop' }
  ])('rejects constraints that the narrow carrier cannot express', (input) => {
    try {
      convertAntigravityToolSchema(input)
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 400,
        code: 'unsupported_tool_schema',
        response: { status: 400 }
      })
    }
  })

  it('returns the exact Gemini thought signature with a tool result on the next request', () => {
    const converter = new GeminiToOpenAIConverter()
    const response = converter.convertResponse(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'lookup', args: { id: 1 } },
                  thoughtSignature: 'opaque-signature'
                }
              ]
            },
            finishReason: 'STOP'
          }
        ]
      },
      'gemini-3-test'
    )
    const assistant = response.choices[0].message
    const request = buildGeminiRequestFromOpenAI({
      messages: [
        assistant,
        { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'found' }
      ]
    })
    expect(request.contents[0].parts[0]).toEqual({
      functionCall: { name: 'lookup', args: { id: 1 } },
      thoughtSignature: 'opaque-signature'
    })
    expect(request.contents[1].parts[0].functionResponse.name).toBe('lookup')
    const stream = converter.convertStreamChunk(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'stream-signature' }] } }] })}\n\n`,
      'gemini-3-test',
      converter.createStreamState()
    )
    const event = stream
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)))
      .find((value) => value.choices[0].delta.tool_calls)
    expect(event.choices[0].delta.tool_calls[0].extra_content.google.thought_signature).toBe(
      'stream-signature'
    )
  })
})
