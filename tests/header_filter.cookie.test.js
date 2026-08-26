import { filterForOpenAI, filterForGemini, filterForGrok } from '../src/modules/relay/relay_header_filter.js'

describe('headerFilter credential strip', () => {
  test('filterForOpenAI strips cookie and authorization', () => {
    const out = filterForOpenAI({
      cookie: 'adminToken=secret',
      authorization: 'Bearer x',
      'x-api-key': 'k',
      originator: 'codex_cli_rs',
      'x-client-request-id': 'rid'
    })
    expect(out.cookie).toBeUndefined()
    expect(out.authorization).toBeUndefined()
    expect(out['x-api-key']).toBeUndefined()
    expect(out.originator).toBe('codex_cli_rs')
    expect(out['x-client-request-id']).toBe('rid')
  })

  test('filterForGemini/Grok also strip cookie', () => {
    for (const fn of [filterForGemini, filterForGrok]) {
      const out = fn({ cookie: 'a=b', 'user-agent': 'x' })
      expect(out.cookie).toBeUndefined()
    }
  })
})
