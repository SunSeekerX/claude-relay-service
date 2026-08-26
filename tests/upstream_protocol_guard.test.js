import { isNonProtocolUpstreamBody } from '../src/modules/relay/relay_upstream_protocol_guard.js'

describe('isNonProtocolUpstreamBody', () => {
  test('2xx never non-protocol', () => {
    expect(
      isNonProtocolUpstreamBody({
        statusCode: 200,
        contentType: 'text/plain',
        bodyText: 'upstream unavailable'
      })
    ).toBe(false)
  })

  test('text/plain 5xx non-json is non-protocol', () => {
    expect(
      isNonProtocolUpstreamBody({
        statusCode: 502,
        contentType: 'text/plain',
        bodyText: 'upstream unavailable'
      })
    ).toBe(true)
    expect(
      isNonProtocolUpstreamBody({
        statusCode: 503,
        contentType: 'text/plain',
        bodyText: 'custom gateway error page'
      })
    ).toBe(true)
  })

  test('json error body is protocol', () => {
    expect(
      isNonProtocolUpstreamBody({
        statusCode: 429,
        contentType: 'application/json',
        bodyText: '{"error":{"type":"rate_limit"}}'
      })
    ).toBe(false)
  })

  test('marked json but plain body is non-protocol', () => {
    expect(
      isNonProtocolUpstreamBody({
        statusCode: 502,
        contentType: 'application/json',
        bodyText: 'Bad Gateway'
      })
    ).toBe(true)
  })

  test('html is non-protocol', () => {
    expect(
      isNonProtocolUpstreamBody({
        statusCode: 502,
        contentType: 'text/html',
        bodyText: '<!doctype html><html>'
      })
    ).toBe(true)
  })

  test('empty body 5xx without content-type is non-protocol', () => {
    expect(
      isNonProtocolUpstreamBody({
        statusCode: 502,
        contentType: '',
        bodyText: ''
      })
    ).toBe(true)
  })

  test('empty body 4xx without content-type is not auto non-protocol', () => {
    expect(
      isNonProtocolUpstreamBody({
        statusCode: 404,
        contentType: '',
        bodyText: ''
      })
    ).toBe(false)
  })
})
