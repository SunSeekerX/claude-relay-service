import { expect, jest, test } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import http from 'node:http'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { verifyJsonBody } from '../src/common/json_body.js'

jest.unstable_mockModule('../config/request_resources.js', () => ({ requestResourcesConfig: { maxBodyBytes: 1024 } }))
const { createRequestBodyParser } = await import('../src/infra/middleware_request_decompress.js')

const compress = {
  identity: (buffer) => buffer,
  gzip: zlib.gzipSync,
  deflate: zlib.deflateSync,
  br: zlib.brotliCompressSync,
  zstd: zlib.zstdCompressSync,
}
const makeApp = (kind = 'json', extra = {}) => {
  const app = express()
  const options = {
    type: { json: 'application/json', raw: () => true, urlencoded: 'application/x-www-form-urlencoded' }[kind],
    limit: 1024,
    ...(kind === 'urlencoded' ? { extended: true } : {}),
    verify: kind === 'json' ? verifyJsonBody : undefined,
    ...extra,
  }
  app.use(createRequestBodyParser(express[kind], options))
  app.post('/echo', (req, res) =>
    res.json({
      parsed: req.body !== undefined,
      body: Buffer.isBuffer(req.body) ? req.body.toString('base64') : req.body,
      encoding: req.headers['content-encoding'],
      length: req.headers['content-length'],
      isOriginalRequest: typeof req.get === 'function' && req.method === 'POST',
    }),
  )
  app.use((error, _req, res, _next) =>
    res.status(error.statusCode ?? error.status ?? 500).json({ error: error.type, message: error.message }),
  )
  return app
}
const send = (app, body, encoding, type = 'application/json') =>
  request(app)
    .post('/echo')
    .set('content-type', type)
    .set('content-encoding', encoding)
    .serialize((value) => value)
    .send(compress[encoding](body))

test.each(Object.keys(compress))('preserves JSON semantics and normalizes decoded %s headers', async (encoding) => {
  const body = Buffer.from('\ufeff{"text":"中文𠀋","array":[1,2]}')
  const response = await send(makeApp(), body, encoding)
  expect(response.status).toBe(200)
  expect(response.body.body).toEqual({ text: '中文𠀋', array: [1, 2] })
  expect(response.body.isOriginalRequest).toBe(true)
  if (encoding !== 'identity') {
    expect(response.body.encoding).toBeUndefined()
    expect(Number(response.body.length)).toBe(body.length)
  }
})

test.each(['br', 'zstd'])('keeps raw and URL-encoded contracts for %s', async (encoding) => {
  const bytes = Buffer.from([0, 0xff, 0xe4, 13, 10])
  const raw = await send(makeApp('raw'), bytes, encoding, 'application/octet-stream')
  expect(raw.status).toBe(200)
  expect(raw.body.body).toBe(bytes.toString('base64'))
  const form = await send(
    makeApp('urlencoded'),
    Buffer.from('a=1&a=2&x[y]=three'),
    encoding,
    'application/x-www-form-urlencoded',
  )
  expect(form.status).toBe(200)
  expect(form.body.body).toEqual({ a: ['1', '2'], x: { y: 'three' } })
})

test.each(['identity', 'br', 'zstd'])(
  'preserves strict JSON, empty whitespace and charset errors for %s',
  async (encoding) => {
    expect((await send(makeApp(), Buffer.from('true'), encoding)).status).toBe(400)
    expect((await send(makeApp(), Buffer.from('   \r\n'), encoding)).status).toBe(403)
    expect((await send(makeApp(), Buffer.from('{}'), encoding, 'application/json; charset=latin1')).status).toBe(415)
    expect((await send(makeApp(), Buffer.from(''), encoding)).body.body).toEqual({})
  },
)

test.each(['br', 'zstd'])('preserves compressed and decoded size limits for %s', async (encoding) => {
  expect((await send(makeApp(), Buffer.from(JSON.stringify({ text: 'x'.repeat(2048) })), encoding)).status).toBe(413)
  const raw = crypto.randomBytes(1024)
  expect(compress[encoding](raw).length).toBeGreaterThan(1024)
  expect((await send(makeApp('raw'), raw, encoding, 'application/octet-stream')).status).toBe(413)
})

test('passes the actual Express request to custom type and verify callbacks', async () => {
  const verify = jest.fn()
  const app = makeApp('raw', { type: (req) => req.path === '/echo', verify })
  expect((await send(app, Buffer.from('fixture'), 'zstd', 'application/octet-stream')).status).toBe(200)
  expect(verify.mock.calls[0][0].path).toBe('/echo')
  const unused = await send(makeApp(), Buffer.from('not a compressed JSON body'), 'identity', 'text/plain')
  expect(unused.body.parsed).toBe(false)
})

test('a malformed compressed body can return an error and reuse the same client socket', async () => {
  const server = makeApp().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const post = (body, encoding) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: '/echo',
          method: 'POST',
          agent,
          headers: { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': body.length },
        },
        (res) => {
          res.resume()
          res.once('end', () => resolve({ status: res.statusCode, reused: req.reusedSocket }))
        },
      )
      req.once('error', reject)
      req.end(body)
    })
  try {
    expect((await post(Buffer.from('invalid'), 'zstd')).status).toBe(400)
    expect(await post(Buffer.from('{}'), 'identity')).toEqual({ status: 200, reused: true })
  } finally {
    agent.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('starts decoding before the client finishes uploading its compressed body', async () => {
  let observed
  const firstWrite = new Promise((resolve) => {
    observed = resolve
  })
  const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createZstdDecompress')
  Object.defineProperty(zlib, 'createZstdDecompress', {
    ...descriptor,
    value: (...args) => {
      const decoder = descriptor.value(...args)
      const write = decoder.write.bind(decoder)
      decoder.write = (...values) => {
        observed()
        return write(...values)
      }
      return decoder
    },
  })
  const server = makeApp().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const body = zlib.zstdCompressSync(Buffer.from('{"text":"fixture"}'))
  let client
  try {
    const response = new Promise((resolve, reject) => {
      client = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: '/echo',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
        },
        (res) => {
          res.resume()
          res.once('end', () => resolve(res.statusCode))
        },
      )
      client.once('error', reject)
    })
    client.write(body.subarray(0, 10))
    await firstWrite
    expect(client.writableEnded).toBe(false)
    client.end(body.subarray(10))
    expect(await response).toBe(200)
  } finally {
    Object.defineProperty(zlib, 'createZstdDecompress', descriptor)
    client?.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the fast blank-body check preserves trim semantics and avoids decoding ordinary JSON', () => {
  for (const text of [' ', '\t\r\n', '\u00a0', '\ufeff', '{}', ' [1] ', '\u0085', '中', '\u2003']) {
    const invoke = () => verifyJsonBody({}, {}, Buffer.from(text), 'utf-8')
    if (text && !text.trim()) {
      expect(invoke).toThrow('Invalid JSON: empty body')
    } else {
      expect(invoke).not.toThrow()
    }
  }
  const bytes = Buffer.from(`{"value":"${'x'.repeat(1024)}"}`)
  const decode = jest.spyOn(bytes, 'toString')
  verifyJsonBody({}, {}, bytes, 'utf-8')
  expect(decode).not.toHaveBeenCalled()
})
