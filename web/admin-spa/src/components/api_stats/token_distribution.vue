<template>
  <div class="card p-2 sm:p-2.5">
    <h3
      class="mb-1.5 flex flex-wrap items-center gap-x-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100"
    >
      <span class="inline-flex items-center gap-1">
        <i class="i-lucide-coins text-sm text-yellow-500" />
        Token 使用分布
      </span>
      <span class="text-sm font-normal text-gray-500 dark:text-gray-400"
        >({{ statsPeriod === 'daily' ? '今日' : '本月' }})</span
      >
    </h3>
    <div class="space-y-1">
      <div class="flex items-center justify-between gap-2 py-0.5">
        <span class="inline-flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400">
          <i class="i-lucide-arrow-right text-sm text-green-500" />
          输入 Token
        </span>
        <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{
          formatNumber(currentPeriodData.inputTokens)
        }}</span>
      </div>
      <div class="flex items-center justify-between gap-2 py-0.5">
        <span class="inline-flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400">
          <i class="i-lucide-arrow-left text-sm text-blue-500" />
          输出 Token
        </span>
        <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{
          formatNumber(currentPeriodData.outputTokens)
        }}</span>
      </div>
      <div class="flex items-center justify-between gap-2 py-0.5">
        <span class="inline-flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400">
          <i class="i-lucide-save text-sm text-purple-500" />
          缓存创建 Token
        </span>
        <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{
          formatNumber(currentPeriodData.cacheCreateTokens)
        }}</span>
      </div>
      <div class="flex items-center justify-between gap-2 py-0.5">
        <span class="inline-flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400">
          <i class="i-lucide-download text-sm text-orange-500" />
          缓存读取 Token
        </span>
        <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{
          formatNumber(currentPeriodData.cacheReadTokens)
        }}</span>
      </div>
    </div>
    <div class="mt-1.5 border-t border-gray-200 pt-1.5 dark:border-gray-700">
      <div class="flex items-center justify-between font-semibold text-gray-900 dark:text-gray-100">
        <span class="text-sm">{{ statsPeriod === 'daily' ? '今日' : '本月' }}总计</span>
        <span class="text-sm">{{ formatNumber(currentPeriodData.allTokens) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { formatNumber } from '@/libs/tools'
import { storeToRefs } from 'pinia'
import { useApiStatsStore } from '@/stores/api_stats'

const apiStatsStore = useApiStatsStore()
const { statsPeriod, currentPeriodData } = storeToRefs(apiStatsStore)

// 格式化数字
</script>

<style scoped>
.card {
  background: var(--surface-color);
  border-radius: 12px;
  border: 1px solid rgb(229 231 235);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  overflow: hidden;
}
:global(.dark) .card {
  border-color: rgb(55 65 81);
}
</style>
