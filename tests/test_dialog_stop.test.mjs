import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'

const load = createRequire(path.resolve('web/admin-spa/package.json'))
const { ref, computed } = load('vue')
const raw = await readFile('web/admin-spa/src/libs/use_test_state.js', 'utf8')
const source = raw.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace('export const useTestState', 'const useTestState')
const makeState = (request) => new Function('ref', 'computed', 'onUnmounted', 'createHttp', 'isOk', 'msgOf', source + '\nreturn useTestState()')(
  ref, computed, () => {}, () => request, (result) => result.code === 200, (result, fallback) => result.msg ?? fallback
)
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('stopping aborts the request, retains partial output and allows another test', async () => {
  let responseStream
  let signal
  const state = makeState(async (request) => {
    signal = request.signal
    return new Response(new ReadableStream({ start(controller) { responseStream = controller } }))
  })
  const running = state.sendTestRequest('/fixture', { model: 'm' })
  await flush()
  responseStream.enqueue(new TextEncoder().encode('data: {"type":"content","text":"partial"}\n\n'))
  await flush()
  assert.equal(state.responseText.value, 'partial')
  state.stopTest()
  assert.equal(signal.aborted, true)
  assert.equal(state.testStatus.value, 'cancelled')
  assert.equal(state.responseText.value, 'partial')
  responseStream.close()
  await running
  assert.equal(state.testStatus.value, 'cancelled')
})

test('late completion from a stopped test cannot overwrite a retry result', async () => {
  const requests = []
  const state = makeState((request) => new Promise((resolve) => requests.push({ request, resolve })))
  const first = state.sendTestRequest('/first', { model: 'first' }, { useSSE: false })
  state.stopTest()
  const second = state.sendTestRequest('/second', { model: 'second' }, { useSSE: false })
  requests[1].resolve(new Response(JSON.stringify({ code: 200, data: { responseText: 'second result' } })))
  await second
  requests[0].resolve(new Response(JSON.stringify({ code: 200, data: { responseText: 'stale result' } })))
  await first
  assert.equal(state.testStatus.value, 'success')
  assert.equal(state.responseText.value, 'second result')
  assert.equal(requests[0].request.signal.aborted, true)
})

test('normal success and server failure remain distinct after adding stop controls', async () => {
  const state = makeState(async () => new Response('data: {"type":"test_complete","success":false,"error":"model unavailable"}\n\n'))
  await state.sendTestRequest('/fixture', { model: 'm' })
  assert.equal(state.testStatus.value, 'error')
  assert.equal(state.errorMessage.value, 'model unavailable')
  state.stopTest()
  assert.equal(state.testStatus.value, 'error')
})
