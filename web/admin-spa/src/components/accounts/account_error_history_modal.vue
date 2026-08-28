<template>
  <ModalTransition>
    <div
      v-if="show"
      class="fixed inset-0 z-[1050] flex items-center justify-center bg-gray-900/40 backdrop-blur-sm"
    >
      <div class="absolute inset-0" @click="handleClose" />
      <div
        class="modal-panel relative z-10 mx-3 flex h-[min(92dvh,960px)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-gray-200/70 bg-white/95 shadow-2xl ring-1 ring-black/5 dark:border-gray-700/60 dark:bg-gray-900/95 dark:ring-white/10 sm:mx-4"
      >
        <!-- 顶栏 -->
        <div
          class="flex shrink-0 items-center justify-between gap-3 border-b border-gray-100 bg-white/80 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-900/80 sm:px-5"
        >
          <div class="flex min-w-0 items-center gap-3">
            <div
              class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-red-500 to-orange-500 text-white shadow-lg"
            >
              <i class="i-lucide-triangle-alert text-sm" />
            </div>
            <div class="min-w-0">
              <h3 class="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">
                {{ accountName || '错误历史' }}
              </h3>
              <p class="text-sm text-gray-500 dark:text-gray-400">
                上游错误时间线 · 可筛选 / 分页 / 导出
              </p>
            </div>
          </div>
          <div class="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <button
              v-if="list.length > 0"
              class="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              type="button"
              :disabled="exporting"
              @click="handleCopyAll"
            >
              <i :class="exporting ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-copy'" />
              复制全部
            </button>
            <button
              v-if="list.length > 0"
              class="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              type="button"
              :disabled="exporting"
              @click="handleDownloadAll"
            >
              <i :class="exporting ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-download'" />
              下载全部
            </button>
            <button
              v-if="total > 0"
              class="rounded-lg bg-red-50 px-2.5 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
              type="button"
              :disabled="clearing || loading || exporting"
              @click="handleClear"
            >
              {{ clearing ? '清空中...' : '清空' }}
            </button>
            <button
              class="flex h-9 w-9 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
              type="button"
              @click="handleClose"
            >
              <i class="i-lucide-x" />
            </button>
          </div>
        </div>

        <!-- 筛选栏 -->
        <div
          class="flex shrink-0 flex-col gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-800 sm:flex-row sm:flex-wrap sm:items-center sm:px-5"
        >
          <AppDateRangePicker
            v-model="dateRange"
            class="w-full min-w-0 sm:max-w-md"
            :disabled="loading || clearing || exporting"
            clearable
            presets="filter"
            size="sm"
          />
          <button
            class="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            type="button"
            :disabled="loading || clearing || exporting"
            @click="handleRefresh"
          >
            <i :class="loading || clearing ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw'" />
            刷新
          </button>
          <button
            class="text-sm text-gray-500 hover:text-blue-500 dark:text-gray-400"
            type="button"
            @click="showHelp = !showHelp"
          >
            <i class="i-lucide-info mr-1" />
            {{ showHelp ? '收起说明' : '机制说明' }}
          </button>
        </div>

        <div
          v-if="showHelp"
          class="shrink-0 space-y-1 border-b border-gray-100 bg-blue-50/40 px-4 py-2.5 text-sm leading-relaxed text-gray-500 dark:border-gray-800 dark:bg-blue-500/5 dark:text-gray-400 sm:px-5"
        >
          <p>
            · 上游返回错误时按状态码自动标记临时不可用；冷却期内跳过该账户，到期恢复。
          </p>
          <p>
            · 每条尽量采集请求 URL / 头 / 体与响应头 / 体（已脱敏截断）；流式中断仅含已收到部分。
          </p>
          <p>· 历史默认最多保留最近 3 天、每账户 5000 条（upstreamError 可配）。导出全部会截断过大请求/响应字段，条数硬顶 20000。</p>
        </div>

        <!-- 列表 -->
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <div v-if="loading" class="flex items-center justify-center py-12">
            <i class="i-lucide-loader-circle mr-2 animate-spin text-gray-400" />
            <span class="text-sm text-gray-500 dark:text-gray-400">加载中...</span>
          </div>

          <div
            v-else-if="!list.length"
            class="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-gray-500"
          >
            <i class="i-lucide-circle-check mb-3 text-3xl text-green-400" />
            <span class="text-sm">{{ hasActiveFilter ? '该时间范围内暂无错误' : '暂无错误记录' }}</span>
          </div>

          <ol v-else class="relative space-y-0 border-l-2 border-gray-200 pl-5 dark:border-gray-700">
            <li
              v-for="(item, idx) in list"
              :key="itemKey(item, idx)"
              class="relative pb-5 last:pb-0"
            >
              <span
                class="absolute -left-[1.4rem] top-1.5 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-white dark:ring-gray-900"
                :class="dotClass(item.status)"
              />
              <div
                class="rounded-xl border border-gray-100 bg-gray-50/70 p-3 dark:border-gray-700/60 dark:bg-gray-800/50"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="inline-flex items-center rounded px-1.5 py-0.5 text-sm font-bold"
                    :class="statusClass(item.status)"
                  >
                    {{ item.status || '-' }}
                  </span>
                  <span
                    v-if="item.errorType"
                    class="rounded bg-gray-200 px-1.5 py-0.5 text-sm text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                  >
                    {{ errorTypeLabel(item.errorType) }}
                  </span>
                  <span
                    v-if="item.context?.reason"
                    class="rounded bg-slate-100 px-1.5 py-0.5 text-sm text-slate-600 dark:bg-slate-700/60 dark:text-slate-300"
                    :title="item.context.reason"
                  >
                    {{ reasonLabel(item.context.reason) }}
                  </span>
                  <button
                    class="rounded px-1.5 py-0.5 text-sm text-gray-400 transition hover:bg-gray-200 hover:text-blue-500 dark:hover:bg-gray-700"
                    title="复制本条"
                    type="button"
                    @click="copyItem(item, idx)"
                  >
                    <i
                      :class="
                        copiedKey === `${idx}-item`
                          ? 'i-lucide-check text-green-500'
                          : 'i-lucide-copy'
                      "
                    />
                  </button>
                  <span class="ml-auto text-sm tabular-nums text-gray-400 dark:text-gray-500">
                    {{ formatTime(item.time) }}
                  </span>
                </div>

                <div
                  v-if="item.context"
                  class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500 dark:text-gray-400"
                >
                  <span v-if="item.context.model">
                    <i class="i-lucide-bot mr-1" />{{ item.context.model }}
                  </span>
                  <span v-if="item.context.method || item.context.url" class="break-all">
                    <i class="i-lucide-send mr-1" />{{ item.context.method }}
                    {{ shortUrl(item.context.url) }}
                  </span>
                  <span v-if="item.context.path">
                    <i class="i-lucide-route mr-1" />{{ item.context.path }}
                  </span>
                  <span v-if="item.context.apiKeyName">
                    <i class="i-lucide-key mr-1" />{{ item.context.apiKeyName }}
                  </span>
                  <span v-if="item.context.message" class="line-clamp-2 break-all">
                    <i class="i-lucide-message-square-warning mr-1" />{{
                      shortText(item.context.message)
                    }}
                  </span>
                </div>

                <p
                  v-if="!hasDetail(item.context)"
                  class="mt-2 text-sm text-gray-400 dark:text-gray-500"
                >
                  本条未采集到请求/响应详情（多为历史薄记录）。新错误会附带请求体与上游响应。
                </p>

                <div v-if="hasDetail(item.context)" class="mt-2">
                  <button
                    class="text-sm text-blue-500 hover:text-blue-600 dark:text-blue-400"
                    type="button"
                    @click="toggleDetail(idx)"
                  >
                    {{ expandedIdx === idx ? '收起详情' : '查看请求/响应详情' }}
                    <i
                      class="ml-1"
                      :class="
                        expandedIdx === idx ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
                      "
                    />
                  </button>
                  <div v-if="expandedIdx === idx" class="mt-2 space-y-2">
                    <div v-for="field in detailFields(item.context)" :key="field.key">
                      <div class="mb-1 flex items-center gap-2">
                        <span class="text-sm font-medium text-gray-600 dark:text-gray-300">
                          {{ field.label }}
                        </span>
                        <button
                          class="text-sm text-gray-400 transition hover:text-blue-500"
                          :title="`复制${field.label}`"
                          type="button"
                          @click="copyText(field.value, `${idx}-${field.key}`)"
                        >
                          <i
                            :class="
                              copiedKey === `${idx}-${field.key}`
                                ? 'i-lucide-check text-green-500'
                                : 'i-lucide-copy'
                            "
                          />
                        </button>
                      </div>
                      <pre
                        class="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-100 p-2 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                        >{{ field.value }}</pre
                      >
                    </div>
                  </div>
                </div>
              </div>
            </li>
          </ol>
        </div>

        <!-- 底部分页 -->
        <div
          v-if="total > 0"
          class="shrink-0 border-t border-gray-100 px-4 py-3 dark:border-gray-800 sm:px-5"
        >
          <AppPagination
            v-model:current-page="currentPage"
            v-model:page-size="pageSize"
            :class="{ 'pointer-events-none opacity-50': clearing || exporting }"
            :page-sizes="[20, 50, 100]"
            :total="total"
            @current-change="onPageChange"
            @size-change="handleSizeChange"
          />
        </div>
      </div>
    </div>
  </ModalTransition>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import ModalTransition from '@/components/common/modal_transition.vue'
import AppDateRangePicker from '@/components/common/app_date_range_picker.vue'
import AppPagination from '@/components/common/app_pagination.vue'

import * as httpApis from '@/libs/http_apis'
import { isOk, msgOf, dataOf } from '@/libs/http_envelope'
import { formatLocalDateTime } from '@/libs/time'
import { showToast } from '@/libs/tools'

const props = defineProps({
  show: Boolean,
  accountType: { type: String, default: '' },
  accountId: { type: String, default: '' },
  accountName: { type: String, default: '' }
})

const emit = defineEmits(['close'])

const loading = ref(false)
const clearing = ref(false)
const list = ref([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const dateRange = ref(null)
const expandedIdx = ref(null)
const showHelp = ref(false)
const copiedKey = ref(null)

const hasActiveFilter = computed(
  () => Array.isArray(dateRange.value) && !!(dateRange.value[0] || dateRange.value[1])
)

const buildQuery = () => {
  const params = {
    offset: (currentPage.value - 1) * pageSize.value,
    limit: pageSize.value
  }
  if (Array.isArray(dateRange.value)) {
    // AppDateRangePicker 产出业务时区存库串；后端 Date.parse 可识别，按绝对时刻过滤
    if (dateRange.value[0]) params.startTime = dateRange.value[0]
    if (dateRange.value[1]) params.endTime = dateRange.value[1]
  }
  return params
}

// 请求序号：筛选/翻页/刷新并发时，丢弃过期响应，避免列表与筛选错位
let fetchSeq = 0

const fetchHistory = async () => {
  if (!props.accountType || !props.accountId) return
  // 清空/导出进行中禁止新查询，避免交叉写回或导出中途改筛选
  if (clearing.value || exporting.value) return
  const seq = ++fetchSeq
  loading.value = true
  expandedIdx.value = null
  try {
    const res = await httpApis.getAccountErrorHistoryApi(
      props.accountType,
      props.accountId,
      buildQuery()
    )
    if (seq !== fetchSeq) return
    if (!isOk(res)) {
      showToast(msgOf(res, '加载错误历史失败'), 'error')
      list.value = []
      total.value = 0
      return
    }
    const payload = dataOf(res)
    // 兼容旧数组形状（防中途热更后端未起）
    if (Array.isArray(payload)) {
      list.value = payload
      total.value = payload.length
      return
    }
    list.value = Array.isArray(payload?.items) ? payload.items : []
    total.value = Number(payload?.total) || 0
  } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

const handleSizeChange = () => {
  if (clearing.value || exporting.value) return
  currentPage.value = 1
  fetchHistory()
}

const onPageChange = () => {
  if (clearing.value || exporting.value) return
  fetchHistory()
}

const handleRefresh = () => {
  if (clearing.value || exporting.value) return
  currentPage.value = 1
  fetchHistory()
}

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    currentPage.value = 1
    dateRange.value = null
    list.value = []
    total.value = 0
    expandedIdx.value = null
    fetchHistory()
  }
)

// 时间范围变更：重置页码再拉
watch(
  dateRange,
  () => {
    if (!props.show || clearing.value || exporting.value) return
    currentPage.value = 1
    fetchHistory()
  },
  { deep: true }
)

const handleClose = () => emit('close')

const handleClear = async () => {
  if (clearing.value || exporting.value) return
  // 作废在途查询；clearing 挡住刷新/筛选，成功后无论序号如何都落空列表
  clearing.value = true
  fetchSeq += 1
  loading.value = true
  try {
    const res = await httpApis.clearAccountErrorHistoryApi(props.accountType, props.accountId)
    if (isOk(res)) {
      list.value = []
      total.value = 0
      currentPage.value = 1
      // 再抬序号，清掉清空期间任何仍返回的查询
      fetchSeq += 1
      showToast('已清空错误历史', 'success')
    } else {
      showToast(msgOf(res, '清空错误历史失败'), 'error')
    }
  } finally {
    clearing.value = false
    loading.value = false
  }
}

const toggleDetail = (idx) => {
  expandedIdx.value = expandedIdx.value === idx ? null : idx
}

const itemKey = (item, idx) => `${item.time || ''}-${item.status || ''}-${idx}`

const formatTime = (time) => formatLocalDateTime(time) || '-'

const formatBody = (body) => {
  if (typeof body === 'string') {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      return body
    }
  }
  return JSON.stringify(body, null, 2)
}

const shortUrl = (url) => {
  if (!url) return ''
  return url.length > 60 ? `${url.slice(0, 60)}…` : url
}

const shortText = (text) => {
  if (!text) return ''
  const normalized = String(text).replace(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized
}

const ERROR_TYPE_LABELS = {
  rate_limit: '限流',
  auth_error: '鉴权失败',
  overload: '过载',
  service_unavailable: '服务不可用',
  server_error: '上游 5xx',
  timeout: '超时',
  token_refresh_failed: 'Token 刷新失败',
  unknown: '未知'
}

const REASON_LABELS = {
  auto_protection_disabled_rate_limit: '自动防护已关 · 上游限流（仅记历史）',
  auto_protection_disabled_unauthorized: '自动防护已关 · 上游鉴权失败（仅记历史）',
  account_auto_protection_disabled: '自动防护已关 · 跳过暂停（仍记历史）',
  token_refresh_failed: 'Token 刷新失败'
}

const errorTypeLabel = (type) => ERROR_TYPE_LABELS[type] || type || '-'
const reasonLabel = (reason) => REASON_LABELS[reason] || reason || ''

const DETAIL_DEFS = [
  {
    key: 'request',
    label: '请求地址',
    get: (c) => (c.method || c.url ? `${c.method || ''} ${c.url || ''}`.trim() : null)
  },
  { key: 'requestHeaders', label: '请求头', get: (c) => c.requestHeaders },
  { key: 'requestBody', label: '请求体', get: (c) => c.requestBody },
  { key: 'responseHeaders', label: '响应头', get: (c) => c.responseHeaders },
  { key: 'errorBody', label: '响应体', get: (c) => c.errorBody },
  { key: 'message', label: '错误信息', get: (c) => c.message },
  { key: 'reason', label: '内部原因码', get: (c) => c.reason }
]

const detailFields = (context) => {
  if (!context) return []
  return DETAIL_DEFS.map((def) => ({ key: def.key, label: def.label, value: def.get(context) }))
    .filter((field) => field.value)
    .map((field) => ({
      ...field,
      value:
        field.key === 'request' || field.key === 'message' || field.key === 'reason'
          ? field.value
          : formatBody(field.value)
    }))
}

const hasDetail = (context) => {
  if (!context) return false
  return Boolean(
    context.requestBody ||
      context.errorBody ||
      context.responseHeaders ||
      context.requestHeaders ||
      context.message ||
      context.url ||
      context.method
  )
}

const buildItemText = (item, index = 0) => {
  const lines = [
    `## [${index + 1}] ${formatTime(item.time)}`,
    `HTTP ${item.status || '-'} | ${errorTypeLabel(item.errorType)}`
  ]
  if (item.context?.model) lines.push(`模型: ${item.context.model}`)
  if (item.context?.apiKeyName) lines.push(`API Key: ${item.context.apiKeyName}`)
  if (item.context?.path) lines.push(`路径: ${item.context.path}`)
  if (item.context?.reason) lines.push(`原因: ${reasonLabel(item.context.reason)} (${item.context.reason})`)
  const fields = detailFields(item.context)
  for (const field of fields) {
    lines.push('', `### ${field.label}`, field.value)
  }
  if (!fields.length) {
    lines.push('', '(无请求/响应详情)')
  }
  return lines.join('\n')
}


// 导出：边拉边 slim 边拼文本，避免 2 万条原始对象 + 全量字符串双峰内存
const EXPORT_FIELD_MAX = 8 * 1024
const EXPORT_TOTAL_MAX = 12 * 1024 * 1024
const EXPORT_ITEM_HARD_CAP = 20000

const truncateExportValue = (value) => {
  if (value == null) return value
  const text = typeof value === 'string' ? value : String(value)
  if (text.length <= EXPORT_FIELD_MAX) return text
  return `${text.slice(0, EXPORT_FIELD_MAX)}\n... [export truncated ${text.length - EXPORT_FIELD_MAX} chars]`
}

const slimItemForExport = (item) => {
  if (!item?.context) return item
  const context = { ...item.context }
  for (const key of ['requestBody', 'errorBody', 'requestHeaders', 'responseHeaders', 'message']) {
    if (context[key] != null) context[key] = truncateExportValue(context[key])
  }
  return { ...item, context }
}

const buildExportHeader = ({ countLabel, rangeSnapshot }) => {
  const lines = [
    '# 错误历史导出',
    `账户: ${props.accountName || '-'}`,
    `类型/ID: ${props.accountType}/${props.accountId}`,
    `导出时间: ${formatLocalDateTime(new Date()) || '-'}`,
    `范围: ${countLabel}`,
  ]
  if (rangeSnapshot && (rangeSnapshot[0] || rangeSnapshot[1])) {
    lines.push(`时间范围: ${rangeSnapshot[0] || '-'} ~ ${rangeSnapshot[1] || '-'}`)
  }
  lines.push('')
  return lines.join('\n')
}

// 分页拉取并增量拼装导出文本；原始页用完即丢弃
// 筛选条件在开始时冻结，避免导出中途改 dateRange 导致「内容旧、标题新」
const buildExportStreaming = async () => {
  const pageLimit = 100
  const rangeSnapshot = Array.isArray(dateRange.value)
    ? [dateRange.value[0] || null, dateRange.value[1] || null]
    : null
  const base = {
    // 不带 list 分页 offset/limit；导出自管
  }
  if (rangeSnapshot?.[0]) base.startTime = rangeSnapshot[0]
  if (rangeSnapshot?.[1]) base.endTime = rangeSnapshot[1]
  const parts = []
  let expected = null
  let count = 0
  let totalChars = 0
  let truncatedByCap = false
  let truncatedBySize = false
  let offset = 0

  // 占位头，最后用真实条数回填第一段
  parts.push('')
  totalChars = 0

  while (offset < EXPORT_ITEM_HARD_CAP) {
    const res = await httpApis.getAccountErrorHistoryApi(props.accountType, props.accountId, {
      ...base,
      offset,
      limit: pageLimit
    })
    if (!isOk(res)) {
      throw new Error(msgOf(res, '导出拉取失败'))
    }
    const payload = dataOf(res)
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.items)
        ? payload.items
        : []
    if (expected == null) {
      expected = Array.isArray(payload) ? items.length : Number(payload?.total) || items.length
    }
    if (!items.length) break

    for (const item of items) {
      const chunk = `---\n\n${buildItemText(slimItemForExport(item), count)}\n\n`
      if (totalChars + chunk.length > EXPORT_TOTAL_MAX) {
        truncatedBySize = true
        parts.push(
          `\n... [export stopped at ${EXPORT_TOTAL_MAX} chars to protect browser]\n`
        )
        break
      }
      parts.push(chunk)
      totalChars += chunk.length
      count += 1
      if (count >= EXPORT_ITEM_HARD_CAP) {
        truncatedByCap = true
        break
      }
    }
    if (truncatedBySize || truncatedByCap) break
    if (items.length < pageLimit) break
    if (count >= expected) break
    offset += pageLimit
  }

  const countLabel = truncatedByCap
    ? `筛选条件前 ${count} 条（已达导出上限 ${EXPORT_ITEM_HARD_CAP}）`
    : truncatedBySize
      ? `筛选条件前 ${count} 条（已达体积上限）`
      : `筛选条件下全部 ${count} 条`
  parts[0] = `${buildExportHeader({ countLabel, rangeSnapshot })}\n`
  return {
    text: parts.join(''),
    count,
    expected: expected || count,
    truncatedByCap,
    truncatedBySize
  }
}

const exporting = ref(false)

const copyItem = async (item, idx) => {
  await copyText(buildItemText(item, idx), `${idx}-item`)
}

const runExport = async (mode) => {
  if (exporting.value || clearing.value) return
  exporting.value = true
  try {
    const { text, count, expected, truncatedByCap, truncatedBySize } = await buildExportStreaming()
    if (mode === 'copy') {
      await navigator.clipboard.writeText(text)
    } else {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      const stamp = formatLocalDateTime(new Date(), 'YYYYMMDD-HHmmss') || 'export'
      anchor.href = url
      anchor.download = `error-history-${props.accountType}-${props.accountId}-${stamp}.txt`
      anchor.click()
      URL.revokeObjectURL(url)
    }
    const verb = mode === 'copy' ? '已复制' : '已下载'
    if (truncatedByCap || truncatedBySize) {
      showToast(
        `${verb} ${count}/${expected} 条（已截断${truncatedByCap ? '条数' : ''}${truncatedByCap && truncatedBySize ? '/' : ''}${truncatedBySize ? '体积' : ''}）`,
        'warning'
      )
    } else {
      showToast(`${verb}全部 ${count} 条`, 'success')
    }
  } catch (error) {
    console.error(error)
    showToast(error?.message || (mode === 'copy' ? '复制失败' : '下载失败'), 'error')
  } finally {
    exporting.value = false
  }
}

const handleCopyAll = () => runExport('copy')
const handleDownloadAll = () => runExport('download')

const copyText = async (text, key) => {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null
    }, 1500)
  } catch (error) {
    console.error(error)
  }
}

const statusClass = (status) => {
  if (status >= 500 || status === 529)
    return 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400'
  if (status === 429)
    return 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400'
  if (status === 401 || status === 403)
    return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400'
  return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
}

const dotClass = (status) => {
  if (status >= 500 || status === 529) return 'bg-red-500'
  if (status === 429) return 'bg-orange-500'
  if (status === 401 || status === 403) return 'bg-yellow-500'
  return 'bg-gray-400'
}
</script>
