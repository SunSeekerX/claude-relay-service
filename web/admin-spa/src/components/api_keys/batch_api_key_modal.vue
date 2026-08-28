<template>
  <ModalTransition @after-leave="onClosed">
    <div v-if="visible" class="modal fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-3">
      <div
        class="modal-content custom-scrollbar mx-auto max-h-[92vh] w-full max-w-4xl overflow-y-auto p-2.5 sm:p-3"
      >
        <div class="mb-3 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div
              class="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-green-500 to-green-600"
            >
              <i class="i-lucide-layers text-lg text-white" />
            </div>
            <div>
              <h3 class="text-xl font-bold text-gray-900 dark:text-gray-100">批量创建成功</h3>
              <p class="text-sm text-gray-600 dark:text-gray-300">成功创建 {{ apiKeys.length }} 个 API Key</p>
            </div>
          </div>
          <button
            class="text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            title="直接关闭（不推荐）"
            @click="handleDirectClose"
          >
            <i class="i-lucide-x text-xl" />
          </button>
        </div>

        <!-- 警告提示 -->
        <div class="mb-3 border-l-4 border-amber-400 bg-amber-50 p-3 dark:border-amber-600 dark:bg-amber-900/20">
          <div class="flex items-start">
            <div
              class="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-amber-400"
            >
              <i class="i-lucide-triangle-alert text-sm text-white" />
            </div>
            <div class="ml-3">
              <h5 class="mb-1 font-semibold text-amber-900 dark:text-amber-200">重要提醒</h5>
              <p class="text-sm text-amber-800 dark:text-amber-300">
                这是您唯一能看到所有 API Key 的机会。关闭此窗口后，系统将不再显示完整的 API
                Key。请立即下载并妥善保存。
              </p>
            </div>
          </div>
        </div>

        <!-- 统计信息 -->
        <div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div
            class="rounded-lg border border-blue-200 bg-gradient-to-br from-blue-50 to-blue-100 p-4 dark:border-blue-800 dark:from-blue-900/20 dark:to-blue-900/30"
          >
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium text-blue-600 dark:text-blue-400">创建数量</p>
                <p class="mt-1 text-2xl font-bold text-blue-900 dark:text-blue-200">
                  {{ apiKeys.length }}
                </p>
              </div>
              <div
                class="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500 bg-opacity-20"
              >
                <i class="i-lucide-key text-blue-600" />
              </div>
            </div>
          </div>

          <div
            class="rounded-lg border border-green-200 bg-gradient-to-br from-green-50 to-green-100 p-4 dark:border-green-800 dark:from-green-900/20 dark:to-green-900/30"
          >
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium text-green-600 dark:text-green-400">基础名称</p>
                <p class="mt-1 truncate text-lg font-bold text-green-900 dark:text-green-200">
                  {{ baseName }}
                </p>
              </div>
              <div
                class="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500 bg-opacity-20"
              >
                <i class="i-lucide-tag text-green-600" />
              </div>
            </div>
          </div>

          <div
            class="rounded-lg border border-purple-200 bg-gradient-to-br from-purple-50 to-purple-100 p-4 dark:border-purple-800 dark:from-purple-900/20 dark:to-purple-900/30"
          >
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium text-purple-600 dark:text-purple-400">权限范围</p>
                <p class="mt-1 text-lg font-bold text-purple-900 dark:text-purple-200">
                  {{ getPermissionText() }}
                </p>
              </div>
              <div
                class="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500 bg-opacity-20"
              >
                <i class="i-lucide-shield text-purple-600" />
              </div>
            </div>
          </div>

          <div
            class="rounded-lg border border-orange-200 bg-gradient-to-br from-orange-50 to-orange-100 p-4 dark:border-orange-800 dark:from-orange-900/20 dark:to-orange-900/30"
          >
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium text-orange-600 dark:text-orange-400">过期时间</p>
                <p class="mt-1 text-lg font-bold text-orange-900 dark:text-orange-200">
                  {{ getExpiryText() }}
                </p>
              </div>
              <div
                class="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500 bg-opacity-20"
              >
                <i class="i-lucide-clock text-orange-600" />
              </div>
            </div>
          </div>
        </div>

        <!-- API Keys 预览 -->
        <div class="mb-3">
          <div class="mb-3 flex items-center justify-between">
            <label class="text-sm font-semibold text-gray-700 dark:text-gray-200">API Keys 预览</label>
            <div class="flex items-center gap-2">
              <button
                class="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                type="button"
                @click="togglePreview"
              >
                <i :class="['h-4 w-4 shrink-0', showPreview ? 'i-lucide-eye-off' : 'i-lucide-eye']" />
                {{ showPreview ? '隐藏' : '显示' }}预览
              </button>
              <span class="text-sm text-gray-500 dark:text-gray-400">（最多显示前10个）</span>
            </div>
          </div>

          <div
            v-if="showPreview"
            class="custom-scrollbar max-h-48 overflow-y-auto rounded-lg bg-gray-900 p-4"
          >
            <pre class="font-mono text-sm text-gray-300">{{ getPreviewText() }}</pre>
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="flex shrink-0 items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
          <button
            class="btn btn-primary h-10 inline-flex flex-1 items-center justify-center px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            @click="downloadApiKeys"
          >
            <i class="i-lucide-download mr-2" />
            下载所有 API Keys
          </button>
          <button
            class="inline-flex h-10 flex-1 items-center justify-center rounded-lg bg-gray-100 px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            type="button"
            @click="handleClose"
          >
            我已保存
          </button>
        </div>

        <!-- 额外提示 -->
        <div class="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/20">
          <p class="flex items-start text-sm text-blue-700 dark:text-blue-300">
            <i class="i-lucide-info mr-2 mt-0.5 flex-shrink-0" />
            <span>
              下载的文件格式为文本文件（.txt），每行包含一个 API Key。
              请将文件保存在安全的位置，避免泄露。
            </span>
          </p>
        </div>
      </div>
    </div>
  </ModalTransition>

  <!-- ConfirmModal -->
  <ConfirmModal
    :cancel-text="confirmModalConfig.cancelText"
    :confirm-text="confirmModalConfig.confirmText"
    :message="confirmModalConfig.message"
    :show="showConfirmModal"
    :title="confirmModalConfig.title"
    :type="confirmModalConfig.type"
    @cancel="handleCancelModal"
    @confirm="handleConfirmModal"
  />
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

import ModalTransition from '@/components/common/modal_transition.vue'
import { showToast } from '@/libs/tools'
import ConfirmModal from '@/components/common/confirm_modal.vue'

const props = defineProps({
  apiKeys: {
    type: Array,
    required: true
  }
})

const emit = defineEmits(['close'])

// 弹窗进入/退出动画：挂载后置 visible 触发进入，关闭时先播退出动画再通知父级卸载
const visible = ref(false)
onMounted(() => {
  visible.value = true
})
const requestClose = () => {
  visible.value = false
}
const onClosed = () => emit('close')

const showPreview = ref(false)

// ConfirmModal 状态
const showConfirmModal = ref(false)
const confirmModalConfig = ref({
  title: '',
  message: '',
  type: 'primary',
  confirmText: '确认',
  cancelText: '取消'
})
const confirmResolve = ref(null)

const showConfirm = (
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  type = 'primary'
) => {
  return new Promise((resolve) => {
    confirmModalConfig.value = { title, message, confirmText, cancelText, type }
    confirmResolve.value = resolve
    showConfirmModal.value = true
  })
}
const handleConfirmModal = () => {
  showConfirmModal.value = false
  confirmResolve.value?.(true)
}
const handleCancelModal = () => {
  showConfirmModal.value = false
  confirmResolve.value?.(false)
}

// 获取基础名称
const baseName = computed(() => {
  if (props.apiKeys.length > 0) {
    const firstKey = props.apiKeys[0]
    // 提取基础名称（去掉 _1, _2 等后缀）
    const match = firstKey.name.match(/^(.+)_\d+$/)
    return match ? match[1] : firstKey.name
  }
  return ''
})

// 获取权限文本
const getPermissionText = () => {
  if (props.apiKeys.length === 0) return '未知'
  const permissions = props.apiKeys[0].permissions
  const permissionMap = {
    all: '全部服务',
    claude: '仅 Claude',
    gemini: '仅 Gemini'
  }
  return permissionMap[permissions] || permissions
}

// 获取过期时间文本
const getExpiryText = () => {
  if (props.apiKeys.length === 0) return '未知'
  const expiresAt = props.apiKeys[0].expiresAt
  if (!expiresAt) return '永不过期'

  const expiryDate = new Date(expiresAt)
  const now = new Date()
  const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24))

  if (diffDays <= 7) return `${diffDays}天`
  if (diffDays <= 30) return `${Math.ceil(diffDays / 7)}周`
  if (diffDays <= 365) return `${Math.ceil(diffDays / 30)}个月`
  return `${Math.ceil(diffDays / 365)}年`
}

// 切换预览显示
const togglePreview = () => {
  showPreview.value = !showPreview.value
}

// 获取预览文本
const getPreviewText = () => {
  const previewKeys = props.apiKeys.slice(0, 10)
  const lines = previewKeys.map((key) => {
    return `${key.name}: ${key.apiKey || key.key || ''}`
  })

  if (props.apiKeys.length > 10) {
    lines.push(`... 还有 ${props.apiKeys.length - 10} 个 API Key`)
  }

  return lines.join('\n')
}

// 下载 API Keys
const downloadApiKeys = () => {
  // 生成文件内容
  const content = props.apiKeys
    .map((key) => {
      return `${key.name}: ${key.apiKey || key.key || ''}`
    })
    .join('\n')

  // 创建 Blob 对象
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })

  // 创建下载链接
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url

  // 生成文件名（包含时间戳）
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
  link.download = `api-keys-${baseName.value}-${timestamp}.txt`

  // 触发下载
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)

  // 释放 URL 对象
  URL.revokeObjectURL(url)

  showToast('API Keys 文件已下载', 'success')
}

// 关闭弹窗（带确认）
const handleClose = async () => {
  const confirmed = await showConfirm(
    '关闭提醒',
    '关闭后将无法再次查看这些 API Key，请确保已经下载并妥善保存。\n\n确定要关闭吗？',
    '确定关闭',
    '返回下载',
    'warning'
  )
  if (confirmed) {
    requestClose()
  }
}

// 直接关闭（不带确认）
const handleDirectClose = async () => {
  const confirmed = await showConfirm(
    '确定要关闭吗？',
    '您还没有下载 API Keys，关闭后将无法再次查看。\n\n强烈建议您先下载保存。',
    '仍然关闭',
    '返回下载',
    'warning'
  )
  if (confirmed) {
    requestClose()
  }
}
</script>

<style scoped>
pre {
  white-space: pre-wrap;
  word-wrap: break-word;
}
</style>
