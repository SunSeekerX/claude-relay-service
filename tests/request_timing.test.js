import { jest } from '@jest/globals'
import { Readable } from 'node:stream'
import {
  startRequestTiming,
  finishRequestTiming,
  trackRequestTiming,
  startUpstreamTiming,
  finishUpstreamTiming,
  timedUpstreamRequest,
  getRequestTimings,
  normalizeRequestTimings
} from '../src/common/request_timing.js'
import {
  createRequestDetailMeta,
  finalizeRequestDetailMeta,
  buildFailedRequestDetailPayload
} from '../src/modules/relay/relay_request_detail_helper.js'

let now
beforeEach(() => {
  now = 1000
  jest.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => jest.restoreAllMocks())

it('captures stages at their boundaries and resolves metadata after the first content write', () => {
  const req = { requestStartedAt: 1000, firstTokenAt: null, body: { stream: true } }
  startRequestTiming(req, 'authentication')
  now = 1005
  finishRequestTiming(req, 'authentication')
  startRequestTiming(req, 'scheduling')
  now = 1010
  finishRequestTiming(req, 'scheduling')
  const meta = createRequestDetailMeta(req)
  expect(meta.timings.upstreamHeadersMs).toBeNull()
  now = 1020
  startUpstreamTiming(req)
  now = 1030
  finishUpstreamTiming(req)
  now = 1040
  req.firstTokenAt = now
  expect(finalizeRequestDetailMeta(meta).timings).toEqual({
    authenticationMs: 5,
    schedulingMs: 5,
    localPreparationMs: 10,
    upstreamHeadersMs: 10,
    upstreamResponseMs: null,
    firstContentWaitMs: 10,
    upstreamAttempts: 1
  })
  expect(buildFailedRequestDetailPayload({ req, statusCode: 502 }).timings).toEqual(meta.timings)
})

it('retains zero and leaves unobserved stages empty', () => {
  const req = {}
  startRequestTiming(req, 'authentication')
  finishRequestTiming(req, 'authentication')
  expect(getRequestTimings(req)).toMatchObject({
    authenticationMs: 0,
    schedulingMs: null,
    upstreamHeadersMs: null,
    upstreamAttempts: null
  })
  expect(getRequestTimings({})).toBeNull()
  expect(normalizeRequestTimings({ schedulingMs: '10', upstreamHeadersMs: -1 })).toMatchObject({
    schedulingMs: null,
    upstreamHeadersMs: null
  })
})

it('accounts for failed scheduling and adds repeated selections instead of overwriting', async () => {
  const req = {}
  await expect(
    trackRequestTiming(req, 'scheduling', async () => {
      now = 1010
      throw new Error('no account')
    })
  ).rejects.toThrow('no account')
  await trackRequestTiming(req, 'scheduling', async () => {
    now = 1015
    return 'account'
  })
  expect(getRequestTimings(req).schedulingMs).toBe(15)
})

it('keeps the most recent upstream attempt and does not attribute earlier content to it', () => {
  const req = { firstTokenAt: 1010 }
  startUpstreamTiming(req)
  now = 1020
  finishUpstreamTiming(req)
  now = 1030
  startUpstreamTiming(req)
  now = 1040
  finishUpstreamTiming(req)
  expect(getRequestTimings(req)).toMatchObject({
    upstreamHeadersMs: 10,
    upstreamAttempts: 2,
    firstContentWaitMs: null
  })
})

it('distinguishes response headers for streams from a complete JSON response', async () => {
  const json = {}
  await timedUpstreamRequest(json, async () => {
    now = 1020
    return { data: { ok: true } }
  })
  expect(getRequestTimings(json)).toMatchObject({ upstreamHeadersMs: null, upstreamResponseMs: 20 })
  const stream = {}
  await timedUpstreamRequest(stream, async () => {
    now = 1030
    return { data: Readable.from([]) }
  })
  expect(getRequestTimings(stream)).toMatchObject({
    upstreamHeadersMs: 10,
    upstreamResponseMs: null
  })
})
