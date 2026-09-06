import {
  extractMultipartFormField,
  rewriteMultipartFormField,
  parseMultipartBoundaryFromContentType,
} from '../src/modules/relay/relay_multipart_form_field.js'
import { extractClientErrorSummary } from '../src/modules/relay/relay_request_detail_helper.js'

describe('multipart form field helpers (RFC boundary + binary-safe)', () => {
  const contentType = 'multipart/form-data; boundary=bound'

  const buildBody = (model, fileBytes) => {
    const mid = Buffer.from(
      [
        '--bound',
        'Content-Disposition: form-data; name="model"',
        '',
        model,
        '--bound',
        'Content-Disposition: form-data; name="file"; filename="a.wav"',
        'Content-Type: audio/wav',
        '',
      ].join('\r\n'),
      'utf8',
    )
    const close = Buffer.from('\r\n--bound--\r\n', 'utf8')
    return Buffer.concat([mid, fileBytes, close])
  }

  test('parse boundary from content-type', () => {
    expect(parseMultipartBoundaryFromContentType(contentType)).toBe('bound')
    expect(parseMultipartBoundaryFromContentType('multipart/form-data; boundary="abc-1"')).toBe(
      'abc-1',
    )
  })

  test('boundary param ignores x-boundary prefix spoof', () => {
    expect(
      parseMultipartBoundaryFromContentType(
        'multipart/form-data; x-boundary=fake; boundary=real',
      ),
    ).toBe('real')
    expect(
      parseMultipartBoundaryFromContentType(
        'multipart/form-data; boundary=real; x-boundary=fake',
      ),
    ).toBe('real')
  })

  test('boundary param ignores quoted semicolon spoof', () => {
    expect(
      parseMultipartBoundaryFromContentType(
        'multipart/form-data; note="x; boundary=fake; y"; boundary=real',
      ),
    ).toBe('real')
    expect(
      parseMultipartBoundaryFromContentType(
        'multipart/form-data; boundary="real-bound"; note="x; boundary=fake"',
      ),
    ).toBe('real-bound')
  })

  test('boundary param handles dotted name and escaped quote spoof', () => {
    expect(
      parseMultipartBoundaryFromContentType(
        'multipart/form-data; note.ext="x\\"; boundary=fake; y"; boundary=real',
      ),
    ).toBe('real')
  })

  test('boundary quoted-pair is decoded', () => {
    expect(
      parseMultipartBoundaryFromContentType('multipart/form-data; boundary="real\\-bound"'),
    ).toBe('real-bound')
  })

  test('extract model ignores embedded boundary-like bytes in file', () => {
    const spoof = Buffer.from('ABC--boundXYZ name="model"\r\n\r\nfake-model', 'utf8')
    const body = buildBody('real-model', spoof)
    expect(extractMultipartFormField(body, 'model', { contentType })).toBe('real-model')
    const next = rewriteMultipartFormField(body, 'model', 'whisper-1', { contentType })
    expect(extractMultipartFormField(next, 'model', { contentType })).toBe('whisper-1')
    expect(next.includes(spoof)).toBe(true)
  })

  test('rewrite keeps binary file intact', () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x01, 0x02, 0xff])
    const body = buildBody('alias', binary)
    const next = rewriteMultipartFormField(body, 'model', 'whisper-1', { contentType })
    expect(extractMultipartFormField(next, 'model', { contentType })).toBe('whisper-1')
    expect(next.includes(binary)).toBe(true)
    expect(next.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false)
  })

  test('text part with Content-Type still readable', () => {
    const body = Buffer.from(
      [
        '--bound',
        'Content-Disposition: form-data; name="model"',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'gpt-4o-mini-tts',
        '--bound--',
        '',
      ].join('\r\n'),
      'utf8',
    )
    expect(extractMultipartFormField(body, 'model', { contentType })).toBe('gpt-4o-mini-tts')
  })

  test('delimiter allows trailing linear whitespace before CRLF', () => {
    const body = Buffer.from(
      '--bound \t\r\nContent-Disposition: form-data; name="model"\r\n\r\npadded-model\r\n--bound--\r\n',
      'utf8',
    )
    expect(
      extractMultipartFormField(body, 'model', {
        contentType: 'multipart/form-data; boundary=bound',
      }),
    ).toBe('padded-model')
  })
})

describe('extractClientErrorSummary nested response.error', () => {
  test('reads response.failed nested error', () => {
    const summary = extractClientErrorSummary({
      type: 'response.failed',
      response: {
        error: {
          code: 'invalid_prompt',
          message: 'bad prompt text',
        },
      },
    })
    expect(summary.errorCode).toBe('invalid_prompt')
    expect(summary.errorMessage).toContain('bad prompt')
  })
})

describe('multipart name field parsing hardening', () => {
  test('x-name cannot spoof model field', () => {
    const body = Buffer.from(
      [
        '--bound',
        'Content-Disposition: form-data; name=prompt; x-name="model"',
        '',
        'fake-as-model',
        '--bound',
        'Content-Disposition: form-data; name=model',
        '',
        'real-model',
        '--bound--',
        '',
      ].join('\r\n'),
      'utf8',
    )
    expect(
      extractMultipartFormField(body, 'model', {
        contentType: 'multipart/form-data; boundary=bound',
      }),
    ).toBe('real-model')
  })

  test('single-quoted name is rejected', () => {
    const body = Buffer.from(
      [
        '--bound',
        "Content-Disposition: form-data; name='model'",
        '',
        'quoted-single',
        '--bound--',
        '',
      ].join('\r\n'),
      'utf8',
    )
    expect(
      extractMultipartFormField(body, 'model', {
        contentType: 'multipart/form-data; boundary=bound',
      }),
    ).toBe(null)
  })

  test('apostrophe is a legal boundary token character', () => {
    expect(
      parseMultipartBoundaryFromContentType("multipart/form-data; boundary='real"),
    ).toBe("'real")
    const body = Buffer.from(
      [
        "--'real",
        'Content-Disposition: form-data; name="model"',
        '',
        'real-model',
        "--'real--",
        '',
      ].join('\r\n'),
      'utf8',
    )
    expect(
      extractMultipartFormField(body, 'model', {
        contentType: "multipart/form-data; boundary='real",
      }),
    ).toBe('real-model')
  })

  test('content-type present does not fall back to leading fake delimiter', () => {
    const body = Buffer.from(
      [
        '--fake',
        'Content-Disposition: form-data; name="model"',
        '',
        'fake-model',
        '--fake--',
        '',
        "--'real",
        'Content-Disposition: form-data; name="model"',
        '',
        'real-model',
        "--'real--",
        '',
      ].join('\r\n'),
      'utf8',
    )
    expect(
      extractMultipartFormField(body, 'model', {
        contentType: "multipart/form-data; boundary='real",
      }),
    ).toBe('real-model')
  })

  test('name inside other quoted param cannot spoof field', () => {
    const body = Buffer.from(
      [
        '--bound',
        'Content-Disposition: form-data; note="x; name=model; y"; name=prompt',
        '',
        'real-prompt',
        '--bound',
        'Content-Disposition: form-data; name="model"',
        '',
        'real-model',
        '--bound--',
        '',
      ].join('\r\n'),
      'utf8',
    )
    expect(
      extractMultipartFormField(body, 'model', {
        contentType: 'multipart/form-data; boundary=bound',
      }),
    ).toBe('real-model')
    expect(
      extractMultipartFormField(body, 'prompt', {
        contentType: 'multipart/form-data; boundary=bound',
      }),
    ).toBe('real-prompt')
  })
})
