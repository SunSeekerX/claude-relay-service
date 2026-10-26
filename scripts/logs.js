import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config } from '../config/config.js'
import { formatConsoleEntry } from '../src/common/console_output.js'

const levels = { error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6 }
const quoteShell = (value) => `'${value.replaceAll("'", "'\\''")}'`
const timezone = () => {
  const minutes = Math.round(config.system.timezoneOffset * 60)
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`
}

export const parseLogTime = (value, now = Date.now()) => {
  if (!value) {
    return null
  }
  const relative = /^(\d+)(s|m|h|d)$/.exec(value)
  if (relative) {
    return now - Number(relative[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[relative[2]]
  }
  const legacyTimestamp = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
  if (!legacyTimestamp && !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`时间格式无效: ${value}；ISO 时间必须包含 Z 或时区偏移`)
  }
  const normalized = legacyTimestamp ? `${value.replace(' ', 'T')}${timezone()}` : value
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) {
    throw new Error(`时间格式无效: ${value}；请使用 30m、2h 或带时区的 ISO 时间`)
  }
  return timestamp
}

export const parseLogLine = (line) => {
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/\u001b\[[0-9;]*m/g, '').trimEnd()
  if (!clean.trim()) {
    return null
  }
  const dockerPrefix = /^(\d{4}-\d\d-\d\dT\S+) (.*)$/.exec(clean)
  const text = dockerPrefix ? dockerPrefix[2] : clean
  try {
    const record = JSON.parse(text)
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      if (typeof record.log === 'string') {
        const nested = parseLogLine(record.log)
        return nested ? { ...nested, time: nested.time ?? record.time } : null
      }
      return {
        ...record,
        ts: record.ts ?? record.timestamp,
        lvl: record.lvl ?? record.level ?? 'info',
        msg: record.msg ?? record.message ?? text,
        time: record.time ?? dockerPrefix?.[1],
      }
    }
  } catch {
    /* 兼容旧版控制台纯文本。 */
  }
  const header = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(?:(ERROR|WARN|INFO|HTTP|VERBOSE|DEBUG|SILLY)\s+)?(.*)$/.exec(
    text,
  )
  const requestId = /\brequestId=([^\s|]+)/.exec(text)?.[1]
  return {
    ts: header?.[1],
    time: dockerPrefix?.[1],
    lvl: header?.[2]?.toLowerCase() ?? 'info',
    msg: header?.[3] ?? text,
    ...(requestId ? { requestId } : {}),
    _text: true,
    _continuation: !header,
  }
}

export const matchesLogEntry = (entry, filters) => {
  if (filters.level && (levels[entry.lvl] ?? Infinity) > levels[filters.level]) {
    return false
  }
  if (filters.requestId && (entry.requestId ?? entry.id) !== filters.requestId) {
    return false
  }
  const time = entryTime(entry)
  if (filters.since !== null && (time === null || time < filters.since)) {
    return false
  }
  if (filters.until !== null && (time === null || time > filters.until)) {
    return false
  }
  if (filters.status && Number(entry.statusCode ?? entry.status) !== filters.status) {
    return false
  }
  return !filters.search || JSON.stringify(entry).toLowerCase().includes(filters.search.toLowerCase())
}

const entryTime = (entry) => {
  try {
    return parseLogTime(entry.time ?? entry.ts)
  } catch {
    return null
  }
}

const help = `只读日志查询，不启动应用、不修改生产数据。

pnpm run logs -- --level warn --since 30m
pnpm run logs -- --request-id <id> --json
pnpm run logs:prod -- --level warn --since 30m
pnpm run logs:prod -- --request-id <id> --json
pnpm run logs:prod -- --json --fields ts,lvl,msg,requestId --limit 10
pnpm run logs -- --file logs/claude-relay-2026-10-25.log --status 500
pnpm run logs -- --stdin --search response_incomplete
pnpm run logs -- --docker crs-claude-relay-1 --since 1h
pnpm run logs -- --ssh crs-prod --docker crs-claude-relay-1 --since 1h
pnpm run logs -- --ssh crs-prod --file /data/docker_data/crs/logs/claude-relay-2026-10-25.log

--file <path>       指定日志，可重复；本地支持 .gz；默认读最近 5 个主日志文件
--stdin             读取管道，支持 NDJSON、Docker JSON 和控制台文本
--docker <name>     有界读取 docker logs；可与 --ssh 配合
--ssh <host>        经已有 SSH 配置只读查询；须同时指定 --file 或 --docker
--prod              复用 dev_tools 现有密码，在隔离容器查询生产主日志及归档
--port <number>     SSH 端口；不填沿用 SSH 配置
--level <level>     最低严重度，例如 warn 包含 warn/error
--since <time>      起始时间：30m / 2h / 带时区 ISO；默认不限制本地文件时间
--until <time>      截止时间，格式同 --since
--request-id <id>   按请求 ID 精确筛选
--status <code>     HTTP 状态码（结构化文件日志）
--search <text>     按消息和上下文做字面检索，不执行正则
--limit <number>    最后多少条匹配结果，默认 100，最大 10000
--tail <number>     原始行数上限：文件分别限制，--prod 合计限制；默认 10000，最大 100000
--json              输出 NDJSON；机器管道推荐直接 node scripts/logs.js
--fields <names>    --json 只输出指定顶层字段，用逗号分隔，方便 Agent 短查询

--ssh 沿用现有密钥；--prod 仅在工具容器通过 sshpass -e 使用现有密码，不回显。
Docker 控制台只有摘要；完整上下文请用 --file 查询挂载的日志文件。
旧日志 ts 按本地 config.system.timezoneOffset 解释，新日志优先使用 UTC time。
`

const numberOption = (value, name, maximum) => {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${name} 必须是 1 到 ${maximum} 的整数`)
  }
  return result
}

const localFiles = async () => {
  const names = await readdir(config.logging.dirname)
  const files = await Promise.all(
    names
      .filter((name) => /^claude-relay-\d{4}-\d\d-\d\d\.log(?:\.\d+)?(?:\.gz)?$/.test(name))
      .map(async (name) => {
        const filename = path.join(config.logging.dirname, name)
        return { filename, modified: (await stat(filename)).mtimeMs }
      }),
  )
  return files
    .sort((a, b) => b.modified - a.modified)
    .slice(0, 5)
    .reverse()
    .map((file) => file.filename)
}

const main = async () => {
  const cliArgs = process.argv.slice(2)
  if (cliArgs[0] === '--prod' && cliArgs[1] === '--') {
    cliArgs.splice(1, 1)
  }
  if (cliArgs[0] === '--') {
    cliArgs.shift()
  }
  const { values } = parseArgs({
    options: {
      file: { type: 'string', multiple: true },
      stdin: { type: 'boolean' },
      docker: { type: 'string' },
      ssh: { type: 'string' },
      prod: { type: 'boolean' },
      port: { type: 'string' },
      level: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      'request-id': { type: 'string' },
      status: { type: 'string' },
      search: { type: 'string' },
      limit: { type: 'string', default: '100' },
      tail: { type: 'string', default: '10000' },
      json: { type: 'boolean' },
      fields: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    args: cliArgs,
  })
  if (values.help) {
    process.stdout.write(help)
    return
  }
  const limit = numberOption(values.limit, '--limit', 10000)
  const tail = numberOption(values.tail, '--tail', 100000)
  const fields = values.fields?.split(',').map((field) => field.trim())
  if (fields && (!values.json || fields.some((field) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)))) {
    throw new Error('--fields 需要 --json，字段名用逗号分隔')
  }
  if (values.level && !Object.hasOwn(levels, values.level)) {
    throw new Error('--level 必须是 error/warn/info/http/verbose/debug/silly')
  }
  if (values.prod && (values.ssh || values.stdin || values.file || values.docker)) {
    throw new Error('--prod 使用专用生产日志来源，不能与其他来源混用')
  }
  if (Number(Boolean(values.stdin)) + Number(Boolean(values.docker)) + Number(Boolean(values.file)) > 1) {
    throw new Error('--stdin、--docker、--file 请选择一种来源')
  }
  if (values.ssh && !values.docker && !values.file) {
    throw new Error('--ssh 需要 --docker 或 --file')
  }
  if (values.port && !values.ssh) {
    throw new Error('--port 需要 --ssh')
  }
  if (values.ssh && !/^[A-Za-z0-9_@.:[\]-]+$/.test(values.ssh)) {
    throw new Error('SSH 主机或别名无效')
  }
  if (values.ssh?.startsWith('-')) {
    throw new Error('SSH 主机不能以 - 开头')
  }
  if (values.docker && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(values.docker)) {
    throw new Error('Docker 容器名无效')
  }
  const now = Date.now()
  const filters = {
    level: values.level,
    requestId: values['request-id'],
    search: values.search,
    status: values.status ? numberOption(values.status, '--status', 599) : null,
    since: parseLogTime(values.since ?? (values.prod ? '30m' : undefined), now),
    until: parseLogTime(values.until, now),
  }
  if (filters.since !== null && filters.until !== null && filters.since > filters.until) {
    throw new Error('--since 不能晚于 --until')
  }
  const results = []
  const accept = (entry) => {
    if (!entry || !matchesLogEntry(entry, filters)) {
      return
    }
    const time = entryTime(entry) ?? now
    let low = 0
    let high = results.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if ((entryTime(results[middle]) ?? now) <= time) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    results.splice(low, 0, entry)
    if (results.length > limit) {
      results.shift()
    }
  }
  const read = async (stream) => {
    let pending
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      const entry = parseLogLine(line)
      if (entry?._continuation && pending?._text) {
        pending.msg = `${pending.msg}\n${entry.msg}`.slice(0, 50000)
        const legacyId = /^\s*(?:[└├]─\s*)?(?:requestId|id):\s*(\S+)/.exec(entry.msg)
        if (legacyId) {
          pending.requestId ??= legacyId[1]
        }
      } else if (entry) {
        accept(pending)
        pending = entry
      }
    }
    accept(pending)
  }
  if (values.docker || values.ssh || values.prod) {
    let command = 'docker'
    let args = ['logs', '--timestamps', '--tail', String(tail), '--since', values.since ?? '30m']
    if (values.until) {
      args.push('--until', values.until)
    }
    if (values.docker) {
      args.push(values.docker)
    }
    if (values.ssh) {
      const remote = values.docker ? ['docker', ...args] : ['tail', '-q', '-n', String(tail), '--', ...values.file]
      if (values.file?.some((file) => !file.startsWith('/') || /[\r\n]/.test(file))) {
        throw new Error('远程 --file 必须是绝对路径，不支持换行')
      }
      command = 'ssh'
      args = [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=2',
      ]
      if (values.port) {
        args.push('-p', String(numberOption(values.port, '--port', 65535)))
      }
      args.push('--', values.ssh, remote.map(quoteShell).join(' '))
    }
    if (values.prod) {
      const compose = fileURLToPath(new URL('../dev_tools/sync.compose.yml', import.meta.url))
      args = [
        'compose',
        '-f',
        compose,
        'run',
        '--rm',
        '-T',
        '--no-deps',
        '--entrypoint',
        'bash',
        'sync',
        'query_prod_logs.sh',
        String(tail),
      ]
      console.error(`[日志] 正在只读查询生产 crs，最多读取 ${tail} 行...`)
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const completion = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 查询失败，退出码 ${code}`))))
    })
    if (command === 'docker' && !values.prod) {
      // docker logs 把容器 stderr 写入本进程 stderr；两路都必须参与筛选。
      await Promise.all([read(child.stdout), read(child.stderr), completion])
    } else {
      child.stderr.pipe(process.stderr, { end: false })
      await Promise.all([read(child.stdout), completion])
    }
  } else if (values.stdin) {
    await read(process.stdin)
  } else {
    const files = values.file ?? (await localFiles())
    for (const file of files) {
      const input = createReadStream(file)
      if (file.endsWith('.gz')) {
        const unzip = createGunzip()
        input.on('error', (error) => unzip.destroy(error))
        await read(input.pipe(unzip))
      } else {
        await read(input)
      }
    }
  }
  for (const entry of results) {
    const { _text, _continuation, ...record } = entry
    const output = values.json
      ? JSON.stringify(
          fields
            ? Object.fromEntries(
                fields.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]]),
              )
            : record,
        )
      : formatConsoleEntry({
          ...record,
          level: record.lvl,
          message: record.msg,
          timestamp: record.ts ?? record.time ?? '--',
        })
    process.stdout.write(`${output}\n`)
  }
  console.error(
    `[日志] 显示最后 ${results.length} 条匹配；来源只读${values.docker || values.ssh || values.prod ? `，每个来源原始读取上限 ${tail} 行` : ''}`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.on('error', (error) => {
    if (error.code === 'EPIPE') {
      process.exit(0)
    } else {
      throw error
    }
  })
  main().catch((error) => {
    console.error(`[日志] ${error.message}\n帮助: pnpm run logs -- --help`)
    process.exitCode = 1
  })
}
