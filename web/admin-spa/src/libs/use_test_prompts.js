import { computed, ref, watch } from 'vue'

import { isOk, msgOf } from '@/libs/http_envelope'

export const parseTestPromptConfig = (value) => {
  if (
    !value ||
    !['random_simple', 'fixed'].includes(value.selectionMode) ||
    typeof value.defaultId !== 'string' ||
    !Array.isArray(value.templates)
  ) {
    throw new Error('测试题库配置无效')
  }
  const ids = new Set()
  for (const item of value.templates) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      ids.has(item.id) ||
      typeof item.name !== 'string' ||
      typeof item.prompt !== 'string' ||
      typeof item.hint !== 'string' ||
      typeof item.enabled !== 'boolean'
    ) {
      throw new Error('测试题目配置无效')
    }
    ids.add(item.id)
  }
  if (
    value.defaultId &&
    !value.templates.some((item) => item.id === value.defaultId && item.enabled)
  ) {
    throw new Error('固定默认题不存在或未启用')
  }
  return structuredClone(value)
}

export const useTestPrompts = (loadApi, visible, message, canFill = () => true) => {
  const config = ref({ selectionMode: 'random_simple', defaultId: '', templates: [] })
  const loading = ref(false)
  const failed = ref(false)
  const errorMessage = ref('')
  const errorRequestId = ref('')
  const selectedId = ref('')
  const templates = computed(() => config.value.templates.filter((item) => item.enabled))
  const options = computed(() =>
    templates.value.map((item) => ({ value: item.id, label: item.name }))
  )
  const canRandomize = computed(() => !loading.value && !failed.value && templates.value.length > 0)
  const hint = computed(
    () => templates.value.find((item) => item.id === selectedId.value)?.hint ?? ''
  )
  let automaticPrompt = message.value
  let pinnedPrompt = null
  let edited = false
  let applying = false
  let sequence = 0

  watch(
    message,
    (value) => {
      if (!applying) edited = true
      selectedId.value = templates.value.find((item) => item.prompt === value)?.id ?? ''
    },
    { flush: 'sync' }
  )

  const select = (id) => {
    const item = templates.value.find((item) => item.id === id)
    if (!item) return
    message.value = item.prompt
    selectedId.value = id
    pinnedPrompt = item.prompt
    edited = true
  }
  const pick = () => {
    const candidates = templates.value.filter((item) => item.prompt !== message.value)
    return candidates.length
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : templates.value[0]
  }
  const randomize = () => {
    if (!canRandomize.value) return
    const item = pick()
    select(item.id)
    automaticPrompt = item.prompt
    pinnedPrompt = null
  }

  const reload = async () => {
    if (!visible.value || loading.value) return
    const current = ++sequence
    edited = false
    const untouched =
      message.value !== pinnedPrompt && (message.value === '' || message.value === automaticPrompt)
    loading.value = true
    failed.value = false
    errorMessage.value = ''
    errorRequestId.value = ''
    try {
      const response = await loadApi()
      if (sequence !== current || !visible.value) return
      if (!isOk(response) || !response.data?.config) {
        const status = response?.httpStatus ?? response?.code ?? 0
        const detail =
          status === 404
            ? '题库接口不存在（404），请确认后端已重启并加载最新代码'
            : status === 0
              ? '无法连接后端，请检查服务和网络'
              : `读取测试题库失败（${status}）：${msgOf(response, '响应缺少题库配置')}`
        throw new Error(detail, {
          cause: {
            endpoint: '/apiStats/test-prompt-config',
            code: response?.code,
            httpStatus: response?.httpStatus,
            requestId: response?.requestId
          }
        })
      }
      config.value = parseTestPromptConfig(response.data.config)
      selectedId.value = templates.value.find((item) => item.prompt === message.value)?.id ?? ''
      if (!untouched || edited || !canFill()) return
      const item =
        config.value.selectionMode === 'fixed'
          ? templates.value.find((candidate) => candidate.id === config.value.defaultId)
          : pick()
      applying = true
      message.value = item?.prompt ?? ''
      selectedId.value = item?.id ?? ''
      automaticPrompt = message.value
      applying = false
    } catch (error) {
      if (sequence !== current) return
      console.error('[TestPrompts] load failed', error)
      failed.value = true
      errorMessage.value = error.message
      errorRequestId.value = error.cause?.requestId ?? ''
    } finally {
      if (sequence === current) loading.value = false
    }
  }

  watch(
    visible,
    (open) => {
      if (open) return reload()
      sequence++
      loading.value = false
    },
    { immediate: true, flush: 'post' }
  )

  return {
    loading,
    failed,
    errorMessage,
    errorRequestId,
    reload,
    options,
    selectedId,
    hint,
    select,
    randomize,
    canRandomize
  }
}
