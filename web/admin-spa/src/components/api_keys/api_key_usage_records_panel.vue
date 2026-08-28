<template>
  <div
    class="flex min-h-0 flex-col gap-3"
    :class="showHeader ? 'p-3 sm:p-4' : 'h-full'"
  >
    <div v-if="showHeader" class="flex shrink-0 flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <button
          v-if="showBack"
          class="rounded-full border border-gray-200 px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          type="button"
          @click="emit('back')"
        >
          ← 返回
        </button>
        <div>
          <p class="text-sm font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
            {{ title }}
          </p>
          <h2 class="text-xl font-bold text-gray-900 dark:text-gray-100">
            {{ apiKeyDisplayName }}
          </h2>
          <p class="text-sm text-gray-500 dark:text-gray-400">ID: {{ keyId }}</p>
        </div>
      </div>
      <div class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <i class="i-lucide-clock text-blue-500" />
        <span v-if="dateRangeHint">{{ dateRangeHint }}</span>
        <span v-else>显示近 5000 条记录</span>
      </div>
    </div>

    <div
      class="shrink-0 rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-900"
    >
      <div
        class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-gray-600 dark:text-gray-400"
      >
        <span
          v-for="card in summaryCards"
          :key="card.key"
          class="inline-flex items-center gap-1 whitespace-nowrap"
        >
          <span>{{ card.label }}:</span>
          <span class="font-semibold" :class="card.valueClass">{{ card.value }}</span>
        </span>
      </div>
    </div>

    <!-- overflow-visible：日期面板不被卡片裁切 -->
    <div
      class="shrink-0 overflow-visible rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-900"
    >
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-start gap-3">
          <AppDateRangePicker
            v-model="filters.dateRange"
            class="w-full min-w-0 sm:max-w-xl"
            clearable
            presets="filter"
          />

          <div class="w-[180px]">
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

          <div v-if="shouldShowAccountFilter" class="w-[220px]">
            <CustomDropdown
              v-model="filters.accountId"
              accent="purple"
              clearable
              icon="i-lucide-server"
              :options="accountDropdownOptions"
              placeholder="所有账户"
              searchable
            />
          </div>

          <div class="w-[140px]">
            <CustomDropdown
              v-model="filters.sortOrder"
              accent="indigo"
              icon="i-lucide-arrow-down-wide-narrow"
              :options="sortOrderOptions"
              placeholder="排序"
            />
          </div>

          <button class="whitespace-nowrap rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200" type="button" @click="resetFilters"><i class="i-lucide-undo-2 mr-2" />重置</button>
          <button class="whitespace-nowrap rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" :disabled="exporting" type="button" @click="exportCsv"><i :class="['mr-2', exporting ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-file-output']" />导出 CSV</button>
        </div>
      </div>
    </div>

    <div
      class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900"
    >
      <div
        v-if="loading"
        class="flex flex-1 items-center justify-center p-10 text-gray-500 dark:text-gray-400"
      >
        <i class="i-lucide-loader-circle animate-spin mr-2" /> 加载中...
      </div>
      <div v-else class="flex min-h-0 flex-1 flex-col">
        <div
          v-if="records.length === 0"
          class="flex flex-col items-center gap-2 p-10 text-gray-500 dark:text-gray-400"
        >
          <i class="i-lucide-inbox text-2xl" />
          <p>暂无记录</p>
        </div>
        <div v-else class="flex min-h-0 flex-1 flex-col gap-4">
          <div class="hidden min-h-0 flex-1 overflow-auto md:block" :class="tableBodyClass">
            <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
              <thead class="sticky top-0 z-[1] bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th
                    class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                  >
                    时间
                  </th>
                  <th
                    v-if="showAccountColumn"
                    class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                  >
                    账户
                  </th>
                  <th
                    class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                  >
                    模型
                  </th>
                  <th
                    class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                  >
                    输入
                  </th>
                  <th
                    class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                  >
                    输出
                  </th>
                  <th
                    class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                  >
                    缓存写入
                  </th>
                  <th
                    class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                  >
                    缓存读取
                  </th>
                  <th
                    class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                  >
                    总 Token
                  </th>
                  <th
                    class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                  >
                    费用
                  </th>
                </tr>
              </thead>
              <tbody
                class="divide-y divide-gray-200 bg-white dark:divide-gray-800 dark:bg-gray-900"
              >
                <tr v-for="(record, index) in records" :key="buildRecordKey(record, index)">
                  <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-800 dark:text-gray-100">
                    {{ formatDate(record.timestamp) }}
                  </td>
                  <td
                    v-if="showAccountColumn"
                    class="px-4 py-3 text-sm text-gray-800 dark:text-gray-100"
                  >
                    <div class="flex flex-col">
                      <span class="font-semibold">{{ record.accountName || '未知账户' }}</span>
                      <span class="text-sm text-gray-500 dark:text-gray-400">
                        {{ record.accountTypeName || '未知渠道' }}
                      </span>
                    </div>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-800 dark:text-gray-100">
                    {{ record.model }}
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-sm text-blue-600 dark:text-blue-400">
                    {{ formatNumber(record.inputTokens) }}
                  </td>
                  <td
                    class="whitespace-nowrap px-4 py-3 text-sm text-green-600 dark:text-green-400"
                  >
                    {{ formatNumber(record.outputTokens) }}
                  </td>
                  <td
                    class="whitespace-nowrap px-4 py-3 text-sm text-purple-600 dark:text-purple-400"
                  >
                    {{ formatNumber(record.cacheCreateTokens) }}
                  </td>
                  <td
                    class="whitespace-nowrap px-4 py-3 text-sm text-orange-600 dark:text-orange-400"
                  >
                    {{ formatNumber(record.cacheReadTokens) }}
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-800 dark:text-gray-100">
                    {{ formatNumber(record.totalTokens) }}
                  </td>
                  <td
                    class="whitespace-nowrap px-4 py-3 text-sm text-yellow-600 dark:text-yellow-400"
                  >
                    {{ record.costFormatted || formatCost(record.cost) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="space-y-3 md:hidden" :class="tableBodyClass">
            <div
              v-for="(record, index) in records"
              :key="buildRecordKey(record, index)"
              class="rounded-lg border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-900"
            >
              <div>
                <p
                  v-if="showAccountColumn"
                  class="text-sm font-semibold text-gray-900 dark:text-gray-100"
                >
                  {{ record.accountName || '未知账户' }}
                </p>
                <p v-else class="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {{ record.model }}
                </p>
                <p class="text-sm text-gray-500 dark:text-gray-400">
                  {{ formatDate(record.timestamp) }}
                </p>
                <p v-if="showAccountColumn" class="text-sm text-gray-500 dark:text-gray-400">
                  {{ record.accountTypeName || '未知渠道' }} · {{ record.model }}
                </p>
              </div>
              <div class="mt-3 grid grid-cols-2 gap-2 text-sm text-gray-700 dark:text-gray-300">
                <div>输入：{{ formatNumber(record.inputTokens) }}</div>
                <div>输出：{{ formatNumber(record.outputTokens) }}</div>
                <div>缓存写入：{{ formatNumber(record.cacheCreateTokens) }}</div>
                <div>缓存读取：{{ formatNumber(record.cacheReadTokens) }}</div>
                <div>总 Token：{{ formatNumber(record.totalTokens) }}</div>
                <div class="text-yellow-600 dark:text-yellow-400">
                  费用：{{ record.costFormatted || formatCost(record.cost) }}
                </div>
              </div>
            </div>
          </div>

          <div class="px-4 pb-4">
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

  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { showToast, formatNumber, formatDate } from '@/libs/tools'
import { isOk, msgOf } from '@/libs/http_envelope'
import { buildDateRangePreset } from '@/libs/time.js'
import AppDateRangePicker from '@/components/common/app_date_range_picker.vue'
import AppPagination from '@/components/common/app_pagination.vue'

const props = defineProps({
  keyId: {
    type: String,
    required: true
  },
  apiKeyName: {
    type: String,
    default: ''
  },
  fetchApi: {
    type: Function,
    required: true
  },
  title: {
    type: String,
    default: 'API Key 请求详情时间线'
  },
  showHeader: {
    type: Boolean,
    default: true
  },
  showBack: {
    type: Boolean,
    default: false
  },
  showAccountColumn: {
    type: Boolean,
    default: true
  },
  showAccountFilter: {
    type: Boolean,
    default: true
  },
  tableBodyClass: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['back'])

const loading = ref(false)
const exporting = ref(false)
const records = ref([])
const availableModels = ref([])
const availableAccounts = ref([])

const modelDropdownOptions = computed(() =>
  availableModels.value.map((model) => ({ value: model, label: model }))
)
const accountDropdownOptions = computed(() =>
  availableAccounts.value.map((account) => ({
    value: account.id,
    label: `${account.name}（${account.accountTypeName}）`
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
  accountId: '',
  sortOrder: 'desc'
})
const summary = reactive({
  totalRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  totalCost: 0,
  avgCost: 0
})

const apiKeyInfo = reactive({
  id: props.keyId,
  name: props.apiKeyName
})


const apiKeyDisplayName = computed(() => apiKeyInfo.name || props.apiKeyName || props.keyId)
const shouldShowAccountFilter = computed(
  () => props.showAccountFilter && availableAccounts.value.length > 0
)
const dateRangeHint = computed(() => {
  if (!filters.dateRange || filters.dateRange.length !== 2) return ''
  return `${formatDate(filters.dateRange[0])} ~ ${formatDate(filters.dateRange[1])}`
})

const summaryCards = computed(() => [
  {
    key: 'requests',
    label: '总请求',
    value: formatNumber(summary.totalRequests),
    valueClass: 'text-gray-900 dark:text-gray-100'
  },
  {
    key: 'total_tokens',
    label: '总 Token',
    value: formatNumber(summary.totalTokens),
    valueClass: 'text-gray-900 dark:text-gray-100'
  },
  {
    key: 'input_tokens',
    label: '输入',
    value: formatNumber(summary.inputTokens),
    valueClass: 'text-blue-600 dark:text-blue-400'
  },
  {
    key: 'output_tokens',
    label: '输出',
    value: formatNumber(summary.outputTokens),
    valueClass: 'text-green-600 dark:text-green-400'
  },
  {
    key: 'cache_create_tokens',
    label: '缓存写入',
    value: formatNumber(summary.cacheCreateTokens),
    valueClass: 'text-purple-600 dark:text-purple-400'
  },
  {
    key: 'cache_read_tokens',
    label: '缓存读取',
    value: formatNumber(summary.cacheReadTokens),
    valueClass: 'text-orange-600 dark:text-orange-400'
  },
  {
    key: 'total_cost',
    label: '总费用',
    value: formatCost(summary.totalCost),
    valueClass: 'text-yellow-600 dark:text-yellow-400'
  },
  {
    key: 'avg_cost',
    label: '平均/次',
    value: formatCost(summary.avgCost),
    valueClass: 'text-gray-900 dark:text-gray-100'
  }
])

const formatCost = (value) => {
  const num = typeof value === 'number' ? value : 0
  if (num >= 1) return `$${num.toFixed(2)}`
  if (num >= 0.001) return `$${num.toFixed(4)}`
  return `$${num.toFixed(6)}`
}

const buildParams = (page) => {
  const params = {
    page,
    pageSize: pagination.pageSize,
    sortOrder: filters.sortOrder
  }

  if (filters.model) params.model = filters.model
  if (filters.accountId && props.showAccountFilter) params.accountId = filters.accountId
  if (filters.dateRange && filters.dateRange.length === 2) {
    // 直接透传 picker 的本地时间字符串（与 value-format 一致），避免重新格式化导致回显格式不符、触发二次请求
    params.startDate = filters.dateRange[0]
    params.endDate = filters.dateRange[1]
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
  if (filterEcho.accountId !== undefined && props.showAccountFilter) {
    filters.accountId = filterEcho.accountId || ''
  }
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
  summary.inputTokens = summaryData.inputTokens || 0
  summary.outputTokens = summaryData.outputTokens || 0
  summary.cacheCreateTokens = summaryData.cacheCreateTokens || 0
  summary.cacheReadTokens = summaryData.cacheReadTokens || 0
  summary.totalTokens = summaryData.totalTokens || 0
  summary.totalCost = summaryData.totalCost || 0
  summary.avgCost = summaryData.avgCost || 0

  apiKeyInfo.id = data.apiKeyInfo?.id || props.keyId
  apiKeyInfo.name = data.apiKeyInfo?.name || props.apiKeyName || ''

  availableModels.value = data.availableFilters?.models || []
  availableAccounts.value = data.availableFilters?.accounts || []
}

const fetchRecords = async (page = pagination.currentPage) => {
  if (!props.keyId) return

  loading.value = true
  // request.js 为 resolve-only：失败也 resolve，不会抛异常，必须显式判 isOk
  const response = await props.fetchApi(props.keyId, buildParams(page))
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
  filters.accountId = ''
  filters.sortOrder = 'desc'
  pagination.currentPage = 1
  filters.dateRange = buildDateRangePreset('24h')
}


const buildRecordKey = (record, index) => {
  return [
    record.timestamp || 'no-time',
    record.model || 'no-model',
    record.accountId || 'no-account',
    index
  ].join(':')
}

const exportCsv = async () => {
  if (exporting.value || !props.keyId) return

  exporting.value = true
  try {
    const aggregated = []
    let page = 1
    let totalPages = 1
    const maxPages = 50

    while (page <= totalPages && page <= maxPages) {
      const response = await props.fetchApi(props.keyId, {
        ...buildParams(page),
        pageSize: 200
      })
      // resolve-only：接口失败需中断导出并提示，否则会误导出空 CSV
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

    const headers = ['时间']
    if (props.showAccountColumn) {
      headers.push('账户', '渠道')
    }
    headers.push(
      '模型',
      '输入Token',
      '输出Token',
      '缓存创建Token',
      '缓存读取Token',
      '总Token',
      '费用'
    )

    const csvRows = [headers.join(',')]
    aggregated.forEach((record) => {
      const row = [formatDate(record.timestamp)]
      if (props.showAccountColumn) {
        row.push(record.accountName || '', record.accountTypeName || '')
      }
      row.push(
        record.model || '',
        record.inputTokens || 0,
        record.outputTokens || 0,
        record.cacheCreateTokens || 0,
        record.cacheReadTokens || 0,
        record.totalTokens || 0,
        record.costFormatted || formatCost(record.cost)
      )
      csvRows.push(row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    })

    const blob = new Blob([csvRows.join('\n')], {
      type: 'text/csv;charset=utf-8;'
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `api-key-${props.keyId}-usage-records.csv`
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
  () => [filters.model, filters.accountId, filters.sortOrder],
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
  () => props.keyId,
  (nextKeyId, prevKeyId) => {
    if (!nextKeyId || nextKeyId === prevKeyId) return
    pagination.currentPage = 1
    filters.model = ''
    filters.accountId = ''
    filters.sortOrder = 'desc'
    filters.dateRange = buildDateRangePreset('24h')
  }
)

onMounted(() => {
  filters.dateRange = buildDateRangePreset('24h')
})
</script>
