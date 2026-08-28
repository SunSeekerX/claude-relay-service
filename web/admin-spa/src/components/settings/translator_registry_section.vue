<template>
  <div>
    <p class="mb-3 t-text-secondary text-sm">
      跨协议转换注册表只读视图。from→to 为转换方向，quality 表示保真度（good / fair /
      discouraged）。数据来自运行中的转换器注册表。
    </p>

    <div v-if="loading" class="py-12 text-center">
      <div class="loading-spinner mx-auto mb-4"></div>
      <p class="t-text-secondary text-sm">正在加载转换注册表...</p>
    </div>

    <div v-else-if="error" class="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/20">
      <p class="text-sm text-red-700 dark:text-red-300">{{ error }}</p>
      <button class="btn btn-primary mt-3 px-3 py-2 text-sm" type="button" @click="loadRegistry">
        重试
      </button>
    </div>

    <template v-else>
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <span
          class="rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-200"
        >
          合计 {{ counts.total }}
        </span>
        <span
          class="rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-700 dark:bg-green-900/40 dark:text-green-300"
        >
          good {{ counts.good }}
        </span>
        <span
          class="rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
        >
          fair {{ counts.fair }}
        </span>
        <span
          class="rounded-full bg-red-100 px-3 py-1 text-sm font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300"
        >
          discouraged {{ counts.discouraged }}
        </span>
        <button
          class="ml-auto flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          type="button"
          @click="loadRegistry"
        >
          <i class="i-lucide-refresh-cw text-sm" />
          刷新
        </button>
      </div>

      <div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          v-model="keyword"
          class="form-input w-full sm:max-w-xs"
          placeholder="筛选 from / to / key"
          type="text"
        />
        <div class="w-full sm:w-40">
          <CustomDropdown
            v-model="qualityFilter"
            accent="gray"
            :glow="false"
            :options="qualityFilterOptions"
            placeholder="全部质量"
            size="sm"
          />
        </div>
      </div>

      <div class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table class="w-full min-w-[640px] text-sm">
          <thead class="bg-gray-50 text-left text-gray-600 dark:bg-gray-800/80 dark:text-gray-300">
            <tr>
              <th class="px-3 py-2 font-medium">From</th>
              <th class="px-3 py-2 font-medium">To</th>
              <th class="px-3 py-2 font-medium">Quality</th>
              <th class="px-3 py-2 font-medium">能力</th>
              <th class="px-3 py-2 font-medium">Key</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
            <tr v-if="filteredEntries.length === 0">
              <td class="px-3 py-6 text-center text-gray-500 dark:text-gray-400" colspan="5">
                无匹配条目
              </td>
            </tr>
            <tr
              v-for="entry in filteredEntries"
              :key="entry.key"
              class="text-gray-800 dark:text-gray-200"
            >
              <td class="px-3 py-2 font-mono text-sm">{{ entry.from }}</td>
              <td class="px-3 py-2 font-mono text-sm">{{ entry.to }}</td>
              <td class="px-3 py-2">
                <span
                  class="rounded-full px-2 py-0.5 text-sm font-medium"
                  :class="qualityClass(entry.quality)"
                >
                  {{ entry.quality || '-' }}
                </span>
              </td>
              <td class="px-3 py-2 text-sm text-gray-600 dark:text-gray-300">
                <span v-if="entry.hasRequest">req</span>
                <span v-if="entry.hasResponse">{{ entry.hasRequest ? ' · ' : '' }}res</span>
                <span v-if="entry.hasStream"
                  >{{ entry.hasRequest || entry.hasResponse ? ' · ' : '' }}stream</span
                >
                <span v-if="!entry.hasRequest && !entry.hasResponse && !entry.hasStream">-</span>
              </td>
              <td class="px-3 py-2 font-mono text-sm text-gray-500 dark:text-gray-400">
                {{ entry.key }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="protocolSurface.length > 0"
        class="mb-4 overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700"
      >
        <div
          class="border-b border-gray-100 px-3 py-2 text-sm font-medium text-gray-700 dark:border-gray-800 dark:text-gray-200"
        >
          官方 CLI 路径覆盖（扫缺口）
        </div>
        <table class="w-full min-w-[720px] text-sm">
          <thead class="bg-gray-50 text-left text-gray-600 dark:bg-gray-800/80 dark:text-gray-300">
            <tr>
              <th class="px-3 py-2 font-medium">协议</th>
              <th class="px-3 py-2 font-medium">状态</th>
              <th class="px-3 py-2 font-medium">路径</th>
              <th class="px-3 py-2 font-medium">说明</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
            <tr
              v-for="row in protocolSurface"
              :key="row.protocol"
              class="text-gray-800 dark:text-gray-200"
            >
              <td class="px-3 py-2">
                <div class="font-medium">{{ row.protocol }}</div>
                <div class="text-sm text-gray-500 dark:text-gray-400">{{ row.source }}</div>
              </td>
              <td class="px-3 py-2">
                <span
                  class="rounded-full px-2 py-0.5 text-sm font-medium"
                  :class="statusClass(row.status)"
                >
                  {{ row.status }}
                </span>
              </td>
              <td class="px-3 py-2 font-mono text-sm">
                <div v-for="pathItem in row.paths" :key="pathItem">{{ pathItem }}</div>
              </td>
              <td class="px-3 py-2 text-sm text-gray-600 dark:text-gray-300">{{ row.note }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        class="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200"
      >
        <p class="font-medium">协议提示</p>
        <ul class="mt-1 list-disc space-y-1 pl-5">
          <li>
            API Key 绑定 OpenAI/Grok 专属账号后，Claude 客户端
            <code class="font-mono">/v1/messages</code>
            可按 model 跨协议桥接（仅专属绑定）。
          </li>
          <li>
            Bedrock/CCR 的
            <code class="font-mono">count_tokens</code>
            可能返回本地估算（带
            <code class="font-mono">_crs_estimate</code>）。
          </li>
          <li>
            Gemini Interactions：
            <code class="font-mono">/v1beta/interactions</code>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'

import CustomDropdown from '@/components/common/custom_dropdown.vue'
import { isOk, msgOf } from '@/libs/http_envelope'
import * as httpApis from '@/libs/http_apis.js'
import { showToast } from '@/libs/tools.js'

defineOptions({
  name: 'TranslatorRegistrySection'
})

const loading = ref(false)
const error = ref('')
const entries = ref([])
const protocolSurface = ref([])
const counts = ref({ total: 0, good: 0, fair: 0, discouraged: 0 })
const keyword = ref('')
const qualityFilter = ref('')

const qualityFilterOptions = [
  { value: '', label: '全部质量' },
  { value: 'good', label: 'good' },
  { value: 'fair', label: 'fair' },
  { value: 'discouraged', label: 'discouraged' }
]

const filteredEntries = computed(() => {
  const keywordValue = keyword.value.trim().toLowerCase()
  const quality = qualityFilter.value
  return entries.value.filter((entry) => {
    if (quality && entry.quality !== quality) {
      return false
    }
    if (!keywordValue) {
      return true
    }
    const haystack = `${entry.from} ${entry.to} ${entry.key}`.toLowerCase()
    return haystack.includes(keywordValue)
  })
})

const qualityClass = (quality) => {
  if (quality === 'good') {
    return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
  }
  if (quality === 'fair') {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
  }
  if (quality === 'discouraged') {
    return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
  }
  return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
}

const statusClass = (status) => {
  if (status === 'covered') {
    return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
  }
  if (status === 'passthrough' || status === 'covered-prefixed') {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
  }
  if (status === 'gap') {
    return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
  }
  return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
}

const loadRegistry = async () => {
  loading.value = true
  error.value = ''
  const response = await httpApis.getTranslatorRegistryApi()
  if (!isOk(response)) {
    error.value = msgOf(response, '加载转换注册表失败')
    showToast(error.value, 'error')
    loading.value = false
    return
  }
  const payload = response.data || {}
  entries.value = Array.isArray(payload.entries) ? payload.entries : []
  protocolSurface.value = Array.isArray(payload.protocolSurface) ? payload.protocolSurface : []
  counts.value = payload.counts || {
    total: entries.value.length,
    good: entries.value.filter((entry) => entry.quality === 'good').length,
    fair: entries.value.filter((entry) => entry.quality === 'fair').length,
    discouraged: entries.value.filter((entry) => entry.quality === 'discouraged').length
  }
  loading.value = false
}

onMounted(() => {
  loadRegistry()
})

defineExpose({ loadRegistry })
</script>
