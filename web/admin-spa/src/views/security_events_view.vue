<template>
  <div class="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-gray-900 dark:text-gray-100">安全事件</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">最近管理员登录尝试和限速结果。</p>
      </div>
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
      class="overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900"
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
            <td colspan="4" class="px-3 py-10 text-center text-gray-500 dark:text-gray-400">
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
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { getSecurityEventsApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast } from '@/libs/tools'

const events = ref([])
const loading = ref(false)
const formatDate = (value) => (value ? new Date(value).toLocaleString() : '-')
const load = async () => {
  loading.value = true
  try {
    const response = await getSecurityEventsApi()
    if (!isOk(response)) throw new Error(msgOf(response, '加载安全事件失败'))
    events.value = response.data || []
  } catch (error) {
    showToast(error.message || '加载安全事件失败', 'error')
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>
