import { describe, expect, test } from '@jest/globals'
import { listModels } from '@factory/droid-sdk/node'

describe('installed Droid SDK model discovery contract', () => {
  test('an in-memory native transport lists models without initializing a session or spawning a CLI', async () => {
    let onMessage
    let onError
    let closed = 0
    const requests = []
    const transport = {
      isConnected: true,
      connect: async () => {},
      onMessage: (handler) => {
        onMessage = handler
      },
      onError: (handler) => {
        onError = handler
      },
      close: async () => {
        closed += 1
      },
      send: async (message) => {
        requests.push(message)
        queueMicrotask(() =>
          onMessage({
            factoryApiVersion: message.factoryApiVersion,
            factoryProtocolVersion: message.factoryProtocolVersion,
            type: 'response',
            jsonrpc: '2.0',
            id: message.id,
            result: { models: [] },
          }),
        )
      },
    }
    const timeout = setTimeout(() => onError?.(new Error('fixture transport deadline')), 2000)
    try {
      const result = await listModels({ transport })
      expect(result).toEqual([])
      expect(requests.map((request) => request.method)).toEqual(['droid.list_models'])
      expect(closed).toBe(1)
    } finally {
      clearTimeout(timeout)
    }
  })
})
