<template>
  <!-- 主题安全开关：轨道色写在 CSS 里，避开全局 button{background:transparent} 把 utility 底色吃掉 -->
  <button
    :aria-checked="modelValue ? 'true' : 'false'"
    class="app-switch"
    :class="[
      sizeClass,
      modelValue ? 'is-on' : 'is-off',
      `is-${color}`,
      disabled ? 'is-disabled' : ''
    ]"
    :disabled="disabled"
    role="switch"
    type="button"
    :title="title"
    @click="onToggle"
  >
    <span class="app-switch__thumb" />
  </button>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // green=状态开闭（API Key 活跃）；blue=设置项
  color: {
    type: String,
    default: 'blue',
    validator: (value) => ['blue', 'green'].includes(value)
  },
  size: {
    type: String,
    default: 'md',
    validator: (value) => ['sm', 'md'].includes(value)
  },
  disabled: { type: Boolean, default: false },
  title: { type: String, default: '' }
})

const emit = defineEmits(['update:modelValue', 'change'])

const sizeClass = computed(() => (props.size === 'sm' ? 'size-sm' : 'size-md'))

const onToggle = () => {
  if (props.disabled) return
  const next = !props.modelValue
  emit('update:modelValue', next)
  emit('change', next)
}
</script>

<style scoped>
.app-switch {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  border: 0;
  border-radius: 9999px;
  padding: 0;
  cursor: pointer;
  transition: background-color 0.2s ease;
  /* 关键色：关 */
  background-color: #d1d5db;
}

.app-switch.size-sm {
  width: 2.25rem; /* 36px */
  height: 1.25rem; /* 20px */
}

.app-switch.size-md {
  width: 2.75rem; /* 44px */
  height: 1.5rem; /* 24px */
}

.app-switch.is-disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* 开：按色板 */
.app-switch.is-on.is-green {
  background-color: #22c55e;
}

.app-switch.is-on.is-blue {
  background-color: #3b82f6;
}

.app-switch__thumb {
  display: block;
  border-radius: 9999px;
  background-color: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.15);
  transform: translateX(2px);
  transition: transform 0.2s ease;
}

.size-sm .app-switch__thumb {
  width: 1rem;
  height: 1rem;
}

.size-md .app-switch__thumb {
  width: 1.25rem;
  height: 1.25rem;
}

.size-sm.is-on .app-switch__thumb {
  transform: translateX(1.125rem); /* 18px → 靠右 */
}

.size-md.is-on .app-switch__thumb {
  transform: translateX(1.375rem); /* 22px */
}
</style>

<!-- 暗色：关态轨道；开态色保持语义色 -->
<style>
.dark .app-switch.is-off,
html.dark .app-switch.is-off {
  background-color: #4b5563;
}

.dark .app-switch.is-on.is-green,
html.dark .app-switch.is-on.is-green {
  background-color: #22c55e;
}

.dark .app-switch.is-on.is-blue,
html.dark .app-switch.is-on.is-blue {
  background-color: #3b82f6;
}

.dark .app-switch__thumb,
html.dark .app-switch__thumb {
  background-color: #fff;
}
</style>
