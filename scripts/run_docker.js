// Docker 未就绪时启动 Docker Desktop,等待守护进程就绪后执行命令.
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const tty = process.stderr.isTTY
const yellow = (text) => (tty ? `\x1b[33m${text}\x1b[0m` : text)

const probeDocker = (timeout = 5000) =>
  spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    stdio: 'ignore',
    timeout,
  })

export const runDockerCommand = async () => {
  const command = process.argv.slice(2).join(' ')
  if (!command.trim()) {
    console.error('[Docker] 缺少命令。用法: node scripts/run_docker.js "docker compose ..."')
    process.exitCode = 2
    return
  }
  let probe = probeDocker()

  if (probe.error && probe.error.code === 'ENOENT') {
    console.error(
      yellow(
        '\n[Docker] 没检测到 docker 命令,请先安装 Docker Desktop 并确认它在 PATH 里:\n' +
          '  https://www.docker.com/products/docker-desktop/\n',
      ),
    )
    process.exitCode = 1
    return
  }

  if (probe.status !== 0) {
    console.error(yellow('\n[Docker] Docker 未就绪,正在启动 Docker Desktop...'))
    const start = spawnSync('docker', ['desktop', 'start', '--detach'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 15000,
    })
    if (start.status !== 0) {
      console.error(yellow('\n[Docker] 自动启动 Docker Desktop 失败,请手动打开后重试.'), start.error ?? start.stderr)
      process.exitCode = 1
      return
    }

    console.error(yellow('[Docker] 等待 Docker 就绪,最多 120 秒...'))
    const deadline = Date.now() + 120000
    let nextProgress = Date.now() + 10000
    while (Date.now() < deadline) {
      probe = probeDocker(Math.max(1, Math.min(5000, deadline - Date.now())))
      if (probe.status === 0) {
        break
      }
      if (Date.now() >= nextProgress) {
        console.error(`[Docker] 仍在等待，剩余约 ${Math.ceil((deadline - Date.now()) / 1000)} 秒...`)
        nextProgress = Date.now() + 10000
      }
      await delay(Math.min(2000, Math.max(0, deadline - Date.now())))
    }
    if (probe.status !== 0) {
      console.error(yellow('\n[Docker] 等待 Docker 就绪超时,请检查 Docker Desktop 状态后重试.\n'))
      process.exitCode = 1
      return
    }
    console.error('[Docker] Docker 已就绪,继续执行命令.\n')
  }

  const run = spawnSync(command, { shell: true, stdio: 'inherit' })
  if (run.error) {
    console.error('[Docker] 命令未能执行:', run.error)
  }
  process.exit(run.status === null ? 1 : run.status)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDockerCommand().catch((error) => {
    console.error('[Docker] 执行失败:', error)
    process.exitCode = 1
  })
}
