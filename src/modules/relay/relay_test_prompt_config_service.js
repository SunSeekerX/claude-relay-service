import { readFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'

import { redis } from '../../infra/redis.js'
import { RedisKeys, TestPromptLimits } from '../../infra/redis_key.js'
import { parseBody, z } from '../../common/parse_body.js'
import { badRequest } from '../../common/http_result.js'
import { logger } from '../../common/logger.js'

const defaults = JSON.parse(
  readFileSync(new URL('../../../config/test_prompt_defaults.json', import.meta.url), 'utf8')
)
const boundedText = (maximum) =>
  z.string().refine((value) => [...value].length <= maximum, `最多 ${maximum} 字符`)
const templateSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: boundedText(100)
    .transform((value) => value.trim())
    .refine(Boolean, '请填写题目名称'),
  prompt: boundedText(TestPromptLimits.promptCharacters).refine(
    (value) => !!value.trim(),
    '请填写题目正文'
  ),
  hint: boundedText(2000).default(''),
  enabled: z.boolean().default(true)
})
const configSchema = z.object({
  selectionMode: z.enum(['random_simple', 'fixed']),
  defaultId: z.string().max(64),
  templates: z.array(templateSchema).max(TestPromptLimits.templates)
})

export const normalizeTestPromptConfig = (value) => {
  const config = parseBody(configSchema, value, '测试题库')
  const ids = new Set()
  for (const item of config.templates) {
    if (ids.has(item.id)) {
      throw badRequest('题目 ID 不能重复')
    }
    ids.add(item.id)
  }
  if (
    config.defaultId &&
    !config.templates.some((item) => item.id === config.defaultId && item.enabled)
  ) {
    throw badRequest('固定默认题必须存在且已启用')
  }
  if (Buffer.byteLength(JSON.stringify(config), 'utf8') > TestPromptLimits.configBytes) {
    throw badRequest('测试题库最多 512 KiB')
  }
  return config
}

export const defaultTestPromptConfig = () => normalizeTestPromptConfig(defaults)

export const testPromptConfigService = {
  async getConfig() {
    const raw = await redis.getClientSafe().get(RedisKeys.testPromptConfig)
    return raw === null ? defaultTestPromptConfig() : normalizeTestPromptConfig(JSON.parse(raw))
  },

  async saveConfig(value, updatedBy) {
    const config = normalizeTestPromptConfig(value)
    await redis.getClientSafe().set(RedisKeys.testPromptConfig, JSON.stringify(config))
    logger.info('Test prompt config updated', {
      updatedBy,
      count: config.templates.length,
      selectionMode: config.selectionMode
    })
    return config
  },

  async resolvePrompt(requested) {
    if (requested !== undefined) {
      return parseBody(
        boundedText(TestPromptLimits.promptCharacters).refine(
          (value) => !!value.trim(),
          '请输入测试问题'
        ),
        requested,
        '测试问题'
      )
    }
    const config = await this.getConfig()
    const candidates = config.templates.filter((item) => item.enabled)
    const item =
      config.selectionMode === 'fixed'
        ? candidates.find((candidate) => candidate.id === config.defaultId)
        : candidates.length
          ? candidates[randomInt(candidates.length)]
          : undefined
    if (!item) {
      throw badRequest('请在测试模型设置中启用题目,或手动输入测试问题')
    }
    return item.prompt
  }
}
