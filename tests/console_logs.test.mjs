import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { createStartupProgress, formatConsoleEntry } from '../src/common/console_output.js'
import { formatStartupSummary } from '../src/common/startup_banner.js'
import { matchesLogEntry, parseLogLine, parseLogTime } from '../scripts/logs.js'

test('real Winston keeps startup detail and nested errors in files while compacting only console', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crs-console-files-'))
  const configUrl = pathToFileURL(path.resolve('config/config.js')).href
  const loggerUrl = pathToFileURL(path.resolve('src/common/logger.js')).href
  const source = `
    import { config } from ${JSON.stringify(configUrl)};
    config.logging.dirname = ${JSON.stringify(directory)};
    process.chdir(${JSON.stringify(directory)});
    const { logger } = await import(${JSON.stringify(loggerUrl)});
    logger.beginStartup();
    logger.info('fixture-startup-detail', { retained: false, count: 0 });
    logger.startupStage('fixture-stage');
    logger.warn('fixture-warning', { error: new Error('nested failure', { cause: new Error('DNS failed') }) });
    logger.warn('fixture-sensitive-cause', { error: new Error('request failure', {
      cause: { authorization: 'Bearer fixture-secret-not-for-output', count: 0, retained: false }
    }) });
    logger.finishStartup();
    logger.info('200 GET /fixture 2ms', { requestId: 'fixture-request' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => { logger.on('finish', resolve); logger.end(); });
  `
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, NODE_ENV: 'test', LOG_CONSOLE_FORMAT: 'compact', LOG_LEVEL: 'info' },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /fixture-startup-detail/)
    assert.match(result.stdout, /INFO.*fixture-stage/)
    assert.match(result.stdout, /WARN.*fixture-warning/)
    assert.match(result.stdout, /Error: nested failure/)
    assert.doesNotMatch(result.stdout, /New log file created/)
    const file = (await readdir(directory)).find((name) => /^claude-relay-\d.*\.log$/.test(name))
    const records = (await readFile(path.join(directory, file), 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
    const detail = records.find((record) => record.msg === 'fixture-startup-detail')
    assert.equal(detail.retained, false)
    assert.equal(detail.count, 0)
    assert.match(detail.time, /Z$/)
    assert.ok(Number.isInteger(detail.pid))
    const warning = records.find((record) => record.msg === 'fixture-warning')
    assert.equal(warning.error.message, 'nested failure')
    assert.equal(warning.error.cause.message, 'DNS failed')
    const sensitive = records.find((record) => record.msg === 'fixture-sensitive-cause')
    assert.notEqual(sensitive.error.cause.authorization, 'Bearer fixture-secret-not-for-output')
    assert.equal(sensitive.error.cause.count, 0)
    assert.equal(sensitive.error.cause.retained, false)
    for (const mode of ['detailed', 'json']) {
      const output = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, NODE_ENV: 'test', LOG_CONSOLE_FORMAT: mode, LOG_LEVEL: 'info' },
      })
      assert.equal(output.status, 0, output.stderr)
      if (mode === 'detailed') {
        assert.match(output.stdout, /fixture-startup-detail/)
        assert.match(output.stdout, /retained: false/)
      } else {
        const entries = output.stdout.trim().split(/\r?\n/).map(JSON.parse)
        assert.ok(entries.some((entry) => entry.msg === 'fixture-startup-detail'))
        assert.ok(entries.every((entry) => typeof entry.time === 'string' && typeof entry.lvl === 'string'))
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('startup compacts only low severity console entries and ends filtering after readiness', () => {
  let now = 0
  const messages = []
  const startup = createStartupProgress(
    (...args) => messages.push(args),
    () => now,
  )
  startup.begin()
  try {
    assert.equal(startup.shouldShow({ level: 'info' }), false)
    assert.equal(startup.shouldShow({ level: 'warn' }), true)
    assert.equal(startup.shouldShow({ level: 'error' }), true)
    now = 150
    startup.stage('Redis')
    assert.equal(messages[0][1].previousDurationMs, 150)
    assert.equal(startup.shouldShow({ level: 'info', type: 'startup-stage' }), true)
    now = 450
    assert.equal(startup.finish(), 450)
    assert.equal(startup.shouldShow({ level: 'info' }), true)
  } finally {
    startup.finish()
  }
})

test('successful requests have one line and request ID; warnings retain context and stack', () => {
  const info = {
    timestamp: '2026-10-25 18:51:05',
    level: 'info',
    message: '200 GET /apiStats/models 5ms 300B',
    _file: { requestId: 'request-1', model: 'model-a' },
    _accessMetaLines: ['request body'],
  }
  const line = formatConsoleEntry(info)
  assert.equal(line.split('\n').length, 1)
  assert.match(line, /INFO.*requestId=request-1.*model=model-a/)
  const warning = formatConsoleEntry({
    ...info,
    level: 'warn',
    stack: 'Error: failure\n at fixture',
  })
  assert.match(warning, /request body/)
  assert.match(warning, /Error: failure/)
  assert.match(
    formatConsoleEntry({
      ...info,
      level: 'error',
      _accessMetaLines: undefined,
      error: new Error('nested'),
    }),
    /Error: nested/,
  )
})

test('startup banner reports actual bind address once and separates official aliases', () => {
  const banner = formatStartupSummary({
    bindHost: '::1',
    port: 3000,
    version: '1',
    pid: 123,
    environment: 'development',
    durationMs: 1250,
    warnings: 1,
    errors: 0,
    logDirectory: 'logs',
  })
  assert.match(banner, /PID 123.*1\.25s/)
  assert.match(banner, /http:\/\/localhost:3000\/admin-next\//)
  assert.doesNotMatch(banner, /局域网/)
  assert.doesNotMatch(banner, /http:.*\/v1\/\*\|/)
  assert.match(banner, /rs 重启后端/)
})

test('log filters use UTC time and exact request/status fields without losing false or zero', () => {
  const entry = parseLogLine(
    JSON.stringify({
      ts: '2026-10-25 18:00:00',
      time: '2026-10-25T10:00:00Z',
      lvl: 'error',
      msg: 'failed',
      requestId: 'r-1',
      statusCode: 500,
      retained: false,
      count: 0,
    }),
  )
  assert.equal(entry.retained, false)
  assert.equal(entry.count, 0)
  const filters = {
    level: 'warn',
    requestId: 'r-1',
    status: 500,
    search: 'failed',
    since: Date.parse('2026-10-25T09:59:00Z'),
    until: Date.parse('2026-10-25T10:01:00Z'),
  }
  assert.equal(matchesLogEntry(entry, filters), true)
  assert.equal(matchesLogEntry(entry, { ...filters, requestId: 'r' }), false)
  assert.equal(matchesLogEntry({ ...entry, lvl: 'info' }, filters), false)
  assert.equal(parseLogTime('2h', 7200001), 1)
  assert.throws(() => parseLogTime('wrong'), /时间格式无效/)
  assert.throws(() => parseLogTime('2026-10-25T18:00:00'), /时区偏移/)
  assert.equal(
    parseLogLine(JSON.stringify({ log: JSON.stringify(entry), time: '2026-10-25T10:00:00Z' })).requestId,
    'r-1',
  )
})

test('real CLI reads gzip, selects newest matches despite file order, preserves NDJSON and fails on bad sources', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crs-log-query-'))
  const recent = path.join(directory, 'recent.log')
  const old = path.join(directory, 'old.log.gz')
  const rows = [
    { time: '2026-10-25T10:00:00Z', lvl: 'warn', msg: 'old', requestId: 'wanted' },
    {
      time: '2026-10-25T11:00:00Z',
      lvl: 'error',
      msg: 'new',
      requestId: 'wanted',
      statusCode: 500,
      retained: false,
      count: 0,
    },
  ]
  const run = (...args) => spawnSync(process.execPath, ['scripts/logs.js', ...args], { encoding: 'utf8' })
  try {
    await writeFile(recent, `${JSON.stringify(rows[1])}\n`)
    await writeFile(old, gzipSync(`${JSON.stringify(rows[0])}\n`))
    const before = await readFile(recent, 'utf8')
    const result = run('--file', recent, '--file', old, '--request-id', 'wanted', '--limit', '1', '--json')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).msg, 'new')
    assert.equal(await readFile(recent, 'utf8'), before)
    const projected = run('--file', recent, '--json', '--fields', 'msg,retained,count')
    assert.equal(projected.status, 0, projected.stderr)
    assert.deepEqual(JSON.parse(projected.stdout), { msg: 'new', retained: false, count: 0 })
    assert.notEqual(run('--file', path.join(directory, 'missing')).status, 0)
    assert.notEqual(run('--limit', '-1').status, 0)
    assert.notEqual(run('--ssh', '-oProxyCommand=bad', '--docker', 'test').status, 0)
    assert.notEqual(run('--since', '2026-10-25T12:00Z', '--until', '2026-10-25T10:00Z').status, 0)
    const pipe = spawnSync(process.execPath, ['scripts/logs.js', '--stdin', '--level', 'warn', '--json'], {
      encoding: 'utf8',
      input: `${JSON.stringify(rows[1])}\n`,
    })
    assert.equal(pipe.status, 0, pipe.stderr)
    assert.equal(JSON.parse(pipe.stdout).requestId, 'wanted')
    const legacy = spawnSync(
      process.execPath,
      ['scripts/logs.js', '--stdin', '--request-id', 'legacy-request', '--level', 'warn', '--json'],
      {
        encoding: 'utf8',
        input: [
          '2026-10-25T10:00:00Z 2026-10-25 18:00:00 WARN  500 GET /fixture',
          '2026-10-25T10:00:00Z   └─ id: legacy-request',
          '2026-10-25T10:00:00Z Error: failed',
          '2026-10-25T10:00:00Z     at fixture.js:10',
        ].join('\n'),
      },
    )
    assert.equal(legacy.status, 0, legacy.stderr)
    assert.match(JSON.parse(legacy.stdout).msg, /Error: failed/)
    assert.match(JSON.parse(legacy.stdout).msg, /at fixture.js/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
