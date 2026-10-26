import { afterAll, describe, expect, jest, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { countContentCtok, ctokCacheModelKey, ctokVersion } from '../src/modules/tokenizer/tokenizer_ctok.js'
import { extractCountTexts } from '../src/modules/tokenizer/tokenizer_text.js'
import { loadBpeDefinition, tokenizerForOpenaiModel } from '../src/modules/tokenizer/tokenizer_bpe.js'

const poolConfig = {
  workers: 1,
  queue: 0,
  maxPendingBytes: 16 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  queueTimeoutMs: 250,
  countTimeoutMs: 2000,
}
await jest.unstable_mockModule('../config/tokenizers.js', () => ({ tokenizerConfig: poolConfig }))
const { runLocalTokenizer, closeTokenizerWorkers, tokenizerPoolStatus } =
  await import('../src/modules/tokenizer/tokenizer_count_pool.js')
afterAll(closeTokenizerWorkers)

describe('ported ctok reference vectors', () => {
  test('retains the llysc 1.3.0 reference costs across vocabulary families', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/claude_ctok_1_3_0.json', import.meta.url), 'utf8'))
    expect(ctokVersion).toBe('1.3.0')
    for (const model of ['claude-opus-4-5', 'claude-opus-4-7']) {
      for (const row of fixture.marks) {
        if (row.content !== null) {
          expect(countContentCtok(row.text, model)).toBe(row.content)
        }
      }
    }
    for (const row of fixture.costs) {
      expect(countContentCtok(row.text, row.version === '3.0' ? 'claude-opus-4-5' : 'claude-opus-4-7')).toBe(
        row.content,
      )
    }
  })

  test('Opus 5 tail behavior and cache identity remain separate from other versions', () => {
    const base = countContentCtok('hello', 'claude-opus-5')
    expect(countContentCtok(`hello${'\n'.repeat(29)}`, 'claude-opus-5')).toBe(base)
    expect(ctokCacheModelKey('claude-opus-5')).not.toBe(ctokCacheModelKey('claude-opus-5-5'))
  })
})

describe('bounded Node tokenizer worker pool', () => {
  test('portable BPE fingerprints match the pinned official downloaded rank files', () => {
    expect(loadBpeDefinition('o200k_base').sha256).toBe(
      '446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d',
    )
    expect(loadBpeDefinition('cl100k_base').sha256).toBe(
      '223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7',
    )
    expect(tokenizerForOpenaiModel('gpt-4.5-preview')).toBe('openai_o200k_base')
    expect(tokenizerForOpenaiModel('gpt-6')).toBeNull()
  })
  test('real BPE worker counts text and reports actual vocabulary identity', async () => {
    const first = runLocalTokenizer({ texts: ['hello world'], model: 'gpt-4o', tokenizer: 'openai_o200k_base' })
    const second = runLocalTokenizer({ texts: ['hello'], model: 'gpt-4o', tokenizer: 'openai_o200k_base' })
    await expect(second).rejects.toThrow('队列已满')
    const result = await first
    expect(result).toMatchObject({
      contentTokens: 2,
      engine: 'node',
      tokenizer: 'openai_o200k_base',
      scope: 'visible-text',
    })
    expect(result.vocabSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.revision).toBe('js-tiktoken-1.0.21')
    expect(tokenizerPoolStatus()).toMatchObject({ active: 0, queued: 0, pendingBytes: 0 })
  })

  test('real ctok worker matches reference implementation and unknown vocabularies reject', async () => {
    const result = await runLocalTokenizer({
      texts: ['hello world'],
      model: 'claude-opus-4-7',
      tokenizer: 'claude_ctok',
    })
    expect(result.contentTokens).toBe(countContentCtok('hello world', 'claude-opus-4-7'))
    await expect(runLocalTokenizer({ texts: ['hello'], model: 'grok-4', tokenizer: 'grok2' })).rejects.toThrow(
      '尚未下载并应用',
    )
    expect(tokenizerPoolStatus().pendingBytes).toBe(0)
  })

  test('rejects oversized text before allocating another counting job', async () => {
    await expect(
      runLocalTokenizer({
        texts: ['x'.repeat(poolConfig.maxTextBytes + 1)],
        model: 'gpt-4o',
        tokenizer: 'openai_o200k_base',
      }),
    ).rejects.toThrow('资源预算')
    expect(tokenizerPoolStatus().pendingBytes).toBe(0)
  })
})

test('request extraction omits image payloads and reports missing modalities', () => {
  const result = extractCountTexts({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', source: { type: 'base64', data: 'NOT_TEXT'.repeat(1000) } },
        ],
      },
    ],
  })
  expect(result.texts).toContain('hello')
  expect(result.texts.join('')).not.toContain('NOT_TEXT')
  expect(result.missing).toContain('image')
})
