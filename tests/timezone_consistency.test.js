import * as commonHelper from '../src/common/common_helper.js'
import { redis } from '../src/infra/redis.js'
import * as timezone from '../src/common/timezone.js'
describe('timezone helper consistency', () => {
  test('commonHelper and redis use the same shifted date helpers', () => {
    const source = new Date('2026-04-06T20:15:30.000Z')

    expect(commonHelper.getDateInTimezone(source).toISOString()).toBe(
      timezone.getDateInTimezone(source, 8).toISOString()
    )
    expect(commonHelper.getDateStringInTimezone(source)).toBe(
      timezone.getDateStringInTimezone(source, 8)
    )
    expect(redis.getDateInTimezone(source).toISOString()).toBe(
      timezone.getDateInTimezone(source, 8).toISOString()
    )
    expect(redis.getDateStringInTimezone(source)).toBe(timezone.getDateStringInTimezone(source, 8))
  })
})
