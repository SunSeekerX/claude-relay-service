<template>
  <div
    class="relative flex h-full min-h-0 items-center justify-center overflow-y-auto bg-gray-50 px-4 py-6 dark:bg-gray-900 sm:px-6"
  >
    <!-- 主题切换按钮 -->
    <div class="fixed right-4 top-4 z-10">
      <ThemeToggle mode="dropdown" />
    </div>

    <div class="w-full max-w-md space-y-4">
      <div>
        <div class="mx-auto flex h-10 w-auto items-center justify-center">
          <i
            aria-hidden="true"
            class="i-lucide-circle-check h-7 w-7 text-blue-600 dark:text-blue-400"
          />
          <span class="ml-2 text-lg font-bold text-gray-900 dark:text-white">Claude Relay</span>
        </div>
        <h2 class="mt-3 text-center text-xl font-extrabold text-gray-900 dark:text-white">
          User Sign In
        </h2>
        <p class="mt-1 text-center text-sm text-gray-600 dark:text-gray-400">
          Sign in to your account to manage your API keys
        </p>
      </div>

      <div class="rounded-xl border border-gray-200 bg-white px-4 py-5 shadow dark:border-gray-700 dark:bg-gray-800 dark:shadow-xl sm:px-5">
        <form class="space-y-3" @submit.prevent="handleLogin">
          <div>
            <label
              class="block text-sm font-medium text-gray-700 dark:text-gray-300"
              for="username"
            >
              Username
            </label>
            <div class="mt-1">
              <input
                id="username"
                v-model="form.username"
                autocomplete="username"
                class="form-input w-full"
                :disabled="loading"
                name="username"
                placeholder="Enter your username"
                required
                type="text"
              />
            </div>
          </div>

          <div>
            <label
              class="block text-sm font-medium text-gray-700 dark:text-gray-300"
              for="password"
            >
              Password
            </label>
            <div class="mt-1">
              <input
                id="password"
                v-model="form.password"
                autocomplete="current-password"
                class="form-input w-full"
                :disabled="loading"
                name="password"
                placeholder="Enter your password"
                required
                type="password"
              />
            </div>
          </div>

          <div
            v-if="error"
            class="rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/20"
          >
            <div class="flex">
              <div class="flex-shrink-0">
                <i aria-hidden="true" class="i-lucide-circle-x h-5 w-5 text-red-400" />
              </div>
              <div class="ml-3">
                <p class="text-sm text-red-700 dark:text-red-400">{{ error }}</p>
              </div>
            </div>
          </div>

          <div>
            <button
              class="group relative flex w-full justify-center rounded-md border border-transparent bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600 dark:focus:ring-blue-400 dark:focus:ring-offset-gray-800"
              :disabled="loading || !form.username || !form.password"
              type="submit"
            >
              <span v-if="loading" class="absolute inset-y-0 left-0 flex items-center pl-3">
                <i
                  aria-hidden="true"
                  class="i-lucide-loader-circle h-5 w-5 animate-spin text-white"
                />
              </span>
              {{ loading ? 'Signing In...' : 'Sign In' }}
            </button>
          </div>

          <div class="text-center">
            <router-link
              class="text-sm text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
              to="/admin-login"
            >
              Admin Login
            </router-link>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useThemeStore } from '@/stores/theme'
import { showToast } from '@/libs/tools'
import ThemeToggle from '@/components/common/theme_toggle.vue'

const router = useRouter()
const userStore = useUserStore()
const themeStore = useThemeStore()

const loading = ref(false)
const error = ref('')

const form = reactive({
  username: '',
  password: ''
})

const handleLogin = async () => {
  if (!form.username || !form.password) {
    error.value = 'Please enter both username and password'
    return
  }

  loading.value = true
  error.value = ''

  try {
    await userStore.login({
      username: form.username,
      password: form.password
    })

    showToast('Login successful!', 'success')
    router.push('/user-dashboard')
  } catch (err) {
    console.error('Login error:', err)
    error.value = err.response?.data?.message || err.message || 'Login failed'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  // 初始化主题（本页不在 MainLayout 内）
  themeStore.initTheme()
})
</script>
