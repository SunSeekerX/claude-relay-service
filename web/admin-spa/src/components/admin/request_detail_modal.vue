<template>
  <ModalTransition>
    <div
      v-if="show"
      class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 p-2 sm:p-3"
      @click.self="emitClose"
    >
      <div
        class="modal-content my-auto flex w-full flex-col overflow-hidden bg-white shadow-xl dark:bg-gray-900"
        :class="isMobileViewport ? 'min-h-[100dvh] max-w-none' : 'max-h-[92vh] max-w-3xl rounded-xl'"
      >
        <!-- 顶栏 -->
        <div
          class="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700"
        >
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <h3 class="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                {{ detail?.model || (loading ? '加载中...' : '请求详情') }}
              </h3>
              <span
                v-if="detail"
                class="rounded px-1.5 py-0.5 text-sm font-semibold text-white"
                :class="statusClass(detail.statusCode)"
              >
                {{ detail.statusCode || 200 }}
              </span>
              <span
                v-if="detail"
                class="text-sm text-gray-500 dark:text-gray-400"
              >
                {{ formatDuration(detail.durationMs) }}
                <template v-if="detail.firstTokenMs != null">
                  · 首字 {{ formatDuration(detail.firstTokenMs) }}
                </template>
                · {{ detail.stream ? '流式' : '非流式' }}
              </span>
            </div>
            <p class="mt-0.5 truncate text-sm text-gray-500 dark:text-gray-400">
              {{ requestId || '-' }}
              <template v-if="detail?.timestamp">
                · {{ formatDate(detail.timestamp) }}
              </template>
            </p>
          </div>
          <button
            aria-label="关闭"
            class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
            type="button"
            @click="emitClose"
          >
            <i class="i-lucide-x text-base" />
          </button>
        </div>

        <!-- 内容 -->
        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2" :class="{ 'opacity-60': loading }">
          <div
            v-if="!loading && !detail"
            class="py-8 text-center text-sm text-gray-500 dark:text-gray-400"
          >
            未找到该请求详情
          </div>

          <template v-else-if="detail">
            <!-- 概要键值 -->
            <dl class="divide-y divide-gray-100 text-sm dark:divide-gray-800">
              <div class="grid grid-cols-[5.5rem_1fr] gap-x-2 py-1.5 sm:grid-cols-[6rem_1fr]">
                <dt class="text-gray-500 dark:text-gray-400">接口</dt>
                <dd class="min-w-0 break-all text-gray-900 dark:text-gray-100">
                  <span class="font-medium">{{ detail.method || 'POST' }}</span>
                  {{ detail.endpoint || '-' }}
                </dd>
              </div>
              <div class="grid grid-cols-[5.5rem_1fr] gap-x-2 py-1.5 sm:grid-cols-[6rem_1fr]">
                <dt class="text-gray-500 dark:text-gray-400">API Key</dt>
                <dd class="min-w-0 text-gray-900 dark:text-gray-100">
                  <span class="font-medium">{{ detail.apiKeyName || detail.apiKeyId || '-' }}</span>
                  <span
                    v-if="detail.apiKeyId && detail.apiKeyName"
                    class="ml-1 break-all text-gray-500 dark:text-gray-400"
                  >{{ detail.apiKeyId }}</span>
                </dd>
              </div>
              <div class="grid grid-cols-[5.5rem_1fr] gap-x-2 py-1.5 sm:grid-cols-[6rem_1fr]">
                <dt class="text-gray-500 dark:text-gray-400">账户</dt>
                <dd class="min-w-0 text-gray-900 dark:text-gray-100">
                  <span class="font-medium">{{ detail.accountName || detail.accountId || '-' }}</span>
                  <span class="ml-1 text-gray-500 dark:text-gray-400">
                    {{ detail.accountTypeName || detail.accountType || '' }}
                  </span>
                </dd>
              </div>
              <div class="grid grid-cols-[5.5rem_1fr] gap-x-2 py-1.5 sm:grid-cols-[6rem_1fr]">
                <dt class="text-gray-500 dark:text-gray-400">上下文</dt>
                <dd class="text-gray-900 dark:text-gray-100">
                  {{ detail.isLongContextRequest ? '长上下文' : '标准' }}
                  <span class="mx-1 text-gray-300 dark:text-gray-600">·</span>
                  缓存命中
                  <span class="font-medium text-cyan-600 dark:text-cyan-400">
                    {{ formatPercent(detail.cacheHitRate) }}
                  </span>
                </dd>
              </div>
              <div class="grid grid-cols-[5.5rem_1fr] gap-x-2 py-1.5 sm:grid-cols-[6rem_1fr]">
                <dt class="text-gray-500 dark:text-gray-400">耗时</dt>
                <dd class="text-gray-900 dark:text-gray-100">
                  <span class="font-medium">{{ formatDuration(detail.durationMs) }}</span>
                  <template v-if="detail.firstTokenMs != null">
                    <span class="mx-1 text-gray-300 dark:text-gray-600">·</span>
                    首字
                    <span class="font-medium">{{ formatDuration(detail.firstTokenMs) }}</span>
                  </template>
                  <span class="ml-1 text-gray-500 dark:text-gray-400">
                    {{ detail.stream ? '流式' : '非流式' }}
                  </span>
                </dd>
              </div>
              <div class="grid grid-cols-[5.5rem_1fr] gap-x-2 py-1.5 sm:grid-cols-[6rem_1fr]">
                <dt class="text-gray-500 dark:text-gray-400">推理</dt>
                <dd class="text-gray-900 dark:text-gray-100">
                  <span class="font-medium">{{ formatReasoning(detail.reasoningDisplay) }}</span>
                  <span
                    v-if="detail.reasoningSource"
                    class="ml-1 text-gray-500 dark:text-gray-400"
                  >{{ detail.reasoningSource }}</span>
                </dd>
              </div>
              <div
                v-if="formatServiceTier(detail.serviceTier)"
                class="grid grid-cols-[5.5rem_1fr] gap-x-2 py-1.5 sm:grid-cols-[6rem_1fr]"
              >
                <dt class="text-gray-500 dark:text-gray-400">档位</dt>
                <dd class="text-gray-900 dark:text-gray-100">
                  <span
                    class="inline-flex rounded-full px-2 py-0.5 text-sm font-medium"
                    :class="serviceTierClass(detail.serviceTier)"
                  >
                    {{ formatServiceTier(detail.serviceTier) }}
                  </span>
                  <span
                    v-if="detail.serviceTier"
                    class="ml-1 text-gray-500 dark:text-gray-400"
                  >{{ detail.serviceTier }}</span>
                </dd>
              </div>
              <div
                v-if="protocolBridgeLabel || inferredBridgeLabel || detail.tokenCountEstimate"
                class="grid grid-cols-[5.5rem_1fr] gap-x-2 py-1.5 sm:grid-cols-[6rem_1fr]"
              >
                <dt class="text-gray-500 dark:text-gray-400">协议</dt>
                <dd class="flex flex-wrap items-center gap-2 text-gray-900 dark:text-gray-100">
                  <span
                    v-if="protocolBridgeLabel || inferredBridgeLabel"
                    class="rounded-full bg-indigo-100 px-2 py-0.5 text-sm font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                  >
                    桥接 {{ protocolBridgeLabel || inferredBridgeLabel }}
                  </span>
                  <span
                    v-if="detail.tokenCountEstimate"
                    class="rounded-full bg-amber-100 px-2 py-0.5 text-sm font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                    :title="detail.tokenCountEstimateMethod || 'char_heuristic'"
                  >
                    Token 估算
                  </span>
                </dd>
              </div>
            </dl>

            <!-- Token / 费用表 -->
            <div class="mt-2 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              <table class="w-full text-sm">
                <thead class="bg-gray-50 text-left text-gray-500 dark:bg-gray-800/80 dark:text-gray-400">
                  <tr>
                    <th class="px-2.5 py-1.5 font-medium">项目</th>
                    <th class="px-2.5 py-1.5 text-right font-medium">Token</th>
                    <th class="px-2.5 py-1.5 text-right font-medium">费用</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                  <tr>
                    <td class="px-2.5 py-1.5 text-gray-600 dark:text-gray-300">输入</td>
                    <td class="px-2.5 py-1.5 text-right font-medium text-blue-600 dark:text-blue-400">
                      {{ formatNumber(detail.inputTokens) }}
                    </td>
                    <td class="px-2.5 py-1.5 text-right text-gray-900 dark:text-gray-100">
                      {{ formatCost(costBreakdown.input) }}
                    </td>
                  </tr>
                  <tr>
                    <td class="px-2.5 py-1.5 text-gray-600 dark:text-gray-300">输出</td>
                    <td class="px-2.5 py-1.5 text-right font-medium text-green-600 dark:text-green-400">
                      {{ formatNumber(detail.outputTokens) }}
                    </td>
                    <td class="px-2.5 py-1.5 text-right text-gray-900 dark:text-gray-100">
                      {{ formatCost(costBreakdown.output) }}
                    </td>
                  </tr>
                  <tr>
                    <td class="px-2.5 py-1.5 text-gray-600 dark:text-gray-300">缓存读取</td>
                    <td class="px-2.5 py-1.5 text-right font-medium text-cyan-600 dark:text-cyan-400">
                      {{ formatNumber(detail.cacheReadTokens) }}
                    </td>
                    <td class="px-2.5 py-1.5 text-right text-gray-900 dark:text-gray-100">
                      {{ formatCost(costBreakdown.cacheRead) }}
                    </td>
                  </tr>
                  <tr>
                    <td class="px-2.5 py-1.5 text-gray-600 dark:text-gray-300">缓存创建</td>
                    <td class="px-2.5 py-1.5 text-right font-medium text-purple-600 dark:text-purple-400">
                      {{ formatCacheCreate(detail.cacheCreateTokens, detail.cacheCreateNotApplicable) }}
                    </td>
                    <td class="px-2.5 py-1.5 text-right text-gray-900 dark:text-gray-100">
                      {{
                        formatCacheCreateCost(
                          costBreakdown.cacheCreate,
                          detail.cacheCreateNotApplicable
                        )
                      }}
                    </td>
                  </tr>
                  <tr class="bg-gray-50/80 dark:bg-gray-800/40">
                    <td class="px-2.5 py-1.5 font-semibold text-gray-800 dark:text-gray-100">
                      合计
                      <span class="ml-1 font-normal text-gray-500 dark:text-gray-400">
                        {{ detail.costRecomputed ? '估算' : '真实' }}
                        <template v-if="detail.usedFallbackPricing"> · fallback</template>
                      </span>
                    </td>
                    <td class="px-2.5 py-1.5 text-right font-semibold text-gray-900 dark:text-gray-100">
                      {{ formatNumber(detail.totalTokens) }}
                    </td>
                    <td class="px-2.5 py-1.5 text-right font-semibold text-amber-600 dark:text-amber-400">
                      {{ formatCost(detail.cost) }}
                      <template v-if="showRealCostBeside">
                        <span class="ml-1 font-normal text-gray-500 dark:text-gray-400">
                          ({{ formatCost(detail.realCost) }})
                        </span>
                      </template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Request Body -->
            <div class="mt-2">
              <div class="mb-1 flex items-center justify-between gap-2">
                <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Request Body</p>
                <button
                  v-if="hasRequestBodySnapshot"
                  class="rounded border border-gray-200 px-1.5 py-0.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  type="button"
                  @click="copySnapshot"
                >
                  复制
                </button>
              </div>
              <div
                v-if="hasRequestBodySnapshot"
                class="max-h-[40vh] overflow-auto rounded-lg bg-slate-900 p-2.5"
              >
                <pre class="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-200">{{
                  formattedSnapshot
                }}</pre>
              </div>
              <p
                v-else-if="!bodyPreviewEnabled"
                class="rounded-lg border border-dashed border-amber-300 bg-amber-50/70 px-2.5 py-2 text-sm text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
              >
                请求体预览已关闭，仅保留摘要字段。
              </p>
              <p
                v-else
                class="rounded-lg border border-dashed border-gray-300 px-2.5 py-2 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400"
              >
                未保存请求体快照
              </p>
            </div>
          </template>
        </div>
      </div>
    </div>
  </ModalTransition>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ModalTransition from '@/components/common/modal_transition.vue'
import { getRequestDetailApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast, formatNumber } from '@/libs/tools'
import { formatLocalDateTime } from '@/libs/time'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  requestId: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['close'])

const loading = ref(false)
const detail = ref(null)
const bodyPreviewEnabled = ref(false)
const isMobileViewport = ref(false)

const costBreakdown = computed(() => {
  const breakdown = detail.value?.realCostBreakdown || detail.value?.costBreakdown || {}
  return {
    input: breakdown.input || 0,
    output: breakdown.output || 0,
    cacheCreate: breakdown.cacheCreate || breakdown.cacheWrite || 0,
    cacheRead: breakdown.cacheRead || 0,
    total: breakdown.total || detail.value?.realCost || detail.value?.cost || 0
  }
})

// 计费与真实成本数值不同时，合计列旁再标真实成本
const showRealCostBeside = computed(() => {
  if (!detail.value) return false
  const billed = Number(detail.value.cost || 0)
  const real = Number(detail.value.realCost || 0)
  return Number.isFinite(billed) && Number.isFinite(real) && Math.abs(billed - real) > 1e-9
})

// 后端写入的跨协议桥标记
const protocolBridgeLabel = computed(() => {
  const value = detail.value?.protocolBridge
  return typeof value === 'string' && value.trim() ? value.trim() : ''
})

// 无显式标记时：/v1/messages 打到 openai/grok 账户则推断为桥接
const inferredBridgeLabel = computed(() => {
  if (protocolBridgeLabel.value) return ''
  const endpoint = String(detail.value?.endpoint || '')
  const accountType = String(detail.value?.accountType || '').toLowerCase()
  if (!endpoint.includes('/v1/messages') && !endpoint.endsWith('/messages')) {
    return ''
  }
  if (accountType === 'openai' || accountType === 'openai-responses') {
    return 'claude-messages→openai'
  }
  if (accountType === 'grok') {
    return 'claude-messages→grok'
  }
  return ''
})

const previewSuffixPattern = /\.\.\.\[\d+ chars\]$/

const tryFormatJsonString = (value) => {
  if (typeof value !== 'string') {
    return null
  }

  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch (_error) {
    return null
  }
}

const formatJsonLikeText = (value) => {
  if (typeof value !== 'string') {
    return ''
  }

  const suffix = value.match(previewSuffixPattern)?.[0] || ''
  const source = suffix ? value.slice(0, -suffix.length) : value
  let formatted = ''
  let indent = 0
  let inString = false
  let escaping = false

  const appendIndent = () => {
    formatted += '  '.repeat(Math.max(0, indent))
  }

  for (const char of source) {
    if (escaping) {
      formatted += char
      escaping = false
      continue
    }

    if (char === '\\') {
      formatted += char
      escaping = inString
      continue
    }

    if (char === '"') {
      inString = !inString
      formatted += char
      continue
    }

    if (inString) {
      formatted += char
      continue
    }

    if (char === '{' || char === '[') {
      formatted += `${char}\n`
      indent += 1
      appendIndent()
      continue
    }

    if (char === '}' || char === ']') {
      formatted = formatted.replace(/[ \t]+$/g, '')
      formatted = formatted.replace(/\n?$/, '\n')
      indent = Math.max(0, indent - 1)
      appendIndent()
      formatted += char
      continue
    }

    if (char === ',') {
      formatted += ',\n'
      appendIndent()
      continue
    }

    if (char === ':') {
      formatted += ': '
      continue
    }

    formatted += char
  }

  const trimmed = formatted.trim()
  if (!trimmed) {
    return suffix
  }

  return suffix ? `${trimmed}\n${suffix}` : trimmed
}

const extractSnapshotDisplaySource = (snapshot) => {
  if (!snapshot) {
    return ''
  }

  if (
    typeof snapshot === 'object' &&
    !Array.isArray(snapshot) &&
    typeof snapshot.preview === 'string'
  ) {
    return snapshot.preview
  }

  return snapshot
}

const hasRequestBodySnapshot = computed(() => Boolean(detail.value?.requestBodySnapshot))

const formattedSnapshot = computed(() => {
  if (!detail.value?.requestBodySnapshot) {
    return ''
  }

  const snapshotSource = extractSnapshotDisplaySource(detail.value.requestBodySnapshot)

  if (typeof snapshotSource === 'string') {
    return tryFormatJsonString(snapshotSource) || formatJsonLikeText(snapshotSource)
  }

  return JSON.stringify(snapshotSource, null, 2)
})

const emitClose = () => emit('close')

const fetchDetail = async () => {
  if (!props.show || !props.requestId) {
    return
  }

  const targetRequestId = props.requestId

  loading.value = true
  detail.value = null
  try {
    const response = await getRequestDetailApi(targetRequestId)
    if (targetRequestId !== props.requestId || !props.show) return
    if (!isOk(response)) {
      showToast(msgOf(response, '加载请求详情失败'), 'error')
      return
    }
    bodyPreviewEnabled.value = response.data?.bodyPreviewEnabled === true
    detail.value = response.data?.record || null
  } catch (error) {
    if (targetRequestId !== props.requestId || !props.show) return
    detail.value = null
    bodyPreviewEnabled.value = false
    showToast(`加载请求详情失败：${error.message || '未知错误'}`, 'error')
  } finally {
    if (targetRequestId === props.requestId) {
      loading.value = false
    }
  }
}

const copySnapshot = async () => {
  if (!formattedSnapshot.value) {
    showToast('没有可复制的快照', 'info')
    return
  }

  try {
    await navigator.clipboard.writeText(formattedSnapshot.value)
    showToast('已复制请求快照', 'success')
  } catch (_error) {
    showToast('复制失败，请手动复制', 'error')
  }
}

const formatDate = (value) => formatLocalDateTime(value) || '-'
const formatDuration = (value) => `${Number(value || 0)}ms`
const formatPercent = (value) => `${Number(value || 0).toFixed(2)}%`
const formatCacheCreate = (value, notApplicable = false) =>
  notApplicable ? '-' : formatNumber(value)
const formatReasoning = (value) => value || '-'
// OpenAI service_tier：fast/priority 同溢价档，ultrafast/flex 单独标
const formatServiceTier = (tier) => {
  if (typeof tier !== 'string' || !tier.trim()) return ''
  const normalized = tier.trim().toLowerCase()
  if (normalized === 'fast' || normalized === 'priority') return 'Fast'
  if (normalized === 'ultrafast') return 'Ultrafast'
  if (normalized === 'flex') return 'Flex'
  if (normalized === 'default' || normalized === 'auto') return 'Default'
  return tier
}
const serviceTierClass = (tier) => {
  const normalized = typeof tier === 'string' ? tier.trim().toLowerCase() : ''
  if (normalized === 'fast' || normalized === 'priority' || normalized === 'ultrafast') {
    return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
  }
  if (normalized === 'flex') {
    return 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300'
  }
  return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
}
const formatCost = (value) => {
  const num = Number(value || 0)
  if (num >= 1) return `$${num.toFixed(2)}`
  if (num >= 0.001) return `$${num.toFixed(4)}`
  return `$${num.toFixed(6)}`
}
const formatCacheCreateCost = (value, notApplicable = false) =>
  notApplicable ? '-' : formatCost(value)

const statusClass = (statusCode) => {
  if (statusCode >= 500) return 'bg-red-600'
  if (statusCode >= 400) return 'bg-amber-500'
  return 'bg-green-600'
}

const syncViewportState = () => {
  if (typeof window === 'undefined') {
    return
  }
  isMobileViewport.value = window.innerWidth < 768
}

watch(
  () => [props.show, props.requestId],
  () => {
    fetchDetail()
  },
  { immediate: true }
)

watch(
  () => props.show,
  (visible) => {
    if (!visible) {
      detail.value = null
      bodyPreviewEnabled.value = false
    }
  }
)

onMounted(() => {
  syncViewportState()
  window.addEventListener('resize', syncViewportState)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncViewportState)
})
</script>
