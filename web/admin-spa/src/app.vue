<template>
  <div class="app-root">
    <router-view />

    <!-- 全局组件 -->
    <ToastNotification ref="toastRef" />
    <ThemeSettings />
    <LayoutSettings />
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import ToastNotification from '@/components/common/toast_notification.vue'
import ThemeSettings from '@/components/common/theme_settings.vue'
import LayoutSettings from '@/components/common/layout_settings.vue'

const authStore = useAuthStore()
const toastRef = ref()

onMounted(() => {
  // 检查本地存储的认证状态
  authStore.checkAuth()

  // 加载OEM设置（包括网站图标）
  authStore.loadOemSettings()
})
</script>

<style scoped>
.app-root {
  height: 100%;
  min-height: 100%;
  overflow: hidden;
}
</style>
