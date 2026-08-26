<template>
  <div class="card p-2 sm:p-2.5">
    <div class="mb-1.5">
      <h3
        class="flex flex-wrap items-center gap-x-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100"
      >
        <span class="inline-flex items-center gap-1">
          <i class="i-lucide-bot text-sm text-indigo-500" />
          模型使用统计
        </span>
        <span class="text-sm font-normal text-gray-500 dark:text-gray-400"
          >({{ periodLabel }})</span
        >
      </h3>
    </div>

    <div v-if="loading" class="py-3 text-center">
      <i class="i-lucide-loader-circle loading-spinner mb-1 text-lg text-gray-500" />
      <p class="text-sm text-gray-500 dark:text-gray-400">加载模型统计数据中...</p>
    </div>

    <div
      v-else-if="stats.length > 0"
      class="model-usage-list divide-y divide-gray-100 dark:divide-gray-800"
    >
      <div v-for="(model, index) in stats" :key="index" class="model-usage-item py-1.5">
        <button
          class="mb-0.5 inline-flex max-w-full items-center gap-1 truncate text-sm font-semibold text-gray-900 hover:text-indigo-600 dark:text-gray-100 dark:hover:text-indigo-400"
          title="点击复制"
          type="button"
          @click="copyModelName(model.model)"
        >
          <span class="truncate">{{ model.model }}</span>
          <i class="i-lucide-copy shrink-0 text-sm text-gray-400" />
        </button>
        <!-- 完整标签 + 语义色，紧凑横排 -->
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-sm leading-tight">
          <span class="stat-pair">
            <span class="stat-label text-gray-500 dark:text-gray-400">请求</span>
            <span class="stat-value text-gray-900 dark:text-gray-100">{{
              formatNumber(model.requests)
            }}</span>
          </span>
          <span class="stat-pair">
            <span class="stat-label text-gray-500 dark:text-gray-400">总Token</span>
            <span class="stat-value text-gray-900 dark:text-gray-100">{{
              formatNumber(model.allTokens)
            }}</span>
          </span>
          <span class="stat-pair">
            <span class="stat-label text-green-600 dark:text-green-400">输入</span>
            <span class="stat-value text-green-700 dark:text-green-300">{{
              formatNumber(model.inputTokens)
            }}</span>
          </span>
          <span class="stat-pair">
            <span class="stat-label text-blue-600 dark:text-blue-400">输出</span>
            <span class="stat-value text-blue-700 dark:text-blue-300">{{
              formatNumber(model.outputTokens)
            }}</span>
          </span>
          <span v-if="thinkingTokensOf(model) > 0" class="stat-pair">
            <span class="stat-label text-indigo-600 dark:text-indigo-400">思考</span>
            <span class="stat-value text-indigo-700 dark:text-indigo-300">{{
              formatNumber(thinkingTokensOf(model))
            }}</span>
          </span>
          <span class="stat-pair">
            <span class="stat-label text-purple-600 dark:text-purple-400">缓存写</span>
            <span class="stat-value text-purple-700 dark:text-purple-300">{{
              formatNumber(model.cacheCreateTokens || 0)
            }}</span>
          </span>
          <span class="stat-pair">
            <span class="stat-label text-purple-600 dark:text-purple-400">缓存读</span>
            <span class="stat-value text-purple-700 dark:text-purple-300">{{
              formatNumber(model.cacheReadTokens || 0)
            }}</span>
          </span>
          <span class="stat-pair">
            <span class="stat-label text-cyan-600 dark:text-cyan-400">命中率</span>
            <span class="stat-value text-cyan-700 dark:text-cyan-300">{{
              formatHitRate(model)
            }}</span>
          </span>
          <span class="stat-pair">
            <span class="stat-label text-amber-600 dark:text-amber-400">原始</span>
            <span class="stat-value font-semibold text-amber-700 dark:text-amber-300">{{
              model.formatted?.total || formatCostValue(model.costs?.total)
            }}</span>
          </span>
          <span v-if="serviceRates?.rates" class="stat-pair">
            <span class="stat-label text-emerald-600 dark:text-emerald-400">扣费</span>
            <span class="stat-value font-semibold text-emerald-700 dark:text-emerald-300">{{
              calculateCcCost(model)
            }}</span>
          </span>
        </div>
      </div>
    </div>

    <div v-else class="py-3 text-center text-gray-500 dark:text-gray-400">
      <i class="i-lucide-chart-pie mb-1 text-xl opacity-60" />
      <p class="text-sm">暂无{{ periodLabel }}模型使用数据</p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useApiStatsStore } from '@/stores/api_stats'
import { copyText, formatNumber } from '@/libs/tools'

const props = defineProps({
  period: {
    type: String,
    default: 'daily',
    validator: (value) => ['daily', 'monthly', 'alltime'].includes(value)
  }
})

const apiStatsStore = useApiStatsStore()
const {
  dailyModelStats,
  monthlyModelStats,
  alltimeModelStats,
  modelStatsLoading,
  serviceRates,
  keyServiceRates,
  multiKeyMode
} = storeToRefs(apiStatsStore)

const stats = computed(() => {
  if (props.period === 'daily') return dailyModelStats.value
  if (props.period === 'monthly') return monthlyModelStats.value
  if (props.period === 'alltime') return alltimeModelStats.value
  return []
})

const loading = computed(() => modelStatsLoading.value)

const periodLabel = computed(() => {
  if (props.period === 'daily') return '今日'
  if (props.period === 'monthly') return '本月'
  if (props.period === 'alltime') return '所有时间'
  return ''
})

const copyModelName = (name) => copyText(name, '模型名称已复制')

const thinkingTokensOf = (model) =>
  Number(model.thinkingTokens || model.reasoningTokens || model.reasoning_tokens || 0) || 0

// 命中率：缓存读 / (输入 + 缓存读 + 缓存写)
const formatHitRate = (model) => {
  const inputTokens = Number(model.inputTokens) || 0
  const cacheReadTokens = Number(model.cacheReadTokens) || 0
  const cacheCreateTokens = Number(model.cacheCreateTokens) || 0
  const denominator = inputTokens + cacheReadTokens + cacheCreateTokens
  if (denominator <= 0) return '0%'
  const rate = (cacheReadTokens / denominator) * 100
  if (rate >= 10) return `${rate.toFixed(1)}%`
  if (rate > 0) return `${rate.toFixed(2)}%`
  return '0%'
}

const formatCostValue = (cost) => {
  const value = Number(cost) || 0
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(6)}`
}

const getServiceFromModel = (model) => {
  if (!model) return 'claude'
  const lowerName = model.toLowerCase()
  if (
    lowerName.includes('claude') ||
    lowerName.includes('sonnet') ||
    lowerName.includes('opus') ||
    lowerName.includes('haiku')
  ) {
    return 'claude'
  }
  if (
    lowerName.includes('gpt') ||
    lowerName.includes('o1') ||
    lowerName.includes('o3') ||
    lowerName.includes('o4')
  ) {
    return 'codex'
  }
  if (lowerName.includes('gemini')) return 'gemini'
  if (lowerName.includes('droid') || lowerName.includes('factory')) return 'droid'
  if (lowerName.includes('bedrock') || lowerName.includes('amazon')) return 'bedrock'
  if (lowerName.includes('azure')) return 'azure'
  return 'claude'
}

const calculateCcCost = (model) => {
  // 已结算桶：直接用存储的 rated（已含全局×Key）
  if (!model.isLegacy && model.costs?.rated !== undefined) {
    return formatCostValue(model.costs.rated)
  }
  // 历史/未结算：官方费用 × 全局服务倍率 × Key 倍率（对齐 service_cost_cards）
  const cost = model.costs?.real ?? model.costs?.total ?? 0
  if (!cost || !serviceRates.value?.rates) return '$0.00'
  const service = getServiceFromModel(model.model)
  const globalRate = serviceRates.value.rates[service] || 1.0
  const keyRate = multiKeyMode.value ? 1.0 : (keyServiceRates.value?.[service] ?? 1.0)
  return formatCostValue(cost * globalRate * keyRate)
}
</script>

<style scoped>
.card {
  background: var(--surface-color);
  border-radius: 12px;
  border: 1px solid rgb(229 231 235);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  overflow: hidden;
  position: relative;
}

:global(.dark) .card {
  border-color: rgb(55 65 81);
}

.model-usage-list {
  margin: 0 -0.25rem;
}

.model-usage-item {
  padding-left: 0.25rem;
  padding-right: 0.25rem;
  transition: background-color 0.15s ease;
}

.model-usage-item:hover {
  background: rgba(var(--primary-rgb), 0.04);
}

:global(.dark) .model-usage-item:hover {
  background: rgba(var(--primary-rgb), 0.08);
}

.stat-pair {
  display: inline-flex;
  align-items: baseline;
  gap: 0.2rem;
  white-space: nowrap;
}

.stat-label {
  font-weight: 500;
}

.stat-value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.loading-spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
