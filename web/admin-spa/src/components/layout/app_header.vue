<template>
  <!-- 顶部导航 -->
  <div
    class="glass-strong mb-3 rounded-xl p-2 shadow-xl sm:rounded-2xl sm:p-3 md:mb-4 md:rounded-2xl md:p-4"
    style="z-index: 10; position: relative"
  >
    <div class="flex flex-col items-center justify-between gap-2 sm:flex-row sm:gap-3">
      <div
        class="flex w-full items-center justify-center gap-2 sm:w-auto sm:justify-start sm:gap-3 md:gap-4"
      >
        <LogoTitle
          :loading="oemLoading"
          :logo-src="oemSettings.siteIconData || oemSettings.siteIcon"
          :title="oemSettings.siteName"
          title-class="text-white dark:text-gray-100"
        >
          <template #after-title>
            <!-- 版本信息 -->
            <div class="flex items-center gap-1 sm:gap-2">
              <span class="font-mono text-sm text-gray-400 dark:text-gray-500 sm:text-sm"
                >v{{ versionInfo.current || '...' }}</span
              >
              <!-- 更新提示 -->
              <a
                v-if="versionInfo.hasUpdate"
                class="inline-flex animate-pulse items-center gap-1 rounded-full border border-green-600 bg-green-500 px-2 py-0.5 text-sm text-white transition-colors hover:bg-green-600"
                :href="versionInfo.releaseInfo?.htmlUrl || '#'"
                target="_blank"
                title="有新版本可用"
              >
                <i class="i-lucide-arrow-up text-sm" />
                <span>新版本</span>
              </a>
            </div>
          </template>
        </LogoTitle>
      </div>
      <!-- 主题切换和用户菜单 -->
      <div class="flex items-center gap-2 sm:gap-4">
        <!-- 主题切换按钮 -->
        <div class="flex items-center">
          <ThemeToggle mode="dropdown" />
        </div>

        <!-- 分隔线 -->
        <div
          class="h-8 w-px bg-gradient-to-b from-transparent via-gray-300 to-transparent opacity-50 dark:via-gray-600"
        />

        <!-- 用户菜单 -->
        <div class="user-menu-container relative">
          <button
            class="user-menu-button flex items-center gap-2 rounded-2xl px-3 py-2 text-sm font-semibold text-white shadow-lg transition-all duration-200 hover:scale-105 hover:shadow-xl active:scale-95 sm:px-4 sm:py-2.5"
            @click="userMenuOpen = !userMenuOpen"
          >
            <i class="i-lucide-circle-user text-sm sm:text-base" />
            <span class="hidden sm:inline">{{ currentUser.username || 'Admin' }}</span>
            <i
              class="i-lucide-chevron-down ml-1 text-sm transition-transform duration-200"
              :class="{ 'rotate-180': userMenuOpen }"
            />
          </button>

          <!-- 悬浮菜单 -->
          <div
            v-if="userMenuOpen"
            class="user-menu-dropdown absolute right-0 top-full mt-2 w-48 py-2 sm:w-56"
            style="z-index: 999999"
            @click.stop
          >
            <!-- 版本信息 -->
            <div class="user-menu-section px-4 py-3">
              <div class="user-menu-meta flex items-center justify-between text-sm">
                <span class="user-menu-muted">当前版本</span>
                <span class="user-menu-strong font-mono"
                  >v{{ versionInfo.current || '...' }}</span
                >
              </div>
              <div v-if="versionInfo.hasUpdate" class="mt-2">
                <div class="mb-2 flex items-center justify-between text-sm">
                  <span class="font-medium text-green-600 dark:text-green-400">
                    <i class="i-lucide-arrow-up mr-1" />有新版本
                  </span>
                  <span class="font-mono text-green-600 dark:text-green-400"
                    >v{{ versionInfo.latest }}</span
                  >
                </div>
                <a
                  class="block w-full rounded-lg bg-green-500 px-3 py-1.5 text-center text-sm text-white transition-colors hover:bg-green-600"
                  :href="versionInfo.releaseInfo?.htmlUrl || '#'"
                  target="_blank"
                >
                  <i class="i-lucide-external-link mr-1" />查看更新
                </a>
              </div>
              <div
                v-else-if="versionInfo.checkingUpdate"
                class="mt-2 text-center text-sm text-gray-500 dark:text-gray-400"
              >
                <i class="i-lucide-loader-circle animate-spin mr-1" />检查更新中...
              </div>
              <div v-else class="mt-2 text-center">
                <!-- 已是最新版提醒 -->
                <transition mode="out-in" name="fade">
                  <div
                    v-if="versionInfo.noUpdateMessage"
                    key="message"
                    class="inline-block rounded-lg border border-green-200 bg-green-100 px-3 py-1.5 dark:border-green-800 dark:bg-green-900/30"
                  >
                    <p class="text-sm font-medium text-green-700 dark:text-green-400">
                      <i class="i-lucide-circle-check mr-1" />当前已是最新版本
                    </p>
                  </div>
                  <button
                    v-else
                    key="button"
                    class="user-menu-link text-sm transition-colors"
                    @click="checkForUpdates()"
                  >
                    <i class="i-lucide-refresh-cw mr-1" />检查更新
                  </button>
                </transition>
              </div>
            </div>

            <button
              class="user-menu-item flex w-full items-center gap-3 px-4 py-3 text-left transition-colors"
              @click="openChangePasswordModal"
            >
              <i class="i-lucide-key text-blue-500" />
              <span>修改账户信息</span>
            </button>

            <hr class="user-menu-divider my-2" />

            <button
              class="user-menu-item flex w-full items-center gap-3 px-4 py-3 text-left transition-colors"
              @click="logout"
            >
              <i class="i-lucide-log-out text-red-500" />
              <span>退出登录</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 修改账户信息模态框 -->
  <AppDialog
    v-model="showChangePasswordModal"
    icon="i-lucide-key"
    title="修改账户信息"
    @close="closeChangePasswordModal"
  >
    <form id="change-password-form" class="space-y-4" @submit.prevent="changePassword">
      <div>
        <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
          >当前用户名</label
        >
        <input
          class="form-input w-full cursor-not-allowed opacity-80"
          disabled
          type="text"
          :value="currentUser.username || 'Admin'"
        />
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">输入新用户名可修改当前用户名</p>
      </div>

      <div>
        <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
          >新用户名</label
        >
        <input
          v-model="changePasswordForm.newUsername"
          class="form-input w-full"
          placeholder="输入新用户名（留空保持不变）"
          type="text"
        />
      </div>

      <div>
        <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
          >当前密码</label
        >
        <div class="relative">
          <input
            v-model="changePasswordForm.currentPassword"
            class="form-input form-input--with-icon w-full"
            placeholder="请输入当前密码"
            required
            :type="showCurrentPassword ? 'text' : 'password'"
          />
          <button
            class="password-toggle"
            type="button"
            @click="showCurrentPassword = !showCurrentPassword"
          >
            <i :class="showCurrentPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'" />
          </button>
        </div>
      </div>

      <div>
        <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
          >新密码</label
        >
        <input
          v-model="changePasswordForm.newPassword"
          class="form-input w-full"
          placeholder="请输入新密码（至少 8 位）"
          required
          type="password"
        />
      </div>

      <div>
        <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
          >确认新密码</label
        >
        <input
          v-model="changePasswordForm.confirmPassword"
          class="form-input w-full"
          placeholder="请再次输入新密码"
          required
          type="password"
        />
      </div>
    </form>

    <template #footer>
      <button class="toolbar-btn flex-1" type="button" @click="closeChangePasswordModal">
        取消
      </button>
      <button
        class="btn btn-primary h-10 flex-1"
        form="change-password-form"
        type="submit"
        :disabled="changePasswordLoading"
      >
        <div v-if="changePasswordLoading" class="loading-spinner mr-2" />
        <i v-else class="i-lucide-save mr-2" />
        {{ changePasswordLoading ? '保存中...' : '保存修改' }}
      </button>
    </template>
  </AppDialog>

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
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { showToast } from '@/libs/tools'
import { isOk, msgOf } from '@/libs/http_envelope'

import { checkUpdatesApi, changePasswordApi } from '@/libs/http_apis'
import LogoTitle from '@/components/common/logo_title.vue'
import ThemeToggle from '@/components/common/theme_toggle.vue'
import ConfirmModal from '@/components/common/confirm_modal.vue'
import AppDialog from '@/components/common/app_dialog.vue'

const router = useRouter()
const authStore = useAuthStore()

// 当前用户信息
const currentUser = computed(() => authStore.user || { username: 'Admin' })

// OEM设置
const oemSettings = computed(() => authStore.oemSettings || {})
const oemLoading = computed(() => authStore.oemLoading)

// 版本信息
const versionInfo = ref({
  current: '...',
  latest: '',
  hasUpdate: false,
  checkingUpdate: false,
  lastChecked: null,
  releaseInfo: null,
  noUpdateMessage: false
})

// 用户菜单状态
const userMenuOpen = ref(false)

// 修改密码模态框
const showChangePasswordModal = ref(false)
const changePasswordLoading = ref(false)
const showCurrentPassword = ref(false)
const changePasswordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
  newUsername: ''
})

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

// 检查更新（同时获取版本信息）
const checkForUpdates = async () => {
  if (versionInfo.value.checkingUpdate) {
    return
  }

  versionInfo.value.checkingUpdate = true

  try {
    const result = await checkUpdatesApi()

    if (isOk(result)) {
      const data = result.data

      versionInfo.value.current = data.current
      versionInfo.value.latest = data.latest
      versionInfo.value.hasUpdate = data.hasUpdate
      versionInfo.value.releaseInfo = data.releaseInfo
      versionInfo.value.lastChecked = new Date()

      // 保存到localStorage
      localStorage.setItem(
        'versionInfo',
        JSON.stringify({
          current: data.current,
          latest: data.latest,
          lastChecked: versionInfo.value.lastChecked,
          hasUpdate: data.hasUpdate,
          releaseInfo: data.releaseInfo
        })
      )

      // 如果没有更新，显示提醒
      if (!data.hasUpdate) {
        versionInfo.value.noUpdateMessage = true
        // 3秒后自动隐藏提醒
        setTimeout(() => {
          versionInfo.value.noUpdateMessage = false
        }, 3000)
      }
    }
  } catch (error) {
    console.error('Error checking for updates:', error)

    // 尝试从localStorage读取缓存的版本信息
    const cached = localStorage.getItem('versionInfo')
    if (cached) {
      const cachedInfo = JSON.parse(cached)
      versionInfo.value.current = cachedInfo.current || versionInfo.value.current
      versionInfo.value.latest = cachedInfo.latest
      versionInfo.value.hasUpdate = cachedInfo.hasUpdate
      versionInfo.value.releaseInfo = cachedInfo.releaseInfo
      versionInfo.value.lastChecked = new Date(cachedInfo.lastChecked)
    }
  } finally {
    versionInfo.value.checkingUpdate = false
  }
}

// 打开修改密码弹窗
const openChangePasswordModal = () => {
  changePasswordForm.currentPassword = ''
  changePasswordForm.newPassword = ''
  changePasswordForm.confirmPassword = ''
  changePasswordForm.newUsername = ''
  showChangePasswordModal.value = true
  userMenuOpen.value = false
}

// 关闭修改密码弹窗
const closeChangePasswordModal = () => {
  showChangePasswordModal.value = false
}

// 修改密码
const changePassword = async () => {
  if (changePasswordForm.newPassword !== changePasswordForm.confirmPassword) {
    showToast('两次输入的密码不一致', 'error')
    return
  }

  if (changePasswordForm.newPassword.length < 8) {
    showToast('新密码长度至少8位', 'error')
    return
  }

  changePasswordLoading.value = true

  try {
    const data = await changePasswordApi({
      currentPassword: changePasswordForm.currentPassword,
      newPassword: changePasswordForm.newPassword,
      newUsername: changePasswordForm.newUsername || undefined
    })

    if (isOk(data)) {
      const message = changePasswordForm.newUsername
        ? '账户信息修改成功，请重新登录'
        : '密码修改成功，请重新登录'
      showToast(message, 'success')
      closeChangePasswordModal()

      // 延迟后退出登录
      setTimeout(() => {
        authStore.logout()
        router.push('/login')
      }, 1500)
    } else {
      showToast(msgOf(data, '修改失败'), 'error')
    }
  } catch (error) {
    showToast('修改密码失败', 'error')
  } finally {
    changePasswordLoading.value = false
  }
}

// 退出登录
const logout = async () => {
  const confirmed = await showConfirm(
    '退出登录',
    '确定要退出登录吗？',
    '确定退出',
    '取消',
    'warning'
  )
  if (confirmed) {
    authStore.logout()
    router.push('/login')
    showToast('已安全退出', 'success')
  }
  userMenuOpen.value = false
}

// 点击外部关闭菜单
const handleClickOutside = (event) => {
  const userMenuContainer = event.target.closest('.user-menu-container')
  if (!userMenuContainer && userMenuOpen.value) {
    userMenuOpen.value = false
  }
}

onMounted(() => {
  checkForUpdates()

  // 设置自动检查更新（每小时检查一次）
  setInterval(() => {
    checkForUpdates()
  }, 3600000) // 1小时

  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
/* 用户菜单按钮样式 */
.user-menu-button {
  position: relative;
  overflow: hidden;
  min-height: 38px;
  background: linear-gradient(135deg, var(--primary-color) 0%, var(--secondary-color) 100%);
  box-shadow: 0 4px 12px rgba(var(--primary-rgb), 0.3);
}

.user-menu-button:hover {
  box-shadow: 0 6px 16px rgba(var(--primary-rgb), 0.4);
}

/* 添加光泽效果 */
.user-menu-button::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
  transition: left 0.5s;
}

.user-menu-button:hover::before {
  left: 100%;
}

/* 用户菜单：主题变量驱动，暗色自动适配 */
.user-menu-dropdown {
  margin-top: 8px;
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
  background: var(--surface-color);
  box-shadow: var(--shadow-md);
  color: var(--text-primary);
  backdrop-filter: blur(10px);
  animation: slideDown 0.3s ease-out;
}

.user-menu-section {
  border-bottom: 1px solid var(--divider-color);
}

.user-menu-muted {
  color: var(--text-secondary);
}

.user-menu-strong {
  color: var(--text-primary);
}

.user-menu-link {
  color: var(--primary-color);
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 0;
}

.user-menu-link:hover {
  filter: brightness(1.1);
}

.user-menu-item {
  border: 0;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
}

.user-menu-item:hover {
  background: var(--nav-item-hover);
}

.user-menu-item i {
  color: inherit;
  background-color: currentColor;
}

.user-menu-item .i-lucide-key {
  color: #3b82f6;
  background-color: currentColor;
}

.user-menu-item .i-lucide-log-out {
  color: #ef4444;
  background-color: currentColor;
}

.user-menu-divider {
  border: 0;
  border-top: 1px solid var(--divider-color);
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* fade过渡动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
