import zlib from 'node:zlib'
import { Transform, finished } from 'node:stream'
import { requestResourcesConfig } from '../../config/request_resources.js'

const originalRequest = Symbol('originalRequest')
const decodedBytes = Symbol('decodedBytes')

const normalizeBodyHeaders = (req) => {
  if (req[decodedBytes] !== undefined) {
    delete req.headers['content-encoding']
    delete req.headers['transfer-encoding']
    req.headers['content-length'] = String(req[decodedBytes])
  }
}

const drainRequest = (req, callback) => {
  const cleanup = finished(req, { writable: false }, () => {
    cleanup()
    callback()
  })
  req.resume()
}

// Express 负责类型、字符集、JSON strict、verify 和解析；只适配有界解压流。
// br 原生解压只限制输出，本适配还保留既有 chunked 压缩正文输入上限。
export const createRequestBodyParser = (createParser, options) => {
  const parser = createParser({
    ...options,
    type:
      typeof options.type === 'function'
        ? (request) => options.type(request[originalRequest] ?? request)
        : options.type,
    verify: (request, res, buffer, encoding) => {
      const req = request[originalRequest] ?? request
      req[decodedBytes] = buffer.length
      options.verify?.(req, res, buffer, encoding)
    },
  })
  return (req, res, next) => {
    const encoding = String(req.headers['content-encoding'] ?? 'identity')
      .trim()
      .toLowerCase()
    const needsDecoder =
      (encoding === 'zstd' || encoding === 'br') &&
      (typeof options.type === 'function' ? options.type(req) : req.is(options.type))
    if (!needsDecoder) {
      return parser(req, res, (error) => {
        if (!error && encoding !== 'identity') {
          normalizeBodyHeaders(req)
        }
        delete req[decodedBytes]
        next(error)
      })
    }

    const decoder = encoding === 'zstd' ? zlib.createZstdDecompress() : zlib.createBrotliDecompress()
    let inputBytes = 0
    const input = new Transform({
      transform(chunk, _encoding, callback) {
        inputBytes += chunk.length
        if (inputBytes > requestResourcesConfig.maxBodyBytes) {
          return callback(
            Object.assign(new Error('Compressed request body size exceeds limit'), {
              status: 413,
              type: 'entity.too.large',
            }),
          )
        }
        callback(null, chunk)
      },
    })
    decoder[originalRequest] = req
    decoder.headers = { ...req.headers, 'transfer-encoding': 'chunked' }
    delete decoder.headers['content-encoding']
    delete decoder.headers['content-length']
    decoder.socket = req.socket
    Object.defineProperty(decoder, 'complete', { get: () => decoder.destroyed || req.complete })
    const onInputError = (error) => decoder.destroy(error)
    const onAbort = () => decoder.destroy(Object.assign(new Error('Request aborted'), { status: 400 }))
    req.once('aborted', onAbort)
    req.once('error', onInputError)
    input.once('error', onInputError)
    let settled = false
    parser(decoder, res, (error) => {
      settled = true
      req.unpipe(input)
      input.unpipe(decoder)
      input.destroy()
      decoder.destroy()
      req.removeListener('aborted', onAbort)
      req.removeListener('error', onInputError)
      if (!error) {
        req.body = decoder.body
        normalizeBodyHeaders(req)
      }
      delete req[decodedBytes]
      if (error && !req.aborted) {
        // 不用 pipeline 销毁 IncomingMessage，保留错误响应及 keep-alive 的下一请求。
        drainRequest(req, () => next(error))
      } else {
        next(error)
      }
    })
    if (!settled) {
      req.pipe(input).pipe(decoder)
    }
  }
}
