import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const tokenizerDefaults = {
  resourceRoot: path.join(projectRoot, 'resources', 'tokenizers'),
  dataRoot: path.join(projectRoot, 'data', 'tokenizers'),
  workers: 4,
  queue: 12,
  maxPendingBytes: 16 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  queueTimeoutMs: 250,
  countTimeoutMs: 2000,
}
