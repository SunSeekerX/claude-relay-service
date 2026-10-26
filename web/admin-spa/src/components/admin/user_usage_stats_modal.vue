<template>
  <AppDialog
    icon="i-lucide-chart-column"
    :model-value="show"
    size="xl"
    :title="`用户使用统计 · ${user?.displayName || user?.username || ''}`"
    @close="emit('close')"
  >
    <div class="mb-3 flex flex-wrap items-center gap-3">
      <span class="text-sm t-text-secondary">统计范围</span>
      <div class="w-44">
        <CustomDropdown
          v-model="selectedPeriod"
          :options="periodOptions"
          placeholder="选择时间范围"
          size="sm"
          @change="loadUsageStats"
        />
      </div>
      <span class="text-sm t-text-secondary">@{{ user?.username }}</span>
    </div>
    <div v-if="loading" class="admin-empty-state">
      <i class="i-lucide-loader-circle animate-spin" />正在加载统计...
    </div>
    <template v-else>
      <div class="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="stat-card">
          <p class="text-sm t-text-secondary">请求数</p>
          <strong>{{ formatNumber(usageStats?.totalRequests ?? 0) }}</strong>
        </div>
        <div class="stat-card">
          <p class="text-sm text-green-600 dark:text-green-400">输入 Token</p>
          <strong>{{ formatNumber(usageStats?.totalInputTokens ?? 0) }}</strong>
        </div>
        <div class="stat-card">
          <p class="text-sm text-blue-600 dark:text-blue-400">输出 Token</p>
          <strong>{{ formatNumber(usageStats?.totalOutputTokens ?? 0) }}</strong>
        </div>
        <div class="stat-card">
          <p class="text-sm t-text-secondary">费用</p>
          <strong>${{ (usageStats?.totalCost ?? 0).toFixed(4) }}</strong>
        </div>
      </div>
      <h4 class="mb-2 text-sm font-semibold">用户 API Key</h4>
      <div class="admin-table-scroll">
        <table class="w-full min-w-[640px] text-sm">
          <thead>
            <tr>
              <th>名称</th>
              <th>状态</th>
              <th class="text-right">请求数</th>
              <th class="text-right">输入 / 输出 Token</th>
              <th class="text-right">费用</th>
              <th>最近使用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="apiKey in userDetails?.apiKeys ?? []" :key="apiKey.id">
              <td>
                <strong>{{ apiKey.name }}</strong>
                <p class="mt-1 t-text-secondary">{{ apiKey.keyPreview }}</p>
              </td>
              <td
                :class="
                  apiKey.isActive
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                "
              >
                {{ apiKey.isActive ? '启用' : '停用' }}
              </td>
              <td class="text-right">{{ formatNumber(apiKey.usage?.requests ?? 0) }}</td>
              <td class="text-right">
                <span class="text-green-600 dark:text-green-400">{{
                  formatNumber(apiKey.usage?.inputTokens ?? 0)
                }}</span>
                /
                <span class="text-blue-600 dark:text-blue-400">{{
                  formatNumber(apiKey.usage?.outputTokens ?? 0)
                }}</span>
              </td>
              <td class="text-right">${{ (apiKey.usage?.totalCost ?? 0).toFixed(4) }}</td>
              <td>{{ apiKey.lastUsedAt ? formatDate(apiKey.lastUsedAt) : '从未使用' }}</td>
            </tr>
            <tr v-if="!userDetails?.apiKeys?.length">
              <td class="admin-empty-state" colspan="6">该用户暂无 API Key</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <template #footer
      ><button class="btn btn-secondary ml-auto" type="button" @click="emit('close')">
        关闭
      </button></template
    >
  </AppDialog>
</template>

<script setup>
import { ref, watch } from 'vue'

import AppDialog from '@/components/common/app_dialog.vue'
import CustomDropdown from '@/components/common/custom_dropdown.vue'
import { getFrontUserUsageStatsApi, getFrontUserByIdApi } from '@/libs/http_apis'
import { isOk, dataOf } from '@/libs/http_envelope'
import { showToast, formatNumber, formatDate } from '@/libs/tools'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  user: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['close'])

const loading = ref(false)
const selectedPeriod = ref('week')
const periodOptions = [
  { value: 'day', label: '最近 24 小时' },
  { value: 'week', label: '最近 7 天' },
  { value: 'month', label: '最近 30 天' },
  { value: 'quarter', label: '最近 90 天' }
]
const usageStats = ref(null)
const userDetails = ref(null)

const loadUsageStats = async () => {
  if (!props.user) return

  loading.value = true
  try {
    const [statsResponse, userResponse] = await Promise.all([
      getFrontUserUsageStatsApi(props.user.id, { period: selectedPeriod.value }),
      getFrontUserByIdApi(props.user.id)
    ])

    if (isOk(statsResponse)) {
      usageStats.value = dataOf(statsResponse)?.stats
    }

    if (isOk(userResponse)) {
      userDetails.value = dataOf(userResponse)?.user
    }
  } catch (error) {
    console.error('Failed to load user usage stats:', error)
    showToast('加载使用统计失败', 'error')
  } finally {
    loading.value = false
  }
}

// Watch for when modal is shown and user changes
watch([() => props.show, () => props.user], ([show, user]) => {
  if (show && user) {
    loadUsageStats()
  }
})
</script>
<style scoped>
.stat-card strong {
  display: block;
  margin-top: 5px;
  font-size: 20px;
  font-weight: 600;
}
</style>
