<template>
  <ModalTransition>
    <div
      v-if="show"
      class="request-detail-modal fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 pt-[6vh] sm:p-4"
      @click.self="emitClose"
    >
      <div
        :class="[
          'modal-content w-full rounded-2xl bg-white shadow-xl dark:bg-gray-900',
          isMobileViewport ? 'min-h-[100dvh] max-w-none rounded-none' : 'max-w-[960px]'
        ]"
      >
    <div class="border-b border-gray-200 px-5 py-4 dark:border-gray-700">
      <div class="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap sm:items-center">
        <div class="min-w-0 flex-1">
          <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">
            {{ detail?.model || '加载中...' }}
          </h3>
          <p class="mt-1 break-all text-sm text-gray-500 dark:text-gray-400 sm:text-sm">
            Request ID: {{ requestId || '未知' }}
          </p>
        </div>
        <div class="flex items-center gap-2 self-start sm:self-center">
          <span
            v-if="detail"
            :class="[
              'rounded-full px-2 py-0.5 text-sm font-semibold text-white',
              statusTagType(detail.statusCode) === 'success'
                ? 'bg-green-600'
                : statusTagType(detail.statusCode) === 'warning'
                  ? 'bg-amber-500'
                  : statusTagType(detail.statusCode) === 'danger'
                    ? 'bg-red-600'
                    : 'bg-gray-600'
            ]"
          >
            {{ detail.statusCode || 200 }}
          </span>
          <button aria-label="关闭" class="modal-close-button" type="button" @click="emitClose">
            <i class="i-lucide-x" />
          </button>
        </div>
      </div>
    </div>

    <div class="relative space-y-4 px-5 py-4" :class="{ 'opacity-60': loading }">
      <div
        v-if="!loading && !detail"
        class="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400"
      >
        未找到该请求详情
      </div>

      <template v-else-if="detail">
        <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div class="info-card">
            <p class="info-label">接口</p>
            <p class="info-value">{{ detail.endpoint || '-' }}</p>
            <p class="info-sub">{{ detail.method || 'POST' }}</p>
          </div>
          <div class="info-card">
            <p class="info-label">耗时</p>
            <p class="info-value">{{ formatDuration(detail.durationMs) }}</p>
            <p class="info-sub">{{ detail.stream ? '流式请求' : '非流式请求' }}</p>
          </div>
          <div class="info-card">
            <p class="info-label">费用</p>
            <p class="info-value text-amber-600 dark:text-amber-400">
              {{ formatCost(detail.cost) }}
            </p>
            <p class="info-sub">
              {{ detail.costRecomputed ? '估算成本' : '真实成本' }}
              {{ formatCost(detail.realCost) }}
              <span v-if="detail.usedFallbackPricing">unknown fallback</span>
            </p>
          </div>
          <div class="info-card">
            <p class="info-label">缓存命中率</p>
            <p class="info-value text-cyan-600 dark:text-cyan-400">
              {{ formatPercent(detail.cacheHitRate) }}
            </p>
            <p class="info-sub">{{ cacheHitRateLabel }}</p>
          </div>
        </div>

        <div class="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
          <div
            class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
          >
            <h4 class="section-title">基础信息</h4>
            <div class="grid gap-3 md:grid-cols-2">
              <div>
                <p class="field-label">时间</p>
                <p class="field-value">{{ formatDate(detail.timestamp) }}</p>
              </div>
              <div>
                <p class="field-label">API Key</p>
                <p class="field-value">{{ detail.apiKeyName || detail.apiKeyId || '-' }}</p>
                <p class="field-sub">{{ detail.apiKeyId || '-' }}</p>
              </div>
              <div>
                <p class="field-label">使用账户</p>
                <p class="field-value">{{ detail.accountName || detail.accountId || '-' }}</p>
                <p class="field-sub">{{ detail.accountTypeName || detail.accountType || '-' }}</p>
              </div>
              <div>
                <p class="field-label">模型</p>
                <p class="field-value">{{ detail.model || '-' }}</p>
                <p class="field-sub">
                  {{ detail.isLongContextRequest ? '长上下文请求' : '标准上下文' }}
                </p>
              </div>
              <div>
                <p class="field-label">推理</p>
                <p class="field-value">{{ formatReasoning(detail.reasoningDisplay) }}</p>
                <p class="field-sub">
                  {{ detail.reasoningSource ? `来源：${detail.reasoningSource}` : '未指定' }}
                </p>
              </div>
            </div>
          </div>

          <div
            class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
          >
            <h4 class="section-title">Token 明细</h4>
            <div class="space-y-2 text-sm">
              <div class="metric-row">
                <span>输入</span>
                <span class="font-semibold text-blue-600 dark:text-blue-400">{{
                  formatNumber(detail.inputTokens)
                }}</span>
              </div>
              <div class="metric-row">
                <span>输出</span>
                <span class="font-semibold text-green-600 dark:text-green-400">{{
                  formatNumber(detail.outputTokens)
                }}</span>
              </div>
              <div class="metric-row">
                <span>缓存读取</span>
                <span class="font-semibold text-cyan-600 dark:text-cyan-400">{{
                  formatNumber(detail.cacheReadTokens)
                }}</span>
              </div>
              <div class="metric-row">
                <span>缓存创建</span>
                <span class="font-semibold text-purple-600 dark:text-purple-400">{{
                  formatCacheCreate(detail.cacheCreateTokens, detail.cacheCreateNotApplicable)
                }}</span>
              </div>
              <div
                class="metric-row border-t border-dashed border-gray-200 pt-2 dark:border-gray-700"
              >
                <span>总 Token</span>
                <span class="font-semibold text-gray-900 dark:text-gray-100">{{
                  formatNumber(detail.totalTokens)
                }}</span>
              </div>
            </div>
          </div>
        </div>

        <div
          class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
        >
          <h4 class="section-title">费用拆分</h4>
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div class="cost-chip">
              <span>输入</span>
              <strong>{{ formatCost(costBreakdown.input) }}</strong>
            </div>
            <div class="cost-chip">
              <span>输出</span>
              <strong>{{ formatCost(costBreakdown.output) }}</strong>
            </div>
            <div class="cost-chip">
              <span>缓存创建</span>
              <strong>{{
                formatCacheCreateCost(costBreakdown.cacheCreate, detail.cacheCreateNotApplicable)
              }}</strong>
            </div>
            <div class="cost-chip">
              <span>缓存读取</span>
              <strong>{{ formatCost(costBreakdown.cacheRead) }}</strong>
            </div>
            <div class="cost-chip">
              <span>总计</span>
              <strong>{{ formatCost(costBreakdown.total || detail.cost) }}</strong>
            </div>
          </div>
        </div>

        <div
          class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
        >
          <div class="mb-3 flex items-center justify-between gap-3">
            <h4 class="section-title mb-0">Request Body 快照</h4>
            <button v-if="hasRequestBodySnapshot" class="rounded-md border border-gray-200 px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700" type="button" @click="copySnapshot">
              复制 JSON
            </button>
          </div>
          <div v-if="hasRequestBodySnapshot" class="snapshot-panel">
            <pre>{{ formattedSnapshot }}</pre>
          </div>
          <div
            v-else-if="!bodyPreviewEnabled"
            class="rounded-lg border border-dashed border-amber-300 bg-amber-50/70 px-4 py-6 text-sm text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
          >
            请求体预览已关闭，当前仅保留请求摘要字段，不展示请求体快照。
          </div>
          <div
            v-else
            class="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400"
          >
            未保存请求体快照
          </div>
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

const previewSuffixPattern = /\.\.\.\[\d+ chars\]$/

const tryFormatJsonString = (value) => {
  if (typeof value !== 'string') {
    return null
  }

  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch (error) {
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

const cacheHitRateLabel = computed(() => '读 / (输入 + 读 + 建)')

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
    if (response?.success === false) {
      showToast(response.message || '加载请求详情失败', 'error')
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
  } catch (error) {
    showToast('复制失败，请手动复制', 'error')
  }
}

const formatDate = (value) => formatLocalDateTime(value) || '-'
const formatDuration = (value) => `${Number(value || 0)}ms`
const formatPercent = (value) => `${Number(value || 0).toFixed(2)}%`
const formatCacheCreate = (value, notApplicable = false) =>
  notApplicable ? '-' : formatNumber(value)
const formatReasoning = (value) => value || '-'
const formatCost = (value) => {
  const num = Number(value || 0)
  if (num >= 1) return `$${num.toFixed(2)}`
  if (num >= 0.001) return `$${num.toFixed(4)}`
  return `$${num.toFixed(6)}`
}
const formatCacheCreateCost = (value, notApplicable = false) =>
  notApplicable ? '-' : formatCost(value)

const statusTagType = (statusCode) => {
  if (statusCode >= 500) return 'danger'
  if (statusCode >= 400) return 'warning'
  return 'success'
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

<style scoped>



.modal-close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  color: rgb(100 116 139);
  transition: all 0.2s ease;
}

.modal-close-button:hover {
  background: rgba(148, 163, 184, 0.14);
  color: rgb(51 65 85);
}

.dark .modal-close-button {
  color: rgb(203 213 225);
}

.dark .modal-close-button:hover {
  background: rgba(71, 85, 105, 0.35);
  color: rgb(248 250 252);
}

.info-card {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 16px;
  padding: 16px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.98), rgba(240, 249, 255, 0.94));
}

.dark .info-card {
  background: linear-gradient(135deg, rgba(17, 24, 39, 0.94), rgba(15, 23, 42, 0.92));
  border-color: rgba(71, 85, 105, 0.35);
}

.info-label,
.field-label {
  font-size: 14px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgb(100 116 139);
}

.dark .info-label,
.dark .field-label {
  color: rgb(148 163 184);
}

.info-value,
.field-value {
  margin-top: 6px;
  font-size: 18px;
  font-weight: 700;
  color: rgb(15 23 42);
}

.dark .info-value,
.dark .field-value {
  color: rgb(241 245 249);
}

.info-sub,
.field-sub {
  margin-top: 4px;
  font-size: 14px;
  color: rgb(100 116 139);
}

.dark .info-sub,
.dark .field-sub {
  color: rgb(148 163 184);
}

.section-title {
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 700;
  color: rgb(30 41 59);
}

.dark .section-title {
  color: rgb(226 232 240);
}

.metric-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: rgb(71 85 105);
}

.dark .metric-row {
  color: rgb(203 213 225);
}

.cost-chip {
  border-radius: 14px;
  background: rgb(248 250 252);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
}

.dark .cost-chip {
  background: rgba(30, 41, 59, 0.75);
  color: rgb(203 213 225);
}

.dark .cost-chip strong {
  color: rgb(241 245 249);
}

.snapshot-panel {
  max-height: 380px;
  overflow: auto;
  border-radius: 14px;
  background: rgb(15 23 42);
  padding: 16px;
}

.snapshot-panel pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.55;
  color: rgb(226 232 240);
}

@media (max-width: 767px) {
  
  
  .info-card {
    padding: 14px;
  }

  .info-value,
  .field-value {
    font-size: 16px;
  }

  .cost-chip {
    padding: 10px 12px;
  }

  .snapshot-panel {
    max-height: min(42vh, 420px);
    padding: 14px;
  }

  .snapshot-panel pre {
    font-size: 14px;
    line-height: 1.5;
  }
}
</style>
