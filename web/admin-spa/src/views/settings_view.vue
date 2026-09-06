<template>
  <div class="settings-container">
    <!-- 设置中心：PC 左固定 + 右区域内滚动；移动端整页自然滚 -->
    <div
      ref="shellRef"
      class="settings-shell flex flex-col transition-none md:flex-row md:overflow-hidden md:gap-0"
      :style="shellStyle"
    >
      <!-- 设置侧栏：PC 竖栏固定 / 移动端顶栏横滑；样式走主题工具类 -->
      <div class="settings-side-nav shrink-0 md:flex md:h-full md:flex-col">
        <div class="t-side-nav-mobile flex md:hidden">
          <router-link
            v-for="tab in sectionTabs"
            :key="tab.key"
            class="t-side-nav-mobile__item"
            :class="{ 'is-active': activeSection === tab.key }"
            :to="{ name: 'Settings', params: { section: tab.key } }"
          >
            <i v-if="tab.icon" class="text-sm" :class="tab.icon" />
            {{ tab.label }}
          </router-link>
        </div>

        <nav
          class="t-side-nav custom-scrollbar hidden h-full w-44 shrink-0 flex-col overflow-y-auto border-r pr-3 md:flex"
          style="border-color: var(--divider-color)"
        >
          <router-link
            v-for="tab in sectionTabs"
            :key="tab.key"
            class="t-side-nav__item"
            :class="{ 'is-active': activeSection === tab.key }"
            :to="{ name: 'Settings', params: { section: tab.key } }"
          >
            <span class="t-side-nav__icon">
              <i v-if="tab.icon" :class="tab.icon" />
            </span>
            <span class="t-side-nav__label">{{ tab.label }}</span>
          </router-link>
        </nav>
      </div>

      <div
        class="settings-main custom-scrollbar min-h-0 min-w-0 flex-1 px-3 sm:px-4 md:overflow-y-auto md:px-6"
      >
        <div v-if="bootLoading" class="py-12 text-center">
          <div class="loading-spinner mx-auto mb-4"></div>
          <p class="t-text-secondary text-sm">正在加载设置...</p>
        </div>

        <div v-else class="settings-panel py-1">
          <!-- 首次进入某分区才挂载；之后 v-show 保活，避免切 tab 丢草稿，也避免一进设置就全量打接口 -->
          <BrandingSettingsSection
            v-if="visitedSections.branding"
            v-show="activeSection === 'branding'"
          />
          <WebhookSettingsSection
            v-if="visitedSections.webhook"
            v-show="activeSection === 'webhook'"
          />
          <ClaudeSettingsSection
            v-if="visitedSections.claude"
            v-show="activeSection === 'claude'"
          />
          <ServiceRatesSettingsSection
            v-if="visitedSections.serviceRates"
            v-show="activeSection === 'serviceRates'"
          />
          <ModelPricingSection
            v-if="visitedSections.modelPricing"
            v-show="activeSection === 'modelPricing'"
          />
          <TestModelsSettingsSection
            v-if="visitedSections.testModels"
            v-show="activeSection === 'testModels'"
          />
          <TranslatorRegistrySection
            v-if="visitedSections.protocol"
            v-show="activeSection === 'protocol'"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { showToast, calcViewportBottomReserve } from '@/libs/tools'
import { useSettingsStore } from '@/stores/settings'
import BrandingSettingsSection from '@/components/settings/branding_settings_section.vue'
import WebhookSettingsSection from '@/components/settings/webhook_settings_section.vue'
import ClaudeSettingsSection from '@/components/settings/claude_settings_section.vue'
import ServiceRatesSettingsSection from '@/components/settings/service_rates_settings_section.vue'
import TestModelsSettingsSection from '@/components/settings/test_models_settings_section.vue'
import ModelPricingSection from '@/components/settings/model_pricing_section.vue'
import TranslatorRegistrySection from '@/components/settings/translator_registry_section.vue'

defineOptions({
  name: 'SettingsView'
})

const route = useRoute()
const router = useRouter()
const settingsStore = useSettingsStore()

const sectionTabs = [
  { key: 'branding', label: '品牌设置', icon: 'i-lucide-palette', hint: '站点名称、图标与入口展示' },
  { key: 'webhook', label: '通知设置', icon: 'i-lucide-bell', hint: 'Webhook 推送与通知渠道' },
  { key: 'claude', label: '转发配置', icon: 'i-lucide-bot', hint: '客户端限制、会话绑定、请求明细与错误收集' },
  { key: 'serviceRates', label: '服务倍率', icon: 'i-lucide-scale', hint: '各服务计费倍率' },
  { key: 'modelPricing', label: '模型价格', icon: 'i-lucide-coins', hint: '模型单价与价格表' },
  { key: 'testModels', label: '测试模型', icon: 'i-lucide-flask-conical', hint: '连通性测试默认模型' },
  { key: 'protocol', label: '协议转换', icon: 'i-lucide-git-branch', hint: '跨协议转换注册表与桥接说明' }
]
const validSections = sectionTabs.map((tab) => tab.key)

const activeSection = computed(() => {
  const section = route.params.section
  return validSections.includes(section) ? section : 'branding'
})

// 仅挂载访问过的分区：兼顾「按需加载」与「切回保留草稿」
const visitedSections = reactive(Object.fromEntries(validSections.map((key) => [key, false])))

watch(
  activeSection,
  (section) => {
    if (validSections.includes(section)) {
      visitedSections[section] = true
    }
  },
  { immediate: true }
)

watch(
  () => route.params.section,
  (section) => {
    if (!validSections.includes(section)) {
      router.replace({ name: 'Settings', params: { section: 'branding' }, query: route.query })
    }
  },
  { immediate: true }
)

const bootLoading = ref(true)

// 页面加载时获取设置
// PC：锁 shell 高度，左栏固定、右栏 overflow 滚动；移动端不锁高，整页自然滚
const shellRef = ref(null)
const shellHeight = ref(null)
const MOBILE_BREAKPOINT = 768
const isMobileLayout = ref(
  typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT
)

// 扣除 .tab-content 进场动画 translateY，避免动画期 top 偏大导致高度跳
const getStableTop = (el) => {
  let top = el.getBoundingClientRect().top
  let node = el.parentElement
  while (node && node !== document.documentElement) {
    if (node.classList?.contains('tab-content')) {
      const transform = getComputedStyle(node).transform
      if (transform && transform !== 'none') {
        try {
          top -= new DOMMatrixReadOnly(transform).m42
        } catch {
          // ignore
        }
      }
    }
    node = node.parentElement
  }
  return top
}

const shellStyle = computed(() => {
  if (isMobileLayout.value) {
    return {}
  }
  if (shellHeight.value != null) {
    return { height: `${shellHeight.value}px` }
  }
  if (typeof window === 'undefined') {
    return {}
  }
  return { height: `${Math.max(0, window.innerHeight - 220)}px` }
})

const updateShellHeight = () => {
  const el = shellRef.value
  if (!el) {
    return
  }
  isMobileLayout.value = window.innerWidth < MOBILE_BREAKPOINT
  if (isMobileLayout.value) {
    shellHeight.value = null
    return
  }
  const top = getStableTop(el)
  const next = Math.max(0, Math.floor(window.innerHeight - top - calcViewportBottomReserve(el)))
  if (shellHeight.value == null || Math.abs(next - shellHeight.value) > 1) {
    shellHeight.value = next
  }
}

let shellHeightRaf = 0
const scheduleUpdateShellHeight = () => {
  if (shellHeightRaf) {
    return
  }
  shellHeightRaf = window.requestAnimationFrame(() => {
    shellHeightRaf = 0
    updateShellHeight()
  })
}

let shellResizeObserver = null
let shellAnimationTarget = null

const observeShellLayoutTargets = () => {
  if (!shellResizeObserver || !shellRef.value) {
    return
  }
  let node = shellRef.value.parentElement
  while (node && node !== document.documentElement) {
    shellResizeObserver.observe(node)
    let sibling = node.previousElementSibling
    while (sibling) {
      shellResizeObserver.observe(sibling)
      sibling = sibling.previousElementSibling
    }
    node = node.parentElement
  }
}

// 切 section 后右栏滚回顶部，并复测高度（各分区组件自行加载）
watch(activeSection, () => {
  nextTick(() => {
    const main = shellRef.value?.querySelector?.('.settings-main')
    if (main) {
      main.scrollTop = 0
    }
    scheduleUpdateShellHeight()
  })
})

onMounted(async () => {
  try {
    await settingsStore.loadOemSettings()
  } catch (error) {
    showToast('加载设置失败', 'error')
    console.error(error)
  } finally {
    bootLoading.value = false
  }

  window.addEventListener('resize', scheduleUpdateShellHeight)
  if (typeof ResizeObserver !== 'undefined') {
    shellResizeObserver = new ResizeObserver(scheduleUpdateShellHeight)
  }
  updateShellHeight()
  shellAnimationTarget = shellRef.value?.closest('.tab-content') || null
  if (shellAnimationTarget) {
    shellAnimationTarget.addEventListener('animationend', scheduleUpdateShellHeight)
  }
  nextTick(() => {
    updateShellHeight()
    observeShellLayoutTargets()
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleUpdateShellHeight)
  if (shellAnimationTarget) {
    shellAnimationTarget.removeEventListener('animationend', scheduleUpdateShellHeight)
    shellAnimationTarget = null
  }
  if (shellResizeObserver) {
    shellResizeObserver.disconnect()
    shellResizeObserver = null
  }
  if (shellHeightRaf) {
    window.cancelAnimationFrame(shellHeightRaf)
    shellHeightRaf = 0
  }
})
</script>

<style scoped>
.settings-shell {
  min-height: 0;
}
.settings-main {
  min-width: 0;
  min-height: 0;
}
.settings-panel {
  min-width: 0;
}
</style>
