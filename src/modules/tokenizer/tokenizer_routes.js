import express from 'express'
import { authenticateAdmin } from '../../infra/middleware_auth.js'
import { asyncRoute } from '../../common/route_handler.js'
import { badRequest } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'
import { tokenizerConfig } from '../../../config/tokenizers.js'
import { modelService } from '../pricing/pricing_model_service.js'
import {
  getTokenizerInventory,
  getTokenizerSettings,
  saveTokenizerSettings,
  countVisibleContent,
} from './tokenizer_service.js'
import { getTokenizerTasks, startTokenizerTask, cancelTokenizerTask } from './tokenizer_tasks.js'

export const router = express.Router()
router.use('/tokenizers', authenticateAdmin)
router.get(
  '/tokenizers/catalog',
  asyncRoute('Failed to load tokenizer inventory', async () => ({
    ...(await getTokenizerInventory()),
    models: modelService.getAllModels().map((model) => model.id),
  })),
)
router.get('/tokenizers/settings', asyncRoute('Failed to load tokenizer settings', getTokenizerSettings))
router.put(
  '/tokenizers/settings',
  asyncRoute('Failed to save tokenizer settings', async (req) =>
    saveTokenizerSettings(parseObjectBody(req.body, '词表设置')),
  ),
)
router.get('/tokenizers/tasks', asyncRoute('Failed to load tokenizer tasks', getTokenizerTasks))
router.post(
  '/tokenizers/tasks',
  asyncRoute('Failed to start tokenizer task', async (req) =>
    startTokenizerTask(parseObjectBody(req.body, '词表任务')),
  ),
)
router.post(
  '/tokenizers/tasks/:id/cancel',
  asyncRoute('Failed to cancel tokenizer task', async (req) => cancelTokenizerTask(req.params.id)),
)
router.post(
  '/tokenizers/count',
  asyncRoute('Failed to count visible content', async (req) => {
    const { text, model, tokenizer = '' } = parseObjectBody(req.body, '本地计数诊断')
    if (
      typeof text !== 'string' ||
      Buffer.byteLength(text) > tokenizerConfig.maxTextBytes ||
      typeof model !== 'string' ||
      !model ||
      model.length > 200 ||
      typeof tokenizer !== 'string' ||
      tokenizer.length > 64
    ) {
      throw badRequest('请提供有效的模型和不超过 2 MiB 的文本')
    }
    return countVisibleContent({ texts: [text], model, override: tokenizer })
  }),
)
