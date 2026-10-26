import { createReadStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { reconcileGeminiCacheUsage } from '../src/modules/pricing/pricing_gemini_cache_reconciliation.js'

export const auditGeminiCacheFile = async (inputPath) => {
  const report = {
    source: inputPath,
    generatedAt: new Date().toISOString(),
    coverage: [],
    rows: [],
  }
  const lines = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) {
      continue
    }
    const entry = JSON.parse(line)
    if (entry.kind === 'coverage') {
      report.coverage.push(entry)
    } else if (entry.kind === 'geminiUsage') {
      report.rows.push({ instance: entry.instance, ...reconcileGeminiCacheUsage(entry.value) })
    }
  }
  report.summary = {
    records: report.rows.length,
    missingRawUsage: report.rows.filter((row) => row.status === 'missing_raw_usage').length,
    tokenDifferences: report.rows.filter((row) => row.status === 'token_difference_requires_historical_pricing').length,
    matched: report.rows.filter((row) => row.status === 'matched').length,
    monetaryDifference: null,
    refundReady: false,
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { input: { type: 'string' }, output: { type: 'string' } },
  })
  if (!values.input || !values.output) {
    throw new Error('Usage: node scripts/audit-gemini-cache-usage.js --input=<sanitized.jsonl> --output=<report.json>')
  }
  const report = await auditGeminiCacheFile(values.input)
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  console.log(JSON.stringify(report.summary))
}
