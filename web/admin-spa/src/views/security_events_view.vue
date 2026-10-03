<template>
  <div class="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
    <div class="flex justify-end">
      <button
        class="btn btn-primary inline-flex h-9 items-center gap-2 px-3 text-sm"
        :disabled="loading"
        type="button"
        @click="load"
      >
        <i :class="loading ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw'" />
        刷新
      </button>
    </div>

    <div
      class="min-h-0 flex-1 overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900"
    >
      <table class="w-full min-w-[650px] text-left text-sm">
        <thead class="bg-gray-50 text-gray-600 dark:bg-gray-800/80 dark:text-gray-300">
          <tr>
            <th class="px-3 py-2 font-medium">时间</th>
            <th class="px-3 py-2 font-medium">来源 IP</th>
            <th class="px-3 py-2 font-medium">对端地址</th>
            <th class="px-3 py-2 font-medium">结果</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
          <tr v-if="!loading && !events.length">
            <td class="px-3 py-10 text-center text-gray-500 dark:text-gray-400" colspan="4">
              暂无事件
            </td>
          </tr>
          <tr v-for="(event, index) in events" :key="event.at + '-' + index">
            <td class="px-3 py-2 text-gray-500">{{ formatDate(event.at) }}</td>
            <td class="px-3 py-2 font-mono text-gray-800 dark:text-gray-200">{{ event.ip }}</td>
            <td class="px-3 py-2 font-mono text-gray-800 dark:text-gray-200">{{ event.peer }}</td>
            <td class="px-3 py-2">
              <span
                :class="
                  event.blocked
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-amber-600 dark:text-amber-400'
                "
                >{{ event.blocked ? '已限速' : '尝试' }}</span
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AppPagination
      v-model:current-page="pagination.currentPage"
      v-model:page-size="pagination.pageSize"
      :page-sizes="[20, 50, 100, 200]"
      :total="pagination.totalRecords"
      @current-change="handlePageChange"
      @size-change="handleSizeChange"
    />
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import AppPagination from '@/components/common/app_pagination.vue'
import { getSecurityEventsApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast } from '@/libs/tools'

const events = ref([])
const loading = ref(false)
const pagination = reactive({
  currentPage: 1,
  pageSize: 50,
  totalRecords: 0,
})
const formatDate = (value) => (value ? new Date(value).toLocaleString() : '-')
const load = async (page = pagination.currentPage) => {
  loading.value = true
  try {
    const response = await getSecurityEventsApi({ page, pageSize: pagination.pageSize })
    if (!isOk(response)) throw new Error(msgOf(response, '加载安全事件失败'))
    const data = response.data || {}
    events.value = Array.isArray(data) ? data : data.records || []
    if (!Array.isArray(data)) {
      const pageInfo = data.pagination || {}
      pagination.currentPage = pageInfo.currentPage || 1
      pagination.pageSize = pageInfo.pageSize || pagination.pageSize
      pagination.totalRecords = pageInfo.totalRecords || 0
    } else {
      pagination.currentPage = 1
      pagination.totalRecords = events.value.length
    }
  } catch (error) {
    showToast(error.message || '加载安全事件失败', 'error')
  } finally {
    loading.value = false
  }
}

const handlePageChange = (page) => load(page)

const handleSizeChange = (size) => {
  pagination.pageSize = size
  pagination.currentPage = 1
  load(1)
}

onMounted(load)
</script>
