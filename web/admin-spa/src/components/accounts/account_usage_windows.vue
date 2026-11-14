<template>
  <div aria-label="账户窗口用量" class="space-y-2 text-sm">
    <div v-if="showQuota" class="space-y-2">
      <p class="font-medium text-gray-800 dark:text-gray-100">
        {{ quota?.planLabel || 'Grok' }}
        <span v-if="quota?.planSource === 'quota'" class="font-normal text-gray-500"
          >（按配额推测）</span
        >
      </p>
      <div v-for="window in quotaWindows" :key="window.key" class="space-y-1">
        <div class="flex flex-wrap items-center justify-between gap-1">
          <span class="text-gray-600 dark:text-gray-300">{{ window.label }}</span>
          <span class="tabular-nums text-gray-900 dark:text-gray-100">
            {{
              window.data?.used == null || !window.data?.limit
                ? '等待上游配额头'
                : `${formatNumber(window.data.used)} / ${formatNumber(window.data.limit)}`
            }}
          </span>
        </div>
        <div class="h-2 overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
          <div
            class="h-full bg-indigo-500"
            :style="{
              width: `${Math.min(100, Math.max(0, Number(window.data?.utilization) || 0))}%`
            }"
          />
        </div>
        <p v-if="window.data?.resetsAt" class="text-gray-500 dark:text-gray-400">
          {{ window.data.remainingSeconds === 0 ? '上次窗口已到重置时间' : '重置于' }}
          {{ formatLocalDateTime(window.data.resetsAt) }}
        </p>
      </div>
    </div>
    <div aria-label="滚动用量" class="grid grid-cols-2 gap-2">
      <div
        v-for="window in windows"
        :key="window.key"
        class="min-w-0 rounded bg-gray-50 p-2 dark:bg-gray-800"
      >
        <div class="flex flex-wrap justify-between gap-1 text-gray-700 dark:text-gray-200">
          <span>{{ window.label }}</span>
          <span class="font-medium tabular-nums">{{
            window.data?.formattedCost || '$0.000000'
          }}</span>
        </div>
        <div class="my-1 h-1.5 overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
          <div class="h-full bg-indigo-500" :style="{ width: width(window.data?.cost) }" />
        </div>
        <p class="text-gray-500 dark:text-gray-400">
          {{ formatNumber(window.data?.requests || 0) }} 次 ·
          {{ formatNumber(window.data?.tokens || 0) }} tokens
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { formatNumber } from '@/libs/tools'
import { formatLocalDateTime } from '@/libs/time'

const props = defineProps({
  showQuota: { type: Boolean, default: false },
  quota: { type: Object, default: null },
  rollingUsage: { type: Object, default: null }
})
const quotaWindows = computed(() => [
  { key: 'tokens', label: 'Token 窗口', data: props.quota?.tokens },
  { key: 'requests', label: '请求窗口', data: props.quota?.requests }
])
const windows = computed(() =>
  [
    { key: 'fiveHour', label: '近 5 小时' },
    { key: 'oneDay', label: '近 1 天' },
    { key: 'sevenDay', label: '近 7 天' },
    { key: 'thirtyDay', label: '近 30 天' }
  ].map((window) => ({ ...window, data: props.rollingUsage?.[window.key] }))
)
const maxCost = computed(() =>
  Math.max(...windows.value.map((window) => Number(window.data?.cost) || 0), 0)
)
const width = (cost) =>
  maxCost.value > 0 && cost > 0 ? `${Math.min(100, (cost / maxCost.value) * 100)}%` : '0%'
</script>
