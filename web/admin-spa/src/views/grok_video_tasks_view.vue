<template>
  <div class="video-tasks-page admin-list-page flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
    <div class="admin-section-heading">
      <div>
        <h2>视频任务</h2>
        <p class="mt-1 text-sm t-text-secondary">查看生成状态、任务归属及预占与实际费用。</p>
      </div>
      <div class="admin-actions">
        <button class="btn btn-secondary" :disabled="loading" type="button" @click="refreshTasks">
          <i :class="loading ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw'" />刷新
        </button>
      </div>
    </div>
    <div class="admin-toolbar">
      <div class="admin-filter-group">
        <div class="w-40">
          <label class="mb-1 block text-sm t-text-secondary">状态</label
          ><CustomDropdown
            v-model="filters.status"
            :options="statusOptions"
            placeholder="全部状态"
            size="sm"
          />
        </div>
        <label class="min-w-0 flex-1"
          ><span class="mb-1 block text-sm t-text-secondary">API Key ID</span
          ><input
            v-model.trim="filters.apiKeyId"
            class="form-input w-full"
            placeholder="可选，粘贴 ID 后回车查询"
            @keyup.enter="loadTasks"
        /></label>
        <div class="w-32">
          <label class="mb-1 block text-sm t-text-secondary">每页</label
          ><CustomDropdown v-model="filters.limit" :options="limitOptions" size="sm" />
        </div>
      </div>
      <div class="admin-actions">
        <button class="btn btn-secondary" :disabled="loading" type="button" @click="loadTasks">
          查询</button
        ><button class="btn btn-secondary" type="button" @click="resetFilters">重置筛选</button>
      </div>
    </div>
    <div class="admin-table-scroll min-h-0">
      <table class="video-task-table w-full min-w-[900px] text-left text-sm">
        <thead>
          <tr>
            <th>任务 / API Key</th>
            <th>模型 / 账户</th>
            <th>状态</th>
            <th class="text-right">时长</th>
            <th class="text-right">费用</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td class="admin-empty-state" colspan="6">
              <i class="i-lucide-loader-circle animate-spin" />正在加载任务...
            </td>
          </tr>
          <tr v-else-if="!tasks.length">
            <td class="admin-empty-state" colspan="6">
              暂无匹配的视频任务，请调整筛选条件或稍后刷新
            </td>
          </tr>
          <tr v-for="task in tasks" v-else :key="task.apiKeyId + ':' + task.requestId">
            <td>
              <button
                class="task-copy"
                :title="`复制任务 ID：${task.requestId}`"
                type="button"
                @click="copyText(task.requestId, '任务 ID 已复制')"
              >
                {{ task.requestId }}
              </button>
              <p class="mt-1 font-medium">{{ keyLabel(task) }}</p>
              <button
                class="task-secondary-copy"
                :title="`复制 Key ID：${task.apiKeyId}`"
                type="button"
                @click="copyText(task.apiKeyId, 'Key ID 已复制')"
              >
                Key {{ shortId(task.apiKeyId) }}
              </button>
            </td>
            <td>
              <p class="font-medium">{{ task.model || '-' }}</p>
              <p class="mt-1 t-text-secondary">{{ accountLabel(task) }}</p>
              <button
                class="task-secondary-copy"
                :disabled="!task.accountId"
                :title="task.accountId ? `复制账户 ID：${task.accountId}` : ''"
                type="button"
                @click="copyText(task.accountId, '账户 ID 已复制')"
              >
                {{ task.accountId ? `ID ${shortId(task.accountId)}` : '无关联账户' }}
              </button>
            </td>
            <td>
              <span class="task-status" :class="statusClass(task.status)">{{
                statusLabel(task.status)
              }}</span>
            </td>
            <td class="text-right">{{ durationLabel(task) }}</td>
            <td class="text-right">
              <p class="text-amber-700 dark:text-amber-300">
                预占 ${{ formatCost(task.reservedCost) }}
              </p>
              <p class="mt-1 text-green-700 dark:text-green-300">
                实际 ${{ formatCost(task.actualCost) }}
              </p>
            </td>
            <td class="t-text-secondary">
              {{ task.createdAt ? formatDateTime(task.createdAt) : '-' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <span class="admin-result-count">当前显示 {{ tasks.length }} 个任务</span>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import CustomDropdown from '@/components/common/custom_dropdown.vue'
import { getGrokVideoTasksApi, getApiKeysWithParamsApi, getGrokAccountsApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast, copyText, formatDateTime } from '@/libs/tools'

const tasks = ref([])
const loading = ref(false)
const keyNames = ref({})
const accountNames = ref({})
const filters = reactive({ status: '', apiKeyId: '', limit: 50 })
const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'processing', label: '处理中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' }
]
const limitOptions = [20, 50, 100, 200].map((value) => ({ value, label: `${value} / 页` }))
const formatCost = (value) => Number(value ?? 0).toFixed(4)
const statusLabel = (value) =>
  ({
    pending: '待处理',
    processing: '处理中',
    completed: '已完成',
    failed: '失败',
    expired: '已过期',
    cancelled: '已取消'
  })[value] ??
  value ??
  '未知'
const statusClass = (value) =>
  ({
    processing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    completed: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
  })[value] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
const shortId = (value) =>
  value && value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value
const keyLabel = (task) => task.apiKeyName || keyNames.value[task.apiKeyId] || 'Key 名称不可用'
const accountLabel = (task) =>
  task.accountName || accountNames.value[task.accountId] || '账户名称不可用'
const durationLabel = (task) => {
  if (
    task.actualDuration !== null &&
    task.actualDuration !== undefined &&
    task.actualDuration !== ''
  )
    return `${task.actualDuration} 秒`
  if (
    task.reservedDuration !== null &&
    task.reservedDuration !== undefined &&
    task.reservedDuration !== ''
  )
    return `预估 ${task.reservedDuration} 秒`
  return '-'
}
const loadReferenceNames = async () => {
  const [keys, accounts] = await Promise.all([
    getApiKeysWithParamsApi('page=1&pageSize=100'),
    getGrokAccountsApi()
  ])
  if (isOk(keys))
    keyNames.value = Object.fromEntries(keys.data.items.map((key) => [key.id, key.name]))
  if (isOk(accounts))
    accountNames.value = Object.fromEntries(
      accounts.data.map((account) => [account.id, account.name])
    )
}
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
const refreshTasks = () => Promise.all([loadTasks(), loadReferenceNames()])
const resetFilters = () => {
  filters.apiKeyId = ''
  if (filters.status) filters.status = ''
  else loadTasks()
}
watch(() => [filters.status, filters.limit], loadTasks)
onMounted(refreshTasks)
</script>

<style scoped>
.task-copy,
.task-secondary-copy {
  display: block;
  max-width: 250px;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
  font-size: 14px;
}
.task-copy {
  color: var(--text-primary);
  font-weight: 500;
}
.task-secondary-copy {
  color: var(--text-secondary);
  margin-top: 3px;
}
.task-copy:hover,
.task-secondary-copy:hover {
  color: var(--primary-color);
}
.task-status {
  display: inline-flex;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  white-space: nowrap;
}
.video-task-table tbody tr {
  border-bottom: 1px solid var(--divider-color);
}
</style>
