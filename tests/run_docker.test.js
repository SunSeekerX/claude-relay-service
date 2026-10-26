import { jest, beforeEach, afterEach, test, expect } from '@jest/globals'

const spawnSync = jest.fn()
let now = 0
const delay = jest.fn(async (milliseconds) => {
  now += milliseconds
})
jest.unstable_mockModule('node:child_process', () => ({ spawnSync }))
jest.unstable_mockModule('node:timers/promises', () => ({ setTimeout: delay }))
const { runDockerCommand } = await import('../scripts/run_docker.js')
let oldArgs
let oldExitCode

beforeEach(() => {
  oldArgs = process.argv
  oldExitCode = process.exitCode
  process.argv = [process.execPath, 'scripts/run_docker.js', 'docker compose up -d']
  process.exitCode = undefined
  now = 0
  spawnSync.mockReset()
  delay.mockClear()
  jest.spyOn(Date, 'now').mockImplementation(() => now)
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(process, 'exit').mockImplementation(() => {})
})
afterEach(() => {
  process.argv = oldArgs
  process.exitCode = oldExitCode
  jest.restoreAllMocks()
})

test('missing Docker and failed Desktop startup return failure without executing the command', async () => {
  spawnSync.mockReturnValueOnce({ status: null, error: { code: 'ENOENT' } })
  await runDockerCommand()
  expect(process.exitCode).toBe(1)
  expect(spawnSync).toHaveBeenCalledTimes(1)
  spawnSync.mockReset().mockReturnValue({ status: 1, stderr: 'Desktop unavailable' })
  await runDockerCommand()
  expect(process.exitCode).toBe(1)
  expect(spawnSync).toHaveBeenCalledTimes(2)
})

test('timeout is bounded, reports progress and returns failure', async () => {
  spawnSync.mockImplementation((command, args) => ({
    status: command === 'docker' && args[0] === 'desktop' ? 0 : 1,
  }))
  await runDockerCommand()
  expect(process.exitCode).toBe(1)
  expect(now).toBe(120000)
  expect(console.error.mock.calls.some(([text]) => text.includes('仍在等待'))).toBe(true)
  expect(process.exit).not.toHaveBeenCalled()
})

test('ready Docker preserves child command exit code; empty command is a usage error', async () => {
  spawnSync.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 7 })
  await runDockerCommand()
  expect(process.exit).toHaveBeenCalledWith(7)
  expect(spawnSync.mock.calls[1][0]).toBe('docker compose up -d')
  process.argv = process.argv.slice(0, 2)
  spawnSync.mockClear()
  await runDockerCommand()
  expect(process.exitCode).toBe(2)
  expect(spawnSync).not.toHaveBeenCalled()
})
