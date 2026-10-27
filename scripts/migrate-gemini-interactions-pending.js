import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

export const recoverLegacyGeminiInteractions = async (redis, { apply = false, onRecord = () => {} } = {}) => {
  let cursor = '0'
  let candidates = 0
  let requeued = 0
  do {
    const { cursor: nextCursor, records } = await redis.scanLegacyGeminiInteractions(cursor)
    cursor = nextCursor
    for (const record of records) {
      candidates++
      const restored = apply ? Number(await redis.requeueLegacyGeminiInteraction(record.key)) === 1 : false
      if (restored) {
        requeued++
      }
      onRecord({ ownerId: record.ownerId, interactionId: record.id, requeued: restored })
    }
  } while (cursor !== '0')
  return { apply, candidates, requeued }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } })
  const { redis } = await import('../src/infra/redis.js')
  try {
    await redis.connect()
    const result = await recoverLegacyGeminiInteractions(redis, {
      apply: values.apply,
      onRecord: (record) => console.log(JSON.stringify(record))
    })
    console.log(JSON.stringify(result))
  } finally {
    await redis.disconnect()
  }
}
