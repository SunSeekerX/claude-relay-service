<template>
  <div class="flex h-full min-h-0 items-center justify-center overflow-y-auto px-4 py-4">
    <!-- 主题切换按钮 - 固定在右上角 -->
    <div class="fixed right-4 top-4 z-50">
      <ThemeToggle mode="dropdown" />
    </div>

    <div
      class="glass-strong w-full max-w-md rounded-2xl p-4 shadow-2xl sm:p-5"
    >
      <div class="mb-4 text-center">
        <!-- 使用自定义布局来保持登录页面的居中大logo样式 -->
        <div
          class="mx-auto mb-3 flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border border-gray-300/30 bg-gradient-to-br from-blue-500/20 to-purple-500/20 backdrop-blur-sm"
        >
          <template v-if="!oemLoading">
            <img
              v-if="authStore.oemSettings.siteIconData || authStore.oemSettings.siteIcon"
              alt="Logo"
              class="h-9 w-9 object-contain"
              :src="authStore.oemSettings.siteIconData || authStore.oemSettings.siteIcon"
              @error="(e) => (e.target.style.display = 'none')"
            />
            <i v-else class="i-lucide-cloud text-2xl text-gray-700" />
          </template>
          <div v-else class="h-9 w-9 animate-pulse rounded bg-gray-300/50" />
        </div>
        <template v-if="!oemLoading && authStore.oemSettings.siteName">
          <h1 class="header-title mb-1 text-xl font-bold text-white">
            {{ authStore.oemSettings.siteName }}
          </h1>
        </template>
        <div
          v-else-if="oemLoading"
          class="mx-auto mb-1 h-7 w-40 animate-pulse rounded bg-gray-300/50"
        />
      </div>

      <form class="space-y-3" @submit.prevent="handleLogin">
        <div>
          <label
            class="mb-1.5 block text-sm font-semibold text-gray-900 dark:text-gray-100"
            for="username"
            >用户名</label
          >
          <input
            id="username"
            v-model="loginForm.username"
            autocomplete="username"
            class="form-input w-full"
            name="username"
            placeholder="请输入用户名"
            required
            type="text"
          />
        </div>

        <div>
          <label
            class="mb-1.5 block text-sm font-semibold text-gray-900 dark:text-gray-100"
            for="password"
            >密码</label
          >
          <div class="relative">
            <input
              id="password"
              v-model="loginForm.password"
              autocomplete="current-password"
              class="form-input form-input--with-icon w-full"
              name="password"
              placeholder="请输入密码"
              required
              :type="showPassword ? 'text' : 'password'"
            />
            <button
              class="password-toggle"
              type="button"
              tabindex="-1"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              @click="showPassword = !showPassword"
            >
              <i :class="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'" />
            </button>
          </div>
        </div>

        <button
          class="btn btn-primary h-10 w-full text-sm font-semibold"
          :disabled="authStore.loginLoading"
          type="submit"
        >
          <i v-if="!authStore.loginLoading" class="i-lucide-log-in mr-2" />
          <div v-if="authStore.loginLoading" class="loading-spinner mr-2" />
          {{ authStore.loginLoading ? '登录中...' : '登录' }}
        </button>
      </form>

      <div
        v-if="authStore.loginError"
        class="mt-3 rounded-lg border border-red-500/30 bg-red-500/20 p-2.5 text-center text-sm text-red-800 backdrop-blur-sm dark:text-red-400"
      >
        <i class="i-lucide-triangle-alert mr-2" />{{ authStore.loginError }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import ThemeToggle from '@/components/common/theme_toggle.vue'

const authStore = useAuthStore()
const themeStore = useThemeStore()
const oemLoading = computed(() => authStore.oemLoading)

const loginForm = ref({
  username: '',
  password: ''
})
const showPassword = ref(false)

onMounted(() => {
  // 初始化主题
  themeStore.initTheme()
  // 加载OEM设置
  authStore.loadOemSettings()
})

const handleLogin = async () => {
  await authStore.login(loginForm.value)
}
</script>

