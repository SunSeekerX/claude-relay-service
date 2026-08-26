import { EventEmitter } from 'node:events'
import { onClientDisconnect } from '../src/common/client_disconnect.js'

describe('onClientDisconnect', () => {
  test('normal end (writableEnded=true) does not fire disconnect', () => {
    const res = new EventEmitter()
    res.writableEnded = false
    res.destroyed = false
    let called = 0
    const detach = onClientDisconnect(res, () => {
      called += 1
    })
    res.writableEnded = true
    res.emit('close')
    expect(called).toBe(0)
    detach()
  })

  test('true disconnect (writableEnded=false) fires once', () => {
    const res = new EventEmitter()
    res.writableEnded = false
    res.destroyed = false
    let called = 0
    onClientDisconnect(res, () => {
      called += 1
    })
    res.emit('close')
    res.emit('close')
    expect(called).toBe(1)
  })

  test('already destroyed before register fires immediately', () => {
    const res = new EventEmitter()
    res.writableEnded = false
    res.destroyed = true
    let called = 0
    onClientDisconnect(res, () => {
      called += 1
    })
    expect(called).toBe(1)
  })
})
