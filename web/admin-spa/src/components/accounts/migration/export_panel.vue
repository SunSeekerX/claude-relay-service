<template>
  <div class="space-y-3">
    <p class="text-sm text-gray-500 dark:text-gray-400">
      含明文凭据，请妥善保管。
    </p>

    <!-- 范围：紧凑分段 -->
    <div>
      <div class="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">导出范围</div>
      <div class="flex rounded-lg bg-gray-100 p-0.5 dark:bg-gray-700/80">
        <button
          class="inline-flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
          :class="
            scope === 'all'
              ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-800 dark:text-blue-300'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'
          "
          type="button"
          @click="scope = 'all'"
        >
          全部
        </button>
        <button
          class="inline-flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
          :class="
            scope === 'selected'
              ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-800 dark:text-blue-300'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'
          "
          :disabled="selectedIds.length === 0"
          type="button"
          @click="scope = 'selected'"
        >
          仅选中
          <span class="opacity-70">({{ selectedIds.length }})</span>
        </button>
      </div>
    </div>

    <!-- 格式：单行选项 -->
    <div>
      <div class="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">目标格式</div>
      <div class="space-y-1">
        <button
          v-for="opt in formatOptions"
          :key="opt.key"
          class="flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition"
          :class="
            format === opt.key
              ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/30'
              : 'border-gray-200 hover:border-gray-300 dark:border-gray-600 dark:hover:border-gray-500'
          "
          type="button"
          @click="format = opt.key"
        >
          <i
            v-if="opt.key === 'crs'"
            class="i-lucide-database shrink-0 text-base"
            :class="format === opt.key ? 'text-blue-600 dark:text-blue-300' : 'text-gray-400'"
          />
          <i
            v-else-if="opt.key === 'sub2api'"
            class="i-lucide-arrow-left-right shrink-0 text-base"
            :class="format === opt.key ? 'text-blue-600 dark:text-blue-300' : 'text-gray-400'"
          />
          <i
            v-else
            class="i-lucide-file-code shrink-0 text-base"
            :class="format === opt.key ? 'text-blue-600 dark:text-blue-300' : 'text-gray-400'"
          />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-gray-800 dark:text-gray-100">
              {{ opt.label }}
              <span class="ml-1.5 font-normal text-gray-500 dark:text-gray-400">{{ opt.desc }}</span>
            </div>
          </div>
          <i
            v-if="format === opt.key"
            class="i-lucide-check shrink-0 text-base text-blue-600 dark:text-blue-300"
          />
        </button>
      </div>
    </div>

    <button
      class="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="exporting"
      type="button"
      @click="doExport"
    >
      <i v-if="exporting" class="i-lucide-loader-circle animate-spin" />
      <i v-else class="i-lucide-download" />
      {{ exporting ? '导出中...' : '导出' }}
    </button>
  </div>
</template>

<script setup>
import { ref } from 'vue'

import { showToast } from '@/libs/tools'
import { exportAccountsApi } from '@/libs/http_apis'

const props = defineProps({
  selectedIds: { type: Array, default: () => [] }
})

const scope = ref('all')
const format = ref('crs')
const exporting = ref(false)

const formatOptions = [
  { key: 'crs', label: 'CRS 原生', desc: '完整字段，可回导' },
  { key: 'sub2api', label: 'sub2api', desc: 'OAuth / Gemini API' },
  { key: 'cliproxyapi', label: 'CLIProxyAPI', desc: 'auth 文件 / zip' }
]

// 从 Content-Disposition 提取文件名
const filenameFrom = (response, fallback) => {
  const contentDisposition = response.headers.get('content-disposition') || ''
  const match = contentDisposition.match(/filename="?([^"]+)"?/i)
  return match ? decodeURIComponent(match[1]) : fallback
}

const doExport = async () => {
  exporting.value = true
  try {
    const ids = scope.value === 'selected' ? props.selectedIds : null
    const response = await exportAccountsApi({ format: format.value, ids })
    if (!response || !response.ok) {
      const text = response ? await response.text().catch(() => '') : ''
      let message = text
      try {
        const parsed = JSON.parse(text)
        message = parsed.msg || parsed.message || parsed.error || text
      } catch {
        // 非 JSON 响应，原样展示
      }
      showToast(message || '导出失败', 'error')
      return
    }
    // 真 HTTP：错误已是非 2xx，上面 return；成功路径（含 application/json 文件）直接 blob，禁止 clone/json 双缓冲
    const blob = await response.blob()
    const filename = filenameFrom(response, `accounts-${format.value}.json`)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    const countHeader = (name) => parseInt(response.headers.get(name) || '0', 10) || 0
    const skippedCount = countHeader('x-export-skipped-count')
    const readErrorCount = countHeader('x-export-read-errors-count')
    if (readErrorCount > 0 || skippedCount > 0) {
      const parts = []
      if (readErrorCount > 0) parts.push(`${readErrorCount} 个读取失败`)
      if (skippedCount > 0) parts.push(`${skippedCount} 个格式不支持`)
      showToast(`已导出，但有 ${parts.join('，')}`, readErrorCount > 0 ? 'error' : 'warning')
      return
    }
    showToast('导出成功', 'success')
  } catch (error) {
    showToast(error.message || '导出失败', 'error')
  } finally {
    exporting.value = false
  }
}
</script>
