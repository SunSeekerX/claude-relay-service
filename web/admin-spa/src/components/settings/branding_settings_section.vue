<template>
  <div class="branding-settings max-w-3xl">
    <div class="t-setting-stack">
      <div class="t-setting-row sm:items-start">
        <div class="t-setting-row__label">
          <div class="t-setting-row__title">网站名称</div>
          <p class="t-setting-row__desc">显示在浏览器标题和页面头部</p>
        </div>
        <div class="t-setting-row__control">
          <textarea
            v-model="oemSettings.siteName"
            class="form-input w-full max-w-lg resize-none"
            maxlength="100"
            placeholder="Claude Relay Service"
            rows="2"
          ></textarea>
          <p class="mt-1 t-text-secondary text-sm">最多 100 字符</p>
        </div>
      </div>

      <div class="t-setting-row sm:items-start">
        <div class="t-setting-row__label">
          <div class="t-setting-row__title">网站图标</div>
          <p class="t-setting-row__desc">.ico / .png / .jpg / .svg，最大 350KB</p>
        </div>
        <div class="t-setting-row__control space-y-2">
          <div
            v-if="oemSettings.siteIconData || oemSettings.siteIcon"
            class="inline-flex items-center gap-2"
          >
            <img
              alt="图标预览"
              class="h-8 w-8 rounded"
              :src="oemSettings.siteIconData || oemSettings.siteIcon"
              @error="handleIconError"
            />
            <button class="btn btn-secondary h-8 px-2.5 text-sm" type="button" @click="removeIcon">
              <i class="i-lucide-trash-2 mr-1" />删除
            </button>
          </div>
          <div>
            <input
              ref="iconFileInput"
              accept=".ico,.png,.jpg,.jpeg,.svg"
              class="hidden"
              type="file"
              @change="handleIconUpload"
            />
            <button class="btn btn-secondary h-8 px-3 text-sm" type="button" @click="iconFileInput?.click()">
              <i class="i-lucide-upload mr-1.5" />
              上传图标
            </button>
          </div>
        </div>
      </div>

      <div class="t-setting-row sm:items-center">
        <div class="t-setting-row__label">
          <div class="t-setting-row__title">管理入口</div>
          <p class="t-setting-row__desc">隐藏后需直接访问 /admin/login</p>
        </div>
        <div class="t-setting-row__control flex items-center gap-3">
          <AppSwitch v-model="hideAdminButton" color="blue" size="md" title="隐藏管理入口" />
          <span class="text-sm text-gray-600 dark:text-gray-300">
            {{ hideAdminButton ? '隐藏登录按钮' : '显示登录按钮' }}
          </span>
        </div>
      </div>

      <div class="t-setting-row sm:items-start">
        <div class="t-setting-row__label">
          <div class="t-setting-row__title">统计页通知</div>
          <p class="t-setting-row__desc">在 API Stats 页顶部展示公告</p>
        </div>
        <div class="t-setting-row__control space-y-3">
          <div class="flex items-center gap-3">
            <AppSwitch
              v-model="oemSettings.apiStatsNotice.enabled"
              color="blue"
              size="md"
              title="统计页通知"
            />
            <span class="text-sm text-gray-600 dark:text-gray-300">
              {{ oemSettings.apiStatsNotice.enabled ? '已启用' : '已关闭' }}
            </span>
          </div>
          <div v-if="oemSettings.apiStatsNotice.enabled" class="space-y-2 max-w-lg">
            <input
              v-model="oemSettings.apiStatsNotice.title"
              class="form-input w-full"
              maxlength="100"
              placeholder="通知标题"
              type="text"
            />
            <textarea
              v-model="oemSettings.apiStatsNotice.content"
              class="form-input w-full resize-none"
              maxlength="2000"
              placeholder="通知内容（支持换行）"
              rows="3"
            ></textarea>
          </div>
        </div>
      </div>
    </div>

    <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap gap-2">
        <button
          class="btn btn-primary h-8 px-3 text-sm"
          type="button"
          :disabled="saving"
          @click="saveOemSettings"
        >
          <div v-if="saving" class="loading-spinner mr-1.5"></div>
          <i v-else class="i-lucide-save mr-1.5" />
          {{ saving ? '保存中...' : '保存' }}
        </button>
        <button
          class="btn btn-secondary h-8 px-3 text-sm"
          type="button"
          :disabled="saving"
          @click="resetOemSettings"
        >
          <i class="i-lucide-undo-2 mr-1.5" />
          重置默认
        </button>
      </div>
      <div v-if="oemSettings.updatedAt" class="t-text-secondary text-sm">
        最后更新：{{ formatDateTime(oemSettings.updatedAt) }}
      </div>
    </div>

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
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'

import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast } from '@/libs/tools'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import AppSwitch from '@/components/common/app_switch.vue'
import ConfirmModal from '@/components/common/confirm_modal.vue'

const settingsStore = useSettingsStore()
const authStore = useAuthStore()
const { saving, oemSettings } = storeToRefs(settingsStore)
const iconFileInput = ref(null)
const loadingLocal = ref(false)

const hideAdminButton = computed({
  get() {
    return !oemSettings.value.showAdminButton
  },
  set(value) {
    oemSettings.value.showAdminButton = !value
  }
})

const showConfirmModal = ref(false)
const confirmModalConfig = ref({
  title: '',
  message: '',
  type: 'primary',
  confirmText: '确认',
  cancelText: '取消'
})
const confirmResolve = ref(null)

const showConfirm = (title, message, confirmText = '确认', cancelText = '取消', type = 'primary') => {
  return new Promise((resolve) => {
    confirmModalConfig.value = { title, message, confirmText, cancelText, type }
    confirmResolve.value = resolve
    showConfirmModal.value = true
  })
}

const handleConfirmModal = () => {
  showConfirmModal.value = false
  const resolve = confirmResolve.value
  confirmResolve.value = null
  resolve?.(true)
}

const handleCancelModal = () => {
  showConfirmModal.value = false
  const resolve = confirmResolve.value
  confirmResolve.value = null
  resolve?.(false)
}

const formatDateTime = settingsStore.formatDateTime

const saveOemSettings = async () => {
  try {
    const settings = {
      siteName: oemSettings.value.siteName,
      siteIcon: oemSettings.value.siteIcon,
      siteIconData: oemSettings.value.siteIconData,
      showAdminButton: oemSettings.value.showAdminButton,
      apiStatsNotice: oemSettings.value.apiStatsNotice
    }
    const result = await settingsStore.saveOemSettings(settings)
    if (isOk(result)) {
      authStore.applyOemSettings(result.data)
      showToast('OEM设置保存成功', 'success')
    } else {
      showToast(msgOf(result, '保存失败'), 'error')
    }
  } catch (error) {
    showToast('保存OEM设置失败', 'error')
    console.error(error)
  }
}

const resetOemSettings = async () => {
  if (
    !(await showConfirm(
      '重置设置',
      '确定要重置为默认设置吗？\n\n这将清除所有自定义的网站名称和图标设置。',
      '重置',
      '取消',
      'warning'
    ))
  ) {
    return
  }

  try {
    const result = await settingsStore.resetOemSettings()
    if (isOk(result)) {
      authStore.applyOemSettings(result.data)
      showToast('已重置为默认设置', 'success')
    } else {
      showToast('重置失败', 'error')
    }
  } catch (error) {
    showToast('重置失败', 'error')
    console.error(error)
  }
}

const handleIconUpload = async (event) => {
  const file = event.target.files?.[0]
  if (!file) return

  const validation = settingsStore.validateIconFile(file)
  if (!validation.isValid) {
    validation.errors.forEach((error) => showToast(error, 'error'))
    return
  }

  try {
    oemSettings.value.siteIconData = await settingsStore.fileToBase64(file)
  } catch (error) {
    showToast('文件读取失败', 'error')
    console.error(error)
  }

  event.target.value = ''
}

const removeIcon = () => {
  oemSettings.value.siteIcon = ''
  oemSettings.value.siteIconData = ''
}

const handleIconError = () => {
  console.warn('Icon failed to load')
}

onMounted(async () => {
  // 父页也会 load；此处保证单独进入时有数据
  if (!oemSettings.value?.siteName && !loadingLocal.value) {
    loadingLocal.value = true
    try {
      await settingsStore.loadOemSettings()
    } catch (error) {
      showToast('加载设置失败', 'error')
      console.error(error)
    } finally {
      loadingLocal.value = false
    }
  }
})
</script>
