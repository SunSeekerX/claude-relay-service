<template>
  <div
    class="flex min-h-0 flex-col overflow-hidden"
    :class="embedded ? 'h-full' : 'h-full'"
  >
    <!-- 顶栏：可选返回 + 账户信息 + 汇总 -->
    <div class="mb-2 flex shrink-0 flex-col gap-2">
      <div v-if="showHeader" class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <button
            v-if="showBack"
            class="shrink-0 whitespace-nowrap rounded-full border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            type="button"
            @click="emit('back')"
          >
            ← 返回
          </button>
          <div class="min-w-0">
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h2 class="truncate text-base font-bold text-gray-900 dark:text-gray-100 sm:text-lg">
                {{ accountDisplayName }}
              </h2>
              <span class="text-sm text-gray-500 dark:text-gray-400">{{ platformDisplayName }}</span>
            </div>
            <p class="truncate text-sm text-gray-500 dark:text-gray-400">
              ID: {{ accountId }}
              <template v-if="dateRangeHint"> · {{ dateRangeHint }}</template>
              <template v-else> · 近 5000 条</template>
            </p>
          </div>
        </div>
      </div>

      <!-- 汇总：一行徽章 -->
      <div
        class="rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm dark:border-gray-700 dark:bg-gray-900"
      >
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
          <span class="inline-flex items-center gap-1 whitespace-nowrap">
            <span>总请求:</span>
            <span class="font-semibold text-gray-900 dark:text-gray-100">{{
              formatNumber(summary.totalRequests)
            }}</span>
          </span>
          <span class="inline-flex items-center gap-1 whitespace-nowrap">
            <span>总 Token:</span>
            <span class="font-semibold text-gray-900 dark:text-gray-100">{{
              formatNumber(summary.totalTokens)
            }}</span>
          </span>
          <span class="inline-flex items-center gap-1 whitespace-nowrap">
            <span>总费用:</span>
            <span class="font-semibold text-yellow-600 dark:text-yellow-400">{{
              formatCost(summary.totalCost)
            }}</span>
          </span>
          <span class="inline-flex items-center gap-1 whitespace-nowrap">
            <span>平均/次:</span>
            <span class="font-semibold text-gray-900 dark:text-gray-100">{{
              formatCost(summary.avgCost)
            }}</span>
          </span>
        </div>
      </div>

      <!-- 筛选工具条 -->
      <div
        class="rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm dark:border-gray-700 dark:bg-gray-900"
      >
        <div class="flex flex-wrap items-center gap-2">
          <AppDateRangePicker
            v-model="filters.dateRange"
            class="w-full min-w-0 sm:max-w-md"
            clearable
            presets="filter"
          />

          <div class="w-[160px]">
            <CustomDropdown
              v-model="filters.model"
              accent="blue"
              clearable
              icon="i-lucide-box"
              :options="modelDropdownOptions"
              placeholder="所有模型"
              searchable
            />
          </div>

          <div class="w-[200px]">
            <CustomDropdown
              v-model="filters.apiKeyId"
              accent="purple"
              clearable
              icon="i-lucide-key"
              :options="apiKeyDropdownOptions"
              placeholder="所有 API Key"
              searchable
            />
          </div>

          <div class="w-[130px]">
            <CustomDropdown
              v-model="filters.sortOrder"
              accent="indigo"
              icon="i-lucide-arrow-down-wide-narrow"
              :options="sortOrderOptions"
              placeholder="排序"
            />
          </div>

          <button
            class="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            type="button"
            @click="resetFilters"
          >
            <i class="i-lucide-undo-2 mr-1" />重置
          </button>
          <button
            class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="exporting"
            type="button"
            @click="exportCsv"
          >
            <i
              :class="[
                'mr-1',
                exporting ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-file-output'
              ]"
            />导出 CSV
          </button>
        </div>
      </div>
    </div>

    <!-- 表格区：内部滚动 -->
    <div
      class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900"
    >
      <div
        v-if="loading"
        class="flex flex-1 items-center justify-center p-10 text-gray-500 dark:text-gray-400"
      >
        <i class="i-lucide-loader-circle mr-2 animate-spin" /> 加载中...
      </div>
      <div
        v-else-if="records.length === 0"
        class="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-gray-500 dark:text-gray-400"
      >
        <i class="i-lucide-inbox text-2xl" />
        <p>暂无记录</p>
      </div>
      <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="usage-table-scroll hidden min-h-0 flex-1 md:block" :class="tableBodyClass">
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
            <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-gray-800">
              <tr>
                <th
                  class="px-3 py-2 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  时间
                </th>
                <th
                  class="px-3 py-2 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  API Key
                </th>
                <th
                  class="px-3 py-2 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  模型
                </th>
                <th
                  class="px-3 py-2 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  档位
                </th>
                <th
                  class="px-3 py-2 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  输入
                </th>
                <th
                  class="px-3 py-2 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  输出
                </th>
                <th
                  class="px-3 py-2 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  缓存(创/读)
                </th>
                <th
                  class="px-3 py-2 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  命中率
                </th>
                <th
                  class="px-3 py-2 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  总 Token
                </th>
                <th
                  class="px-3 py-2 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  费用
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 bg-white dark:divide-gray-800 dark:bg-gray-900">
              <tr
                v-for="record in records"
                :key="record.timestamp + record.model + (record.requestId || '')"
              >
                <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-800 dark:text-gray-100">
                  {{ formatDate(record.timestamp) }}
                </td>
                <td class="max-w-[160px] truncate px-3 py-2 text-sm font-medium text-gray-800 dark:text-gray-100">
                  {{ record.apiKeyName || record.apiKeyId || '未知 Key' }}
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-800 dark:text-gray-100">
                  {{ record.model }}
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm">
                  <span
                    v-if="formatServiceTier(record.serviceTier)"
                    class="inline-flex rounded-full px-2 py-0.5 text-sm font-medium"
                    :class="serviceTierClass(record.serviceTier)"
                  >
                    {{ formatServiceTier(record.serviceTier) }}
                  </span>
                  <span v-else class="text-gray-400">-</span>
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm text-blue-600 dark:text-blue-400">
                  {{ formatNumber(record.inputTokens) }}
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm text-green-600 dark:text-green-400">
                  {{ formatNumber(record.outputTokens) }}
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm text-purple-600 dark:text-purple-400">
                  {{ formatNumber(record.cacheCreateTokens) }} /
                  {{ formatNumber(record.cacheReadTokens) }}
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm text-cyan-600 dark:text-cyan-400">
                  {{ formatCacheHitRate(record) }}
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-800 dark:text-gray-100">
                  {{ formatNumber(record.totalTokens) }}
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm text-yellow-600 dark:text-yellow-400">
                  {{ record.costFormatted || formatCost(record.cost) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 md:hidden" :class="tableBodyClass">
          <div
            v-for="record in records"
            :key="record.timestamp + record.model + (record.requestId || '')"
            class="rounded-lg border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900"
          >
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                {{ record.apiKeyName || record.apiKeyId || '未知 Key' }}
              </p>
              <p class="text-sm text-gray-500 dark:text-gray-400">
                {{ formatDate(record.timestamp) }}
              </p>
            </div>
            <div class="mt-2 grid grid-cols-2 gap-1.5 text-sm text-gray-700 dark:text-gray-300">
              <div class="truncate">模型：{{ record.model }}</div>
              <div>
                档位：
                <span
                  v-if="formatServiceTier(record.serviceTier)"
                  :class="serviceTierClass(record.serviceTier)"
                >
                  {{ formatServiceTier(record.serviceTier) }}
                </span>
                <span v-else>-</span>
              </div>
              <div>总 Token：{{ formatNumber(record.totalTokens) }}</div>
              <div class="text-yellow-600 dark:text-yellow-400">
                费用：{{ record.costFormatted || formatCost(record.cost) }}
              </div>
              <div>输入：{{ formatNumber(record.inputTokens) }}</div>
              <div>输出：{{ formatNumber(record.outputTokens) }}</div>
              <div>
                缓存创/读：{{ formatNumber(record.cacheCreateTokens) }} /
                {{ formatNumber(record.cacheReadTokens) }}
              </div>
              <div class="text-cyan-600 dark:text-cyan-400">
                命中率：{{ formatCacheHitRate(record) }}
              </div>
            </div>
          </div>
        </div>

        <div class="shrink-0 border-t border-gray-200 px-3 py-2 dark:border-gray-800">
          <AppPagination
            v-model:current-page="pagination.currentPage"
            v-model:page-size="pagination.pageSize"
            :page-sizes="[20, 50, 100, 200]"
            :total="pagination.totalRecords"
            @current-change="handlePageChange"
            @size-change="handleSizeChange"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { getAccountUsageRecordsByIdApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast, formatNumber, formatDate } from '@/libs/tools'
import AppDateRangePicker from '@/components/common/app_date_range_picker.vue'
import AppPagination from '@/components/common/app_pagination.vue'

const props = defineProps({
  accountId: {
    type: String,
    required: true
  },
  accountName: {
    type: String,
    default: ''
  },
  platform: {
    type: String,
    default: ''
  },
  fetchApi: {
    type: Function,
    default: null
  },
  showHeader: {
    type: Boolean,
    default: true
  },
  showBack: {
    type: Boolean,
    default: false
  },
  // dialog 内嵌时 true，仅语义标记
  embedded: {
    type: Boolean,
    default: false
  },
  tableBodyClass: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['back'])

const resolveFetchApi = () => props.fetchApi || getAccountUsageRecordsByIdApi

const loading = ref(false)
const exporting = ref(false)
const records = ref([])
const availableModels = ref([])
const availableApiKeys = ref([])

const modelDropdownOptions = computed(() =>
  availableModels.value.map((model) => ({ value: model, label: model }))
)
const apiKeyDropdownOptions = computed(() =>
  availableApiKeys.value.map((apiKey) => ({
    value: apiKey.id,
    label: apiKey.name || apiKey.id
  }))
)
const sortOrderOptions = [
  { value: 'desc', label: '时间降序' },
  { value: 'asc', label: '时间升序' }
]

const pagination = reactive({
  currentPage: 1,
  pageSize: 50,
  totalRecords: 0
})

const filters = reactive({
  dateRange: null,
  model: '',
  apiKeyId: '',
  sortOrder: 'desc'
})

const summary = reactive({
  totalRequests: 0,
  totalTokens: 0,
  totalCost: 0,
  avgCost: 0
})

const accountInfo = reactive({
  id: props.accountId,
  name: props.accountName || '',
  platform: props.platform || ''
})

const accountDisplayName = computed(
  () => accountInfo.name || props.accountName || accountInfo.id || props.accountId
)
const platformDisplayName = computed(() => {
  const map = {
    claude: 'Claude官方',
    'claude-console': 'Claude Console',
    ccr: 'Claude Console Relay',
    openai: 'OpenAI',
    'openai-responses': 'OpenAI Responses',
    'azure-openai': 'Azure OpenAI',
    azure_openai: 'Azure OpenAI',
    gemini: 'Gemini',
    'gemini-api': 'Gemini API',
    'gemini-antigravity': 'Gemini Antigravity',
    droid: 'Droid',
    bedrock: 'AWS Bedrock',
    grok: 'Grok',
    unknown: '未知渠道'
  }
  const key = accountInfo.platform || props.platform || 'unknown'
  return map[key] || '未知渠道'
})

const dateRangeHint = computed(() => {
  if (!filters.dateRange || filters.dateRange.length !== 2) return ''
  return `${formatDate(filters.dateRange[0])} ~ ${formatDate(filters.dateRange[1])}`
})

const formatCost = (value) => {
  const num = typeof value === 'number' ? value : 0
  if (num >= 1) return `$${num.toFixed(2)}`
  if (num >= 0.001) return `$${num.toFixed(4)}`
  return `$${num.toFixed(6)}`
}

// OpenAI service_tier 展示：fast/priority 同属溢价档，ultrafast/flex 单独标
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

// 缓存命中率：cacheRead / (input + cacheRead + cacheCreate)，与请求明细一致
const formatCacheHitRate = (record) => {
  if (!record || typeof record !== 'object') return '-'
  if (typeof record.cacheHitRate === 'number' && Number.isFinite(record.cacheHitRate)) {
    return `${Number(record.cacheHitRate).toFixed(2)}%`
  }
  const inputTokens = Number(record.inputTokens) || 0
  const cacheReadTokens = Number(record.cacheReadTokens) || 0
  const cacheCreateTokens = Number(record.cacheCreateTokens) || 0
  const denominator = inputTokens + cacheReadTokens + cacheCreateTokens
  if (denominator <= 0) return '-'
  return `${((cacheReadTokens / denominator) * 100).toFixed(2)}%`
}

const buildParams = (page) => {
  const params = {
    page,
    pageSize: pagination.pageSize,
    sortOrder: filters.sortOrder
  }

  if (filters.model) params.model = filters.model
  if (filters.apiKeyId) params.apiKeyId = filters.apiKeyId
  if (filters.dateRange && filters.dateRange.length === 2) {
    // 传本地时间字符串，由后端按系统配置时区解析（禁止 toISOString 当成 UTC）
    params.startDate = filters.dateRange[0]
    params.endDate = filters.dateRange[1]
  }
  const platformValue = props.platform || accountInfo.platform
  if (platformValue) {
    params.platform = platformValue
  }

  return params
}

const syncResponseState = (data) => {
  records.value = data.records || []

  const pageInfo = data.pagination || {}
  pagination.currentPage = pageInfo.currentPage || 1
  pagination.pageSize = pageInfo.pageSize || pagination.pageSize
  pagination.totalRecords = pageInfo.totalRecords || 0

  const filterEcho = data.filters || {}
  if (filterEcho.model !== undefined) filters.model = filterEcho.model || ''
  if (filterEcho.apiKeyId !== undefined) filters.apiKeyId = filterEcho.apiKeyId || ''
  if (filterEcho.sortOrder) filters.sortOrder = filterEcho.sortOrder
  if (filterEcho.startDate && filterEcho.endDate) {
    const nextRange = [filterEcho.startDate, filterEcho.endDate]
    const currentRange = filters.dateRange || []
    if (currentRange[0] !== nextRange[0] || currentRange[1] !== nextRange[1]) {
      filters.dateRange = nextRange
    }
  }

  const summaryData = data.summary || {}
  summary.totalRequests = summaryData.totalRequests || 0
  summary.totalTokens = summaryData.totalTokens || 0
  summary.totalCost = summaryData.totalCost || 0
  summary.avgCost = summaryData.avgCost || 0

  accountInfo.id = data.accountInfo?.id || props.accountId
  accountInfo.name = data.accountInfo?.name || props.accountName || ''
  accountInfo.platform = data.accountInfo?.platform || props.platform || ''

  availableModels.value = data.availableFilters?.models || []
  availableApiKeys.value = data.availableFilters?.apiKeys || []
}

const fetchRecords = async (page = pagination.currentPage) => {
  if (!props.accountId) return
  loading.value = true
  // request.js 为 resolve-only：失败也 resolve，不会抛异常，必须显式判 isOk
  const response = await resolveFetchApi()(props.accountId, buildParams(page))
  if (!isOk(response)) {
    showToast(`加载请求记录失败：${msgOf(response, '未知错误')}`, 'error')
    loading.value = false
    return
  }
  syncResponseState(response.data || {})
  loading.value = false
}

const handlePageChange = (page) => {
  pagination.currentPage = page
  fetchRecords(page)
}

const handleSizeChange = (size) => {
  pagination.pageSize = size
  pagination.currentPage = 1
  fetchRecords(1)
}

const resetFilters = () => {
  filters.model = ''
  filters.apiKeyId = ''
  filters.dateRange = null
  filters.sortOrder = 'desc'
  pagination.currentPage = 1
  fetchRecords(1)
}

const exportCsv = async () => {
  if (exporting.value || !props.accountId) return
  exporting.value = true
  try {
    const aggregated = []
    let page = 1
    let totalPages = 1
    const maxPages = 50

    while (page <= totalPages && page <= maxPages) {
      const response = await resolveFetchApi()(props.accountId, {
        ...buildParams(page),
        pageSize: 200
      })
      if (!isOk(response)) {
        showToast(`导出失败：${msgOf(response, '未知错误')}`, 'error')
        return
      }
      const payload = response.data || {}
      aggregated.push(...(payload.records || []))
      totalPages = payload.pagination?.totalPages || 1
      page += 1
    }

    if (aggregated.length === 0) {
      showToast('没有可导出的记录', 'info')
      return
    }

    const headers = [
      '时间',
      'API Key',
      '模型',
      '档位',
      '输入Token',
      '输出Token',
      '缓存创建Token',
      '缓存读取Token',
      '缓存命中率',
      '总Token',
      '费用'
    ]

    const csvRows = [headers.join(',')]
    aggregated.forEach((record) => {
      const row = [
        formatDate(record.timestamp),
        record.apiKeyName || record.apiKeyId || '',
        record.model || '',
        formatServiceTier(record.serviceTier) || record.serviceTier || '',
        record.inputTokens || 0,
        record.outputTokens || 0,
        record.cacheCreateTokens || 0,
        record.cacheReadTokens || 0,
        formatCacheHitRate(record),
        record.totalTokens || 0,
        record.costFormatted || formatCost(record.cost)
      ]
      csvRows.push(row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    })

    const blob = new Blob([csvRows.join('\n')], {
      type: 'text/csv;charset=utf-8;'
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `account-${props.accountId}-usage-records.csv`
    link.click()
    URL.revokeObjectURL(url)
    showToast('导出 CSV 成功', 'success')
  } catch (error) {
    showToast(`导出失败：${error.message || '未知错误'}`, 'error')
  } finally {
    exporting.value = false
  }
}

watch(
  () => [filters.model, filters.apiKeyId, filters.sortOrder],
  () => {
    pagination.currentPage = 1
    fetchRecords(1)
  }
)

watch(
  () => filters.dateRange,
  () => {
    pagination.currentPage = 1
    fetchRecords(1)
  },
  { deep: true }
)

watch(
  () => [props.accountId, props.platform],
  () => {
    filters.model = ''
    filters.apiKeyId = ''
    filters.dateRange = null
    filters.sortOrder = 'desc'
    pagination.currentPage = 1
    accountInfo.id = props.accountId
    accountInfo.name = props.accountName || ''
    accountInfo.platform = props.platform || ''
    fetchRecords(1)
  }
)

onMounted(() => {
  fetchRecords()
})
</script>

<style scoped>
.usage-table-scroll {
  overflow: auto;
  min-height: 0;
}

.usage-table-scroll thead th {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgb(249 250 251);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.06);
}

:global(.dark) .usage-table-scroll thead th,
.dark .usage-table-scroll thead th {
  background: rgb(31 41 55);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.06);
}
</style>
