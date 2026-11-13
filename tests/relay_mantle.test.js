import { jest, expect, test } from '@jest/globals'
import { Readable, Writable } from 'node:stream'

const axios = jest.fn()
jest.unstable_mockModule('axios', () => ({ default: axios }))
jest.unstable_mockModule('../src/common/logger.js', () => ({ logger: new Proxy({}, { get: () => jest.fn() }) }))
jest.unstable_mockModule('../src/modules/proxy/proxy_resolver.js', () => ({
  proxyResolver: { resolveAgent: () => ({}), report: jest.fn() },
}))
const { buildMantleRequest, relayBedrockMantle } = await import('../src/modules/relay/relay_bedrock_mantle.js')

const account = { region: 'us-east-1', credentialType: 'bearer_token', bearerToken: 'fixture' }
test('Mantle uses the Messages body and header without InvokeModel mutations', async () => {
  const input = {
    model: 'anthropic.claude-fable-5-2',
    max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 24576 },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'test', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ],
  }
  const request = await buildMantleRequest(input, account)
  expect(request.url).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages')
  expect(request.headers['x-api-key']).toBe('fixture')
  expect(JSON.parse(request.data)).toMatchObject({
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    messages: input.messages,
  })
  expect(JSON.parse(request.data).anthropic_version).toBeUndefined()
})
test('IAM credentials sign for the Mantle service and preserve temporary session tokens', async () => {
  const request = await buildMantleRequest(
    { model: 'anthropic.claude-opus-5-5', messages: [] },
    {
      region: 'us-east-1',
      credentialType: 'access_key',
      awsCredentials: {
        accessKeyId: 'fixture-id',
        secretAccessKey: 'fixture-secret',
        sessionToken: 'fixture-session',
      },
    },
  )
  expect(request.headers.authorization).toContain('/us-east-1/bedrock-mantle/aws4_request')
  expect(request.headers['x-amz-security-token']).toBe('fixture-session')
})
test('Mantle streaming retains additive cache usage and requires message_stop', async () => {
  const wire =
    'data:{"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":8}}}\n\n' +
    'data:{"type":"message_delta","usage":{"output_tokens":3}}\n\n' +
    'data:{"type":"message_stop"}\n\n'
  const response = () => {
    const target = new Writable({
      write(_chunk, _encoding, done) {
        done()
      },
    })
    target.status = () => target
    target.setHeader = () => {}
    return target
  }
  axios.mockResolvedValueOnce({ status: 200, headers: {}, data: Readable.from([wire]) })
  const result = await relayBedrockMantle({ model: 'anthropic.claude-opus-5-5', stream: true }, account, response(), {})
  expect(result).toMatchObject({
    success: true,
    protocolTerminal: 'message_stop',
    usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 8 },
  })
  axios.mockResolvedValueOnce({
    status: 200,
    headers: {},
    data: Readable.from([wire.replace('data:{"type":"message_stop"}\n\n', '')]),
  })
  expect(
    await relayBedrockMantle({ model: 'anthropic.claude-opus-5-5', stream: true }, account, response(), {}),
  ).toMatchObject({ success: false, statusCode: 502 })
})
