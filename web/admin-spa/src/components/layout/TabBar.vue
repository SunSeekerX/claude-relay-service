<template>
  <!-- 吸顶：滚动内容时主导航 tab 固定在视口顶部 -->
  <div
    class="tab-bar-sticky sticky top-0 z-30 -mx-2 mb-3 px-2 pb-1.5 pt-0 sm:-mx-3 sm:mb-3 sm:px-3 md:-mx-4 md:px-4"
  >
    <!-- 标签栏：移动端横向滑动，桌面端平铺 -->
    <div
      ref="scrollContainer"
      class="tab-scroll flex gap-1.5 overflow-x-auto rounded-xl border border-white/20 bg-white/85 p-1.5 shadow-sm backdrop-blur-md dark:border-gray-700/50 dark:bg-gray-900/85 md:flex-wrap md:overflow-x-visible"
    >
      <button
        v-for="tab in tabs"
        :key="tab.key"
        :class="[
          'tab-btn flex-none whitespace-nowrap px-2.5 py-1.5 text-sm font-semibold transition-all duration-300 sm:px-3 sm:py-2 md:flex-1 md:px-4',
          activeTab === tab.key
            ? 'active'
            : 'text-gray-700 hover:bg-white/40 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700/40 dark:hover:text-gray-100'
        ]"
        @click="$emit('tab-change', tab.key)"
      >
        <i :class="tab.icon + ' mr-1 sm:mr-2'" />
        {{ tab.name }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  activeTab: {
    type: String,
    required: true
  }
})

defineEmits(['tab-change'])

const authStore = useAuthStore()
const scrollContainer = ref(null)

// 根据 LDAP 配置动态生成 tabs
const tabs = computed(() => {
  const baseTabs = [
    { key: 'dashboard', name: '仪表板', icon: 'fas fa-tachometer-alt' },
    { key: 'apiKeys', name: 'API Keys', icon: 'fas fa-key' },
    { key: 'accounts', name: '账户管理', icon: 'fas fa-user-circle' },
    { key: 'requestDetails', name: '请求明细', icon: 'fas fa-table' },
    { key: 'quotaCards', name: '额度卡', icon: 'fas fa-ticket-alt' },
    { key: 'paymentManage', name: '支付管理', icon: 'fas fa-credit-card' },
    { key: 'proxyPool', name: '代理池', icon: 'fas fa-server' }
  ]

  // 只有在 LDAP 启用时才显示用户管理
  if (authStore.oemSettings?.ldapEnabled) {
    baseTabs.push({ key: 'userManagement', name: '用户管理', icon: 'fas fa-users' })
  }

  baseTabs.push({ key: 'settings', name: '系统设置', icon: 'fas fa-cogs' })

  return baseTabs
})

// 移动端横向滑动时，把当前选中的标签滚动到可见区域中央
const scrollActiveIntoView = () => {
  nextTick(() => {
    const container = scrollContainer.value
    if (!container) return
    const active = container.querySelector('.tab-btn.active')
    if (!active) return
    const current = active.getBoundingClientRect().left - container.getBoundingClientRect().left
    const target = (container.clientWidth - active.offsetWidth) / 2
    container.scrollTo({ left: container.scrollLeft + current - target, behavior: 'smooth' })
  })
}

watch(() => props.activeTab, scrollActiveIntoView)
onMounted(scrollActiveIntoView)
</script>

<style scoped>
/* 吸顶条背后垫一层，避免内容从圆角缝隙透出 */
.tab-bar-sticky {
  background: linear-gradient(
    to bottom,
    rgb(255 255 255 / 0.72) 0%,
    rgb(255 255 255 / 0.55) 70%,
    rgb(255 255 255 / 0) 100%
  );
}

:global(.dark) .tab-bar-sticky,
:global(html.dark) .tab-bar-sticky {
  background: linear-gradient(
    to bottom,
    rgb(17 24 39 / 0.85) 0%,
    rgb(17 24 39 / 0.65) 70%,
    rgb(17 24 39 / 0) 100%
  );
}

/* 移动端横向滑动时隐藏滚动条 */
.tab-scroll {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.tab-scroll::-webkit-scrollbar {
  display: none;
}
</style>
