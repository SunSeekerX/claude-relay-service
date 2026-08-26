<template>
  <div class="glass-strong rounded-2xl p-3 sm:p-4">
    <div class="mb-3 flex flex-col items-start justify-between gap-2 sm:mb-4 md:flex-row md:items-center">
      <h2 class="flex items-center text-base font-bold text-gray-800 dark:text-gray-100 sm:text-lg">
        <i class="i-lucide-bot mr-2 text-purple-500" />
        模型使用分布
      </h2>

      <SegmentedTabs
        size="sm"
        :model-value="modelPeriod"
        :tabs="[
          { key: 'daily', label: '今日' },
          { key: 'total', label: '全部' }
        ]"
        @update:model-value="onModelPeriodTab"
      />
    </div>

    <div
      v-if="dashboardStore.dashboardModelStats.length === 0"
      class="py-6 text-center text-gray-500 dark:text-gray-400"
    >
      <i class="i-lucide-chart-pie mb-2 text-3xl opacity-30" />
      <p class="text-sm">暂无模型使用数据</p>
    </div>

    <div v-else class="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:gap-4">
      <!-- 饼图 -->
      <div class="relative" style="height: 300px">
        <canvas ref="chartCanvas" />
      </div>

      <!-- 数据列表 -->
      <div class="space-y-3">
        <div
          v-for="(stat, index) in sortedStats"
          :key="stat.model"
          class="flex items-center justify-between rounded-lg bg-gray-50 p-3"
        >
          <div class="flex items-center gap-3">
            <div class="h-4 w-4 rounded" :style="`background-color: ${getColor(index)}`" />
            <span class="font-medium text-gray-700">{{ stat.model }}</span>
          </div>
          <div class="text-right">
            <p class="font-semibold text-gray-800">{{ formatNumber(stat.requests) }} 请求</p>
            <p class="text-sm text-gray-500">{{ formatNumber(stat.totalTokens) }} tokens</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import SegmentedTabs from '@/components/common/segmented_tabs.vue'
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { Chart } from 'chart.js/auto'
import { useDashboardStore } from '@/stores/dashboard'
import { useChartConfig } from '@/libs/use_chart_config'
import { formatNumber } from '@/libs/tools'

const dashboardStore = useDashboardStore()
const chartCanvas = ref(null)
let chart = null

const modelPeriod = ref('daily')

const sortedStats = computed(() => {
  return [...dashboardStore.dashboardModelStats].sort((a, b) => b.requests - a.requests)
})

const getColor = (index) => {
  const { colorSchemes } = useChartConfig()
  const colors = colorSchemes.primary
  return colors[index % colors.length]
}

const createChart = () => {
  if (!chartCanvas.value || !dashboardStore.dashboardModelStats.length) return

  if (chart) {
    chart.destroy()
  }

  const { colorSchemes } = useChartConfig()
  const colors = colorSchemes.primary

  chart = new Chart(chartCanvas.value, {
    type: 'doughnut',
    data: {
      labels: sortedStats.value.map((stat) => stat.model),
      datasets: [
        {
          data: sortedStats.value.map((stat) => stat.requests),
          backgroundColor: sortedStats.value.map((_, index) => colors[index % colors.length]),
          borderWidth: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              const stat = sortedStats.value[context.dataIndex]
              const percentage = (
                (stat.requests /
                  dashboardStore.dashboardModelStats.reduce((sum, s) => sum + s.requests, 0)) *
                100
              ).toFixed(1)
              return [
                `${stat.model}: ${percentage}%`,
                `请求: ${formatNumber(stat.requests)}`,
                `Tokens: ${formatNumber(stat.totalTokens)}`
              ]
            }
          }
        }
      }
    }
  })
}

const handlePeriodChange = async () => {
  await dashboardStore.loadModelStats(modelPeriod.value)
  createChart()
}

watch(
  () => dashboardStore.dashboardModelStats,
  () => {
    createChart()
  },
  { deep: true }
)

onMounted(() => {
  createChart()
})

onUnmounted(() => {
  if (chart) {
    chart.destroy()
  }
})
</script>
