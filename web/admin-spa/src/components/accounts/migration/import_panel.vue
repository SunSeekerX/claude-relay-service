<template>
  <div class="space-y-3">
    <p class="text-sm text-gray-500 dark:text-gray-400">
      支持 CRS / sub2api / CLIProxyAPI（.json 或 .zip）
    </p>

    <!-- 文件选择：紧凑横条 -->
    <div
      class="flex items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-2.5 dark:border-gray-600"
    >
      <i class="i-lucide-file-input shrink-0 text-base text-gray-400" />
      <input
        ref="fileInput"
        accept=".json,.zip"
        class="hidden"
        type="file"
        @change="onFileChange"
      />
      <button
        class="shrink-0 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        type="button"
        @click="fileInput?.click()"
      >
        选择文件
      </button>
      <span class="min-w-0 flex-1 truncate text-sm text-gray-500 dark:text-gray-400">
        {{ file ? file.name : '未选择文件' }}
      </span>
    </div>

    <!-- 预检结果 -->
    <div
      v-if="inspectResult"
      class="rounded-lg border border-gray-200 dark:border-gray-700"
    >
      <div
        class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-100 px-2.5 py-1.5 text-sm dark:border-gray-700"
      >
        <span class="font-medium text-gray-700 dark:text-gray-200">
          {{ formatLabel(inspectResult.format) }}
        </span>
        <span class="text-green-600 dark:text-green-400">
          可导入 {{ inspectResult.summary.importable }}
        </span>
        <span
          v-if="inspectResult.summary.conflicts"
          class="text-amber-600 dark:text-amber-400"
        >
          冲突 {{ inspectResult.summary.conflicts }}
        </span>
        <span v-if="inspectResult.summary.unsupported" class="text-gray-500">
          跳过 {{ inspectResult.summary.unsupported }}
        </span>
      </div>
      <div class="max-h-40 overflow-y-auto">
        <div
          v-for="(item, index) in inspectResult.items"
          :key="index"
          class="flex items-center justify-between gap-2 border-b border-gray-50 px-2.5 py-1.5 text-sm last:border-0 dark:border-gray-800"
        >
          <span class="min-w-0 truncate text-gray-700 dark:text-gray-300">
            <span
              class="mr-1.5 inline-block rounded bg-gray-100 px-1 py-0.5 text-sm text-gray-500 dark:bg-gray-700 dark:text-gray-300"
            >
              {{ item.platform }}
            </span>
            {{ item.name }}
          </span>
          <span class="shrink-0" :class="actionClass(item.action)">
            {{ actionLabel(item.action) }}
          </span>
        </div>
      </div>
      <div
        v-if="Array.isArray(inspectResult.errors) && inspectResult.errors.length > 0"
        class="space-y-0.5 border-t border-red-100 bg-red-50 px-2.5 py-1.5 text-sm text-red-600 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
      >
        <div v-for="(error, index) in inspectResult.errors" :key="index">
          {{ error.message || error }}
        </div>
      </div>
    </div>

    <!-- 选项 + 操作同一行 -->
    <div class="flex flex-wrap items-center gap-2">
      <template v-if="inspectResult">
        <label class="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
          <input v-model="allowCreate" class="rounded" type="checkbox" />
          新建
        </label>
        <label class="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
          <input v-model="allowUpdate" class="rounded" type="checkbox" />
          更新
        </label>
      </template>
      <div class="ml-auto flex gap-2">
        <button
          class="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          :disabled="!file || busy"
          type="button"
          @click="doInspect"
        >
          <i
            v-if="busy && phase === 'inspect'"
            class="i-lucide-loader-circle animate-spin"
          />
          <i v-else class="i-lucide-search" />
          预检
        </button>
        <button
          class="inline-flex items-center gap-1 rounded-lg bg-green-600 px-2.5 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          :disabled="!inspectResult || busy || inspectResult.summary.importable === 0"
          type="button"
          @click="doImport"
        >
          <i
            v-if="busy && phase === 'import'"
            class="i-lucide-loader-circle animate-spin"
          />
          <i v-else class="i-lucide-upload" />
          导入
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'

import { showToast } from '@/libs/tools'
import { inspectAccountImportApi, importAccountsApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'

const emit = defineEmits(['imported'])

const fileInput = ref(null)
const file = ref(null)
const contentBase64 = ref('')
const inspectResult = ref(null)
const allowCreate = ref(true)
const allowUpdate = ref(true)
const busy = ref(false)
const phase = ref('')

const FORMAT_LABELS = {
  crs: 'CRS 原生',
  sub2api: 'sub2api',
  'cliproxyapi-json': 'CLIProxyAPI',
  'cliproxyapi-zip': 'CLIProxyAPI zip',
  unknown: '未识别'
}

const formatLabel = (format) => FORMAT_LABELS[format] || format

const ACTION_LABELS = {
  create: '新建',
  update: '更新',
  conflict: '冲突',
  unsupported: '跳过'
}

const actionLabel = (action) => ACTION_LABELS[action] || action

const actionClass = (action) => {
  if (action === 'create') return 'text-green-600 dark:text-green-400'
  if (action === 'update') return 'text-blue-600 dark:text-blue-400'
  if (action === 'conflict') return 'text-amber-600 dark:text-amber-400'
  return 'text-gray-400'
}

// File -> base64（去掉 dataURL 前缀）
const readAsBase64 = (targetFile) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.includes(',') ? result.split(',')[1] : result)
    }
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsDataURL(targetFile)
  })

const onFileChange = async (event) => {
  const nextFile = event.target.files && event.target.files[0]
  inspectResult.value = null
  if (!nextFile) {
    file.value = null
    contentBase64.value = ''
    return
  }
  file.value = nextFile
  try {
    contentBase64.value = await readAsBase64(nextFile)
  } catch (error) {
    showToast(error.message || '读取文件失败', 'error')
    file.value = null
    contentBase64.value = ''
  }
}

const doInspect = async () => {
  if (!contentBase64.value) return
  busy.value = true
  phase.value = 'inspect'
  try {
    const response = await inspectAccountImportApi({
      filename: file.value?.name,
      contentBase64: contentBase64.value
    })
    if (!isOk(response)) {
      showToast(msgOf(response, '预检失败'), 'error')
      return
    }
    inspectResult.value = response
    if (response.format === 'unknown') {
      showToast('无法识别文件格式', 'warning')
    }
  } catch (error) {
    showToast(error.message || '预检失败', 'error')
  } finally {
    busy.value = false
    phase.value = ''
  }
}

const doImport = async () => {
  if (!contentBase64.value) return
  busy.value = true
  phase.value = 'import'
  try {
    const response = await importAccountsApi({
      filename: file.value?.name,
      contentBase64: contentBase64.value,
      options: { allowCreate: allowCreate.value, allowUpdate: allowUpdate.value }
    })
    if (!isOk(response)) {
      showToast(msgOf(response, '导入失败'), 'error')
      return
    }
    showToast(
      `导入完成：新建 ${response.created}，更新 ${response.updated}，跳过 ${response.skipped}，失败 ${response.failed}`,
      response.failed > 0 ? 'warning' : 'success'
    )
    emit('imported')
  } catch (error) {
    showToast(error.message || '导入失败', 'error')
  } finally {
    busy.value = false
    phase.value = ''
  }
}
</script>
