// 管理写接口入参：zod schema.parse → 干净对象；失败 throw HttpError(400)
// 依赖 zod（package.json 已登记）

import { z } from 'zod'

import { badRequest } from './http_result.js'

// zod 失败信息收成单行 msg（body.code=400，HTTP 按业务错合同多为 200）
export const parseBody = (schema, body, label = '请求参数') => {
  const result = schema.safeParse(body ?? {})
  if (result.success) {
    return result.data
  }
  const detail = result.error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
  throw badRequest(`${label}无效: ${detail}`)
}

// 宽松对象 body（历史大表单字段多、仍要保证是 plain object）
export const objectBodySchema = z.object({}).passthrough()

export const parseObjectBody = (body, label = '请求体') => parseBody(objectBodySchema, body, label)

export { z }
