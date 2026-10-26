import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { droidRuntime } from '../config/droid_runtime.js'

if (!['windows', 'linux', 'darwin'].includes(droidRuntime.platform) || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error(`Droid CLI does not support ${process.platform}/${process.arch}`)
}
const checksumResponse = await fetch(`${droidRuntime.downloadUrl}.sha256`, { signal: AbortSignal.timeout(30000) })
if (!checksumResponse.ok) {
  throw new Error(`Droid checksum download failed: HTTP ${checksumResponse.status}`)
}
const checksum = (await checksumResponse.text()).trim().split(/\s+/)[0].toLowerCase()
if (!/^[a-f0-9]{64}$/.test(checksum)) {
  throw new Error('Invalid official Droid checksum')
}
let installed = null
try {
  installed = await fs.readFile(droidRuntime.execPath)
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error
  }
}
if (installed && createHash('sha256').update(installed).digest('hex') === checksum) {
  console.log(`Droid CLI ${droidRuntime.version} already installed and verified`)
} else {
  const response = await fetch(droidRuntime.downloadUrl, { signal: AbortSignal.timeout(180000) })
  if (!response.ok) {
    throw new Error(`Droid download failed: HTTP ${response.status}`)
  }
  const content = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(content).digest('hex') !== checksum) {
    throw new Error('Droid checksum mismatch')
  }
  await fs.mkdir(path.dirname(droidRuntime.execPath), { recursive: true })
  const temporary = `${droidRuntime.execPath}.${process.pid}.tmp`
  await fs.writeFile(temporary, content, { mode: 0o755 })
  await fs.rename(temporary, droidRuntime.execPath)
  console.log(`Droid CLI ${droidRuntime.version} installed and SHA256 verified`)
}
