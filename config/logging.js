import { env } from './env.js'

export const consoleLogFormat = env.get('LOG_CONSOLE_FORMAT', 'compact')
if (!['compact', 'detailed', 'json'].includes(consoleLogFormat)) {
  throw new Error('LOG_CONSOLE_FORMAT 必须是 compact、detailed 或 json')
}
