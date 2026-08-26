import { env } from './env.js'
// 模型定价数据源默认值(env 可覆盖)。
// 运行时实际生效的源见 src/services/pricingService.js resolveSource():
// Redis system:pricing_source(管理端可改) > 本文件(env > 默认) —— 管理端改完即时生效,无需重启。
const repository =
  env.PRICE_MIRROR_REPO ||
  env.GITHUB_REPOSITORY ||
  'SunSeekerX/claude-relay-service'
const branch = env.PRICE_MIRROR_BRANCH || 'price-mirror'
export const pricingFileName = env.PRICE_MIRROR_FILENAME || 'model_prices_and_context_window.json'
export const hashFileName =
  env.PRICE_MIRROR_HASH_FILENAME || 'model_prices_and_context_window.sha256'

const baseUrl = env.PRICE_MIRROR_BASE_URL
  ? env.PRICE_MIRROR_BASE_URL.replace(/\/$/, '')
  : `https://raw.githubusercontent.com/${repository}/${branch}`


export const pricingSource = {
  pricingFileName,
  hashFileName,
  pricingUrl: env.PRICE_MIRROR_JSON_URL || `${baseUrl}/${pricingFileName}`,
  hashUrl: env.PRICE_MIRROR_HASH_URL || `${baseUrl}/${hashFileName}`
}
