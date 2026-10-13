import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { createStreamBackpressure } from '../src/common/stream_helper.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

it('pauses a real readable until a slow writable drains, retaining every chunk', async () => {
  const source = Readable.from(['first', 'second', 'third'], { highWaterMark: 1 })
  const written = []
  const callbacks = []
  const destination = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      written.push(String(chunk))
      callbacks.push(done)
    }
  })
  const backpressure = createStreamBackpressure(source, destination)
  source.on('data', (chunk) => {
    if (!destination.write(chunk)) {
      backpressure.waitForDrain()
    }
  })
  await tick()
  expect(written).toEqual(['first'])
  expect(source.isPaused()).toBe(true)
  callbacks.shift()()
  await tick()
  expect(written).toEqual(['first', 'second'])
  callbacks.shift()()
  await tick()
  expect(written).toEqual(['first', 'second', 'third'])
  callbacks.shift()()
  await tick()
  backpressure.dispose()
  expect(destination.listenerCount('drain')).toBe(0)
  destination.end()
})

it('resumes usage draining when the blocked client closes and cleans up listeners', async () => {
  const source = Readable.from(['pending', 'terminal-usage'], { highWaterMark: 1 })
  const destination = new Writable({ highWaterMark: 1, write() {} })
  const backpressure = createStreamBackpressure(source, destination)
  const drained = []
  let pending
  source.on('data', (chunk) => {
    drained.push(String(chunk))
    if (drained.length === 1) {
      destination.write(chunk)
      pending = backpressure.waitForDrain()
    }
  })
  await tick()
  destination.destroy()
  expect(await pending).toBe(false)
  await tick()
  expect(drained).toEqual(['pending', 'terminal-usage'])
  expect(destination.listenerCount('drain')).toBe(0)
  expect(source.listenerCount('error')).toBe(0)
})

it.each(['error', 'close'])(
  'unblocks on upstream %s without leaving a drain listener',
  async (event) => {
    const source = new EventEmitter()
    source.pause = jest.fn()
    source.resume = jest.fn()
    const destination = new EventEmitter()
    const backpressure = createStreamBackpressure(source, destination)
    const pending = backpressure.waitForDrain()
    expect(backpressure.waitForDrain()).toBe(pending)
    source.emit(event, new Error('transport ended'))
    expect(await pending).toBe(true)
    expect(source.resume).toHaveBeenCalledTimes(1)
    expect(destination.listenerCount('drain')).toBe(0)
    backpressure.dispose()
    expect(source.resume).toHaveBeenCalledTimes(1)
  }
)

it('skips waiting after the destination is already closed', async () => {
  const source = { pause: jest.fn(), resume: jest.fn() }
  const backpressure = createStreamBackpressure(source, { destroyed: true })
  expect(await backpressure.waitForDrain()).toBe(false)
  expect(source.pause).not.toHaveBeenCalled()
})

it('does not wait for an already closed upstream during the final buffer flush', async () => {
  const source = { closed: true, pause: jest.fn() }
  expect(await createStreamBackpressure(source, {}).waitForDrain()).toBe(true)
  expect(source.pause).not.toHaveBeenCalled()
})

it('treats a client write error as a disconnect even before destroyed is set', async () => {
  const source = new EventEmitter()
  source.pause = jest.fn()
  source.resume = jest.fn()
  const destination = new EventEmitter()
  const pending = createStreamBackpressure(source, destination).waitForDrain()
  destination.emit('error', new Error('fixture write error'))
  expect(await pending).toBe(false)
  expect(source.resume).toHaveBeenCalledTimes(1)
})
