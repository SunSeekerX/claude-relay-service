<template>
  <div class="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-gray-900 dark:text-gray-100">Grok 视频任务</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          查看异步生成状态、任务归属和预占/实际结算费用。
        </p>
      </div>
      <button
        class="btn btn-primary inline-flex h-9 items-center gap-2 px-3 text-sm"
        :disabled="loading"
        type="button"
        @click="loadTasks"
      >
        <i :class="loading ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw'" />
        刷新
      </button>
    </div>

    <div
      class="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-900"
    >
      <div class="w-full sm:w-44">
        <label class="mb-1 block text-sm text-gray-600 dark:text-gray-300">状态</label>
        <CustomDropdown
          v-model="filters.status"
          accent="blue"
          :glow="false"
          :options="statusOptions"
          placeholder="全部状态"
          size="sm"
        />
      </div>
      <label class="w-full sm:w-72">
        <span class="mb-1 block text-sm text-gray-600 dark:text-gray-300">API Key ID</span>
        <input v-model.trim="filters.apiKeyId" class="form-input w-full" placeholder="可选" />
      </label>
      <div class="w-full sm:w-36">
        <label class="mb-1 block text-sm text-gray-600 dark:text-gray-300">每页</label>
        <CustomDropdown
          v-model="filters.limit"
          accent="gray"
          :glow="false"
          :options="limitOptions"
          size="sm"
        />
      </div>
    </div>

    <div
      class="min-h-0 overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900"
    >
      <table class="w-full min-w-[900px] text-left text-sm">
        <thead class="bg-gray-50 text-gray-600 dark:bg-gray-800/80 dark:text-gray-300">
          <tr>
            <th class="px-3 py-2 font-medium">任务</th>
            <th class="px-3 py-2 font-medium">模型/账户</th>
            <th class="px-3 py-2 font-medium">状态</th>
            <th class="px-3 py-2 font-medium">时长</th>
            <th class="px-3 py-2 font-medium">费用</th>
            <th class="px-3 py-2 font-medium">创建时间</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
          <tr v-if="!loading && tasks.length === 0">
            <td colspan="6" class="px-3 py-10 text-center text-gray-500 dark:text-gray-400">
              暂无视频任务
            </td>
          </tr>
          <tr
            v-for="task in tasks"
            :key="task.apiKeyId + ':' + task.requestId"
            class="text-gray-800 dark:text-gray-200"
          >
            <td class="px-3 py-3">
              <div class="font-mono text-xs">{{ task.requestId }}</div>
              <div class="mt-1 text-xs text-gray-500">Key {{ task.apiKeyId }}</div>
            </td>
            <td class="px-3 py-3">
              <div>{{ task.model || '-' }}</div>
              <div class="text-xs text-gray-500">账户 {{ task.accountId || '-' }}</div>
            </td>
            <td class="px-3 py-3">
              <span class="rounded-full px-2 py-1 text-xs" :class="statusClass(task.status)">{{
                task.status || '-'
              }}</span>
            </td>
            <td class="px-3 py-3">{{ task.actualDuration || task.reservedDuration || '-' }} 秒</td>
            <td class="px-3 py-3">
              <div>预占 ${{ formatCost(task.reservedCost) }}</div>
              <div>实际 ${{ formatCost(task.actualCost) }}</div>
            </td>
            <td class="px-3 py-3 text-xs text-gray-500">{{ formatDate(task.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import CustomDropdown from '@/components/common/custom_dropdown.vue'
import { getGrokVideoTasksApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast } from '@/libs/tools'

const tasks = ref([])
const loading = ref(false)
const filters = reactive({ status: '', apiKeyId: '', limit: 50 })
const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'processing', label: '处理中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' }
]
const limitOptions = [20, 50, 100, 200].map((value) => ({ value, label: `${value} / 页` }))
const formatCost = (value) => Number(value || 0).toFixed(4)
const formatDate = (value) => (value ? new Date(value).toLocaleString() : '-')
const statusClass = (value) =>
  ({
    processing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    completed: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
  })[value] || 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'

const loadTasks = async () => {
  loading.value = true
  try {
    const response = await getGrokVideoTasksApi(filters)
    if (!isOk(response)) throw new Error(msgOf(response, '加载视频任务失败'))
    tasks.value = response.data?.records || []
  } catch (error) {
    showToast(error.message || '加载视频任务失败', 'error')
  } finally {
    loading.value = false
  }
}

watch(() => [filters.status, filters.apiKeyId, filters.limit], loadTasks)
onMounted(loadTasks)
</script>
