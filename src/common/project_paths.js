import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 该文件位于 src/utils 下，向上两级即项目根目录。
export const getProjectRoot = function getProjectRoot() {
  return path.resolve(__dirname, '..', '..')
}
