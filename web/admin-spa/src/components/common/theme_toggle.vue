<template>
  <div class="theme-toggle-container">
    <template v-if="mode === 'segmented'">
      <button
        v-for="option in themeOptions"
        :key="option.value"
        :aria-label="option.label"
        :aria-pressed="themeStore.themeMode === option.value"
        class="appearance-trigger"
        :title="option.label"
        type="button"
        @click="themeStore.setThemeMode(option.value)"
      >
        <i :class="option.icon" />
        <span v-if="showLabel">{{ option.label }}</span>
      </button>
    </template>
    <template v-else>
      <button
        aria-haspopup="dialog"
        aria-label="外观设置"
        class="appearance-trigger"
        :title="`外观设置：${themeStore.currentColorScheme.name}`"
        type="button"
        @click="themeStore.settingsOpen = true"
      >
        <span class="appearance-swatch" />
        <span v-if="mode === 'dropdown'">外观</span>
      </button>
      <button
        :aria-label="modeLabel"
        class="appearance-trigger appearance-mode"
        :title="modeLabel"
        type="button"
        @click="themeStore.cycleThemeMode"
      >
        <i :class="currentOption.icon" />
      </button>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useThemeStore } from '@/stores/theme'

// icon 为已有用户面板使用的紧凑入口。
defineProps({
  mode: {
    type: String,
    default: 'compact',
    validator: (value) => ['compact', 'dropdown', 'segmented', 'icon'].includes(value)
  },
  showLabel: { type: Boolean, default: false }
})
const themeStore = useThemeStore()
const themeOptions = [
  { value: 'light', label: '浅色', icon: 'i-lucide-sun' },
  { value: 'dark', label: '深色', icon: 'i-lucide-moon' },
  { value: 'auto', label: '跟随系统', icon: 'i-lucide-contrast' }
]
const currentOption = computed(() =>
  themeOptions.find((option) => option.value === themeStore.themeMode)
)
const modeLabel = computed(() => `当前${currentOption.value.label}，点击切换明暗模式`)
</script>

<style scoped>
.theme-toggle-container {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.appearance-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-width: 34px;
  min-height: 34px;
  padding: 6px 9px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--surface-color);
  color: var(--text-secondary);
  font-size: var(--base-font-size);
  box-shadow: var(--shadow-sm);
}
.appearance-trigger:hover,
.appearance-trigger[aria-pressed='true'] {
  background: var(--primary-soft);
  color: var(--primary-color);
  border-color: var(--primary-color);
}
.appearance-trigger:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 3px;
}
.appearance-swatch {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: conic-gradient(
    var(--primary-color),
    var(--secondary-color),
    var(--accent-color),
    var(--primary-color)
  );
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.1);
}
</style>
