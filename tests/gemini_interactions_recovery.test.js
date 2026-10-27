import { jest } from '@jest/globals'
import { recoverLegacyGeminiInteractions } from '../scripts/migrate-gemini-interactions-pending.js'

it('inspects every bounded scan page without writing by default', async () => {
  const redis = {
    scanLegacyGeminiInteractions: jest
      .fn()
      .mockResolvedValueOnce({ cursor: '7', records: [{ key: 'one', ownerId: 'owner', id: 'first' }] })
      .mockResolvedValueOnce({ cursor: '0', records: [{ key: 'two', ownerId: 'owner', id: 'second' }] }),
    requeueLegacyGeminiInteraction: jest.fn()
  }
  const onRecord = jest.fn()
  expect(await recoverLegacyGeminiInteractions(redis, { onRecord })).toEqual({
    apply: false,
    candidates: 2,
    requeued: 0
  })
  expect(redis.scanLegacyGeminiInteractions.mock.calls).toEqual([['0'], ['7']])
  expect(redis.requeueLegacyGeminiInteraction).not.toHaveBeenCalled()
  expect(onRecord.mock.calls).toEqual([
    [{ ownerId: 'owner', interactionId: 'first', requeued: false }],
    [{ ownerId: 'owner', interactionId: 'second', requeued: false }]
  ])
})

it('restores queue membership only with explicit apply and reports concurrent skips', async () => {
  const redis = {
    scanLegacyGeminiInteractions: jest.fn().mockResolvedValue({
      cursor: '0',
      records: [
        { key: 'one', ownerId: 'owner', id: 'first' },
        { key: 'two', ownerId: 'owner', id: 'second' }
      ]
    }),
    requeueLegacyGeminiInteraction: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0)
  }
  expect(await recoverLegacyGeminiInteractions(redis, { apply: true })).toEqual({
    apply: true,
    candidates: 2,
    requeued: 1
  })
  expect(redis.requeueLegacyGeminiInteraction.mock.calls).toEqual([['one'], ['two']])
})
