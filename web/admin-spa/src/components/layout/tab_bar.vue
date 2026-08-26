<template>
  <!-- 吸顶：滚动内容时主导航 tab 固定在视口顶部 -->
  <div
    class="tab-bar-sticky sticky top-0 z-30 -mx-2 mb-3 px-2 pb-1.5 pt-0 sm:-mx-3 sm:mb-3 sm:px-3 md:-mx-4 md:px-4"
  >
    <!-- 标签栏：移动端横向滑动，桌面端平铺 -->
    <div
      ref="scrollContainer"
      class="tab-scroll flex gap-1.5 overflow-x-auto rounded-xl p-1.5 shadow-sm backdrop-blur-md md:flex-wrap md:overflow-x-visible"
    >
      <button
        v-for="tab in tabs"
        :key="tab.key"
        :class="[
          'tab-btn flex-none whitespace-nowrap px-2.5 py-1.5 text-sm font-semibold sm:px-3 sm:py-2 md:flex-1 md:px-4',
          activeTab === tab.key ? 'active' : 'is-idle'
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
    { key: 'dashboard', name: '仪表板', icon: 'i-lucide-gauge' },
    { key: 'apiKeys', name: 'API Keys', icon: 'i-lucide-key' },
    { key: 'accounts', name: '账户管理', icon: 'i-lucide-circle-user' },
    { key: 'requestDetails', name: '请求明细', icon: 'i-lucide-table' },
    { key: 'quotaCards', name: '额度卡', icon: 'i-lucide-ticket' },
    { key: 'paymentManage', name: '支付管理', icon: 'i-lucide-credit-card' },
    { key: 'proxyPool', name: '代理池', icon: 'i-lucide-server' }
  ]

  // 只有在 LDAP 启用时才显示用户管理
  if (authStore.oemSettings?.ldapEnabled) {
    baseTabs.push({ key: 'userManagement', name: '用户管理', icon: 'i-lucide-users' })
  }

  baseTabs.push({ key: 'settings', name: '系统设置', icon: 'i-lucide-settings-2' })

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
    color-mix(in srgb, var(--surface-color) 88%, transparent) 0%,
    color-mix(in srgb, var(--surface-color) 55%, transparent) 70%,
    transparent 100%
  );
}

/* 标签容器：走主题变量，暗色自动适配 */
.tab-scroll {
  border: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--surface-color) 92%, transparent);
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.tab-scroll::-webkit-scrollbar {
  display: none;
}

/* 清掉 UA 默认；文字色不参与 transition，避免切换时闪黑 */
.tab-btn {
  border: 0;
  box-shadow: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  transition:
    background-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
  /* 关键：不 transition color */
}

.tab-btn.is-idle,
.tab-btn:not(.active) {
  background: transparent;
  color: var(--text-secondary);
}

.tab-btn.is-idle:hover {
  background: var(--nav-item-hover);
  color: var(--text-primary);
}

/* 选中态：文字/图标立刻变白，只动画背景 */
.tab-btn.active {
  background: linear-gradient(135deg, var(--primary-color) 0%, var(--secondary-color) 100%);
  color: #fff !important;
  box-shadow:
    0 10px 15px -3px rgba(var(--primary-rgb), 0.3),
    0 4px 6px -2px rgba(var(--primary-rgb), 0.05);
  transform: translateY(-1px);
}

/* 图标跟文字同色，且禁止 color 过渡 */
.tab-btn i,
.tab-btn :deep(i) {
  color: inherit !important;
  background-color: currentColor !important;
  transition: none !important;
}
</style>
