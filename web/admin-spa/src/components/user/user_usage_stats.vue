<template>
  <div class="space-y-6">
    <div class="sm:flex sm:items-center">
      <div class="sm:flex-auto">
        <h1 class="text-2xl font-semibold text-gray-900 dark:text-gray-100">Usage Statistics</h1>
        <p class="mt-2 text-sm text-gray-700 dark:text-gray-200">
          View your API usage statistics and costs
        </p>
      </div>
      <div class="mt-4 w-44 sm:ml-16 sm:mt-0 sm:flex-none">
        <CustomDropdown
          v-model="selectedPeriod"
          accent="blue"
          icon="i-lucide-calendar-days"
          :options="periodOptions"
          placeholder="Select period"
          size="sm"
          @change="loadUsageStats"
        />
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="py-12 text-center">
      <i
        aria-hidden="true"
        class="i-lucide-loader-circle mx-auto h-8 w-8 animate-spin text-blue-600"
      />
      <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">Loading usage statistics...</p>
    </div>

    <!-- Stats Cards -->
    <div v-else class="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
      <div class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="p-5">
          <div class="flex items-center">
            <div class="flex-shrink-0">
              <i aria-hidden="true" class="i-lucide-zap h-6 w-6 text-blue-500" />
            </div>
            <div class="ml-5 w-0 flex-1">
              <dl>
                <dt class="truncate text-sm font-medium text-gray-500 dark:text-gray-400">
                  Total Requests
                </dt>
                <dd class="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {{ formatNumber(usageStats?.totalRequests || 0) }}
                </dd>
              </dl>
            </div>
          </div>
        </div>
      </div>

      <div class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="p-5">
          <div class="flex items-center">
            <div class="flex-shrink-0">
              <i aria-hidden="true" class="i-lucide-tags h-6 w-6 text-green-500" />
            </div>
            <div class="ml-5 w-0 flex-1">
              <dl>
                <dt class="truncate text-sm font-medium text-gray-500 dark:text-gray-400">
                  Input Tokens
                </dt>
                <dd class="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {{ formatNumber(usageStats?.totalInputTokens || 0) }}
                </dd>
              </dl>
            </div>
          </div>
        </div>
      </div>

      <div class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="p-5">
          <div class="flex items-center">
            <div class="flex-shrink-0">
              <i aria-hidden="true" class="i-lucide-tags h-6 w-6 text-purple-500" />
            </div>
            <div class="ml-5 w-0 flex-1">
              <dl>
                <dt class="truncate text-sm font-medium text-gray-500 dark:text-gray-400">
                  Output Tokens
                </dt>
                <dd class="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {{ formatNumber(usageStats?.totalOutputTokens || 0) }}
                </dd>
              </dl>
            </div>
          </div>
        </div>
      </div>

      <div class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="p-5">
          <div class="flex items-center">
            <div class="flex-shrink-0">
              <i aria-hidden="true" class="i-lucide-dollar-sign h-6 w-6 text-yellow-500" />
            </div>
            <div class="ml-5 w-0 flex-1">
              <dl>
                <dt class="truncate text-sm font-medium text-gray-500 dark:text-gray-400">
                  Total Cost
                </dt>
                <dd class="text-lg font-medium text-gray-900 dark:text-gray-100">
                  ${{ (usageStats?.totalCost || 0).toFixed(4) }}
                </dd>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Daily Usage Chart -->
    <div v-if="!loading && usageStats" class="rounded-lg bg-white shadow dark:bg-gray-800">
      <div class="px-4 py-5 sm:p-6">
        <h3 class="mb-4 text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
          Daily Usage Trend
        </h3>

        <!-- Placeholder for chart - you can integrate Chart.js or similar -->
        <div
          class="flex h-64 items-center justify-center rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600"
        >
          <div class="text-center">
            <i
              aria-hidden="true"
              class="i-lucide-chart-column mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
            />
            <h3 class="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">Usage Chart</h3>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Daily usage trends would be displayed here
            </p>
            <p class="mt-2 text-sm text-gray-400 dark:text-gray-500">
              (Chart integration can be added with Chart.js, D3.js, or similar library)
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Model Usage Breakdown -->
    <div
      v-if="!loading && usageStats && usageStats.modelStats?.length > 0"
      class="rounded-lg bg-white shadow dark:bg-gray-800"
    >
      <div class="px-4 py-5 sm:p-6">
        <h3 class="mb-4 text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
          Usage by Model
        </h3>
        <div class="space-y-3">
          <div
            v-for="model in usageStats.modelStats"
            :key="model.name"
            class="flex items-center justify-between"
          >
            <div class="flex items-center">
              <div class="flex-shrink-0">
                <div class="h-2 w-2 rounded-full bg-blue-500"></div>
              </div>
              <div class="ml-3">
                <p class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ model.name }}</p>
              </div>
            </div>
            <div class="text-right">
              <p class="text-sm text-gray-900 dark:text-gray-100">
                {{ formatNumber(model.requests) }} requests
              </p>
              <p class="text-sm text-gray-500 dark:text-gray-400">${{ model.cost.toFixed(4) }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Detailed Usage Table -->
    <div v-if="!loading && userApiKeys.length > 0" class="rounded-lg bg-white shadow dark:bg-gray-800">
      <div class="px-4 py-5 sm:p-6">
        <h3 class="mb-4 text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
          Usage by API Key
        </h3>
        <div class="overflow-hidden">
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-900/40">
              <tr>
                <th
                  class="px-6 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  API Key
                </th>
                <th
                  class="px-6 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  Requests
                </th>
                <th
                  class="px-6 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  Input Tokens
                </th>
                <th
                  class="px-6 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  Output Tokens
                </th>
                <th
                  class="px-6 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  Cost
                </th>
                <th
                  class="px-6 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  Status
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-800">
              <tr v-for="apiKey in userApiKeys" :key="apiKey.id">
                <td class="whitespace-nowrap px-6 py-4">
                  <div class="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {{ apiKey.name }}
                  </div>
                  <div class="text-sm text-gray-500 dark:text-gray-400">{{ apiKey.keyPreview }}</div>
                </td>
                <td class="whitespace-nowrap px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                  {{ formatNumber(apiKey.usage?.requests || 0) }}
                </td>
                <td class="whitespace-nowrap px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                  {{ formatNumber(apiKey.usage?.inputTokens || 0) }}
                </td>
                <td class="whitespace-nowrap px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                  {{ formatNumber(apiKey.usage?.outputTokens || 0) }}
                </td>
                <td class="whitespace-nowrap px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                  ${{ (apiKey.usage?.totalCost || 0).toFixed(4) }}
                </td>
                <td class="whitespace-nowrap px-6 py-4">
                  <span
                    :class="[
                      'inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium',
                      apiKey.isDeleted === 'true' || apiKey.deletedAt
                        ? 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                        : apiKey.isActive
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                          : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                    ]"
                  >
                    {{
                      apiKey.isDeleted === 'true' || apiKey.deletedAt
                        ? 'Deleted'
                        : apiKey.isActive
                          ? 'Active'
                          : 'Disabled'
                    }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- No Data State -->
    <div
      v-if="!loading && (!usageStats || usageStats.totalRequests === 0)"
      class="py-12 text-center"
    >
      <i
        aria-hidden="true"
        class="i-lucide-chart-column mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
      />
      <h3 class="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No usage data</h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        You haven't made any API requests yet. Create an API key and start using the service to see
        usage statistics.
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useUserStore } from '@/stores/user'
import { showToast, formatNumber } from '@/libs/tools'

const userStore = useUserStore()

const loading = ref(true)
const selectedPeriod = ref('week')
const periodOptions = [
  { value: 'day', label: 'Last 24 Hours' },
  { value: 'week', label: 'Last 7 Days' },
  { value: 'month', label: 'Last 30 Days' },
  { value: 'quarter', label: 'Last 90 Days' }
]
const usageStats = ref(null)
const userApiKeys = ref([])

const loadUsageStats = async () => {
  loading.value = true
  try {
    const [stats, apiKeys] = await Promise.all([
      userStore.getUserUsageStats({ period: selectedPeriod.value }),
      userStore.getUserApiKeys(true) // Include deleted keys
    ])

    usageStats.value = stats
    userApiKeys.value = apiKeys
  } catch (error) {
    console.error('Failed to load usage stats:', error)
    showToast('Failed to load usage statistics', 'error')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadUsageStats()
})
</script>
