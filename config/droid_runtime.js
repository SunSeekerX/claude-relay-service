import path from 'node:path'
import { fileURLToPath } from 'node:url'

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const platform = process.platform === 'win32' ? 'windows' : process.platform
const architecture = process.arch === 'x64' ? 'x64-baseline' : process.arch
const version = platform === 'windows' ? '0.247.0' : '0.249.0'
const binaryName = platform === 'windows' ? 'droid.exe' : 'droid'
export const droidRuntime = {
  platform,
  architecture,
  version,
  execPath: path.join(project, 'node_modules', '.cache', 'droid', platform, architecture, version, binaryName),
  downloadUrl: `https://downloads.factory.ai/factory-cli/releases/${version}/${platform}/${architecture}/${binaryName}`,
}
