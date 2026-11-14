import { expect, jest, test } from '@jest/globals'
import { formatConsoleEntry } from '../src/common/console_output.js'
import { copyLogSnippet } from '../src/common/http_access_log.js'

test('compact success logs never build the metadata tree; detailed and warning logs do', () => {
  const lines = jest.fn(() => ['retained-detail'])
  const entry = {
    level: 'info',
    message: '200 POST /responses',
    timestamp: 'fixture',
    _accessMetaLines: lines,
    model: 'actual',
    accountId: 'a',
    protocolTerminal: 'response.completed',
    usage: { totalTokens: 42, cost: 0.01 },
  }
  expect(formatConsoleEntry(entry)).toContain('tokens=42')
  expect(lines).not.toHaveBeenCalled()
  expect(formatConsoleEntry(entry, { detailed: true })).toContain('retained-detail')
  expect(formatConsoleEntry({ ...entry, level: 'warn' })).toContain('retained-detail')
  expect(lines).toHaveBeenCalledTimes(2)
})

test('copied error snippets preserve exact UTF-16 truncation, including a split surrogate pair', () => {
  const text = `${'x'.repeat(1999)}𠀋${'tail'.repeat(100000)}`
  expect(copyLogSnippet(text)).toBe(text.slice(0, 2000))
  expect(copyLogSnippet('short')).toBe('short')
})
