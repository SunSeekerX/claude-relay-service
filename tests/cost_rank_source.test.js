import { jest } from '@jest/globals'
const sdiff = jest.fn()
const scanApiKeyIdsFromHashes = jest.fn()
const batchGetApiKeys = jest.fn()
const isIndexReady = jest.fn()
jest.unstable_mockModule('../src/common/logger.js', () => ({
  logger: new Proxy({}, { get: () => jest.fn() })
}))
jest.unstable_mockModule('../src/infra/redis.js', () => ({
  redis: { getClientSafe: () => ({ sdiff }), scanApiKeyIdsFromHashes, batchGetApiKeys }
}))
jest.unstable_mockModule('../src/modules/apikey/apikey_index_service.js', () => ({
  apiKeyIndexService: { isIndexReady }
}))
const { costRankService } = await import('../src/modules/pricing/pricing_cost_rank_service.js')
beforeEach(() => jest.clearAllMocks())

describe('cost rank key source', () => {
  it('uses the ready ID index without loading every key hash', async () => {
    isIndexReady.mockResolvedValue(true)
    sdiff.mockResolvedValue(['active', 'disabled'])
    expect(await costRankService._getActiveApiKeyIds()).toEqual(['active', 'disabled'])
    expect(scanApiKeyIdsFromHashes).not.toHaveBeenCalled()
    expect(batchGetApiKeys).not.toHaveBeenCalled()
  })
  it('falls back to actual hashes during an index rebuild and retains disabled keys', async () => {
    isIndexReady.mockResolvedValue(false)
    scanApiKeyIdsFromHashes.mockResolvedValue(['active', 'disabled', 'deleted'])
    batchGetApiKeys.mockResolvedValue([
      { id: 'active', isDeleted: false },
      { id: 'disabled', isDeleted: false, isActive: false },
      { id: 'deleted', isDeleted: true }
    ])
    expect(await costRankService._getActiveApiKeyIds()).toEqual(['active', 'disabled'])
    expect(sdiff).not.toHaveBeenCalled()
  })
})
