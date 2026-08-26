<template>
  <!-- 分段/下划线 Tab：主题变量驱动，亮暗色与色系自动适配 -->
  <div
    class="seg-tabs"
    :class="[
      `size-${size}`,
      `variant-${variant}`,
      { 'is-scrollable': scrollable, 'has-extra': !!$slots.extra }
    ]"
    role="tablist"
  >
    <button
      v-for="tab in normalizedTabs"
      :key="tab.key"
      class="seg-tabs__item"
      :class="{ 'is-active': String(tab.key) === String(modelValue) }"
      role="tab"
      type="button"
      :aria-selected="String(tab.key) === String(modelValue)"
      @click="onSelect(tab.key)"
    >
      <i v-if="tab.icon" class="seg-tabs__icon" :class="tab.icon" />
      <span class="seg-tabs__label">{{ tab.label }}</span>
      <span v-if="tab.badge != null && tab.badge !== ''" class="seg-tabs__badge">{{
        tab.badge
      }}</span>
    </button>
    <div v-if="$slots.extra" class="seg-tabs__extra">
      <slot name="extra" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

// tabs: [{ key|id|value, label|name, icon?, badge? }] 或 string[]
const props = defineProps({
  modelValue: {
    type: [String, Number],
    default: ''
  },
  tabs: {
    type: Array,
    required: true
  },
  // pill：胶囊底；underline：底边指示条
  variant: {
    type: String,
    default: 'pill',
    validator: (v) => ['pill', 'underline'].includes(v)
  },
  size: {
    type: String,
    default: 'md',
    validator: (v) => ['sm', 'md'].includes(v)
  },
  scrollable: {
    type: Boolean,
    default: true
  }
})

const emit = defineEmits(['update:modelValue', 'change'])

const normalizedTabs = computed(() =>
  (props.tabs || []).map((tab) => {
    if (tab == null || typeof tab !== 'object') {
      return { key: String(tab), label: String(tab), icon: '', badge: null }
    }
    return {
      key: tab.key ?? tab.id ?? tab.value,
      label: tab.label ?? tab.name ?? String(tab.key ?? tab.id ?? tab.value ?? ''),
      icon: tab.icon || '',
      badge: tab.badge ?? tab.count ?? null
    }
  })
)

const onSelect = (key) => {
  if (String(key) === String(props.modelValue)) return
  emit('update:modelValue', key)
  emit('change', key)
}
</script>

<style scoped>
.seg-tabs {
  display: inline-flex;
  width: max-content;
  max-width: 100%;
  height: fit-content;
  max-height: fit-content;
  align-items: center;
  align-self: flex-start;
  flex: 0 0 auto;
  gap: 0.25rem;
}

/* 有右侧 extra 时撑满一行，extra 靠右 */
.seg-tabs.has-extra {
  display: flex;
  width: 100%;
  max-width: 100%;
  align-self: stretch;
  flex: 1 1 auto;
}

.seg-tabs.is-scrollable {
  overflow-x: auto;
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.seg-tabs.is-scrollable::-webkit-scrollbar {
  display: none;
}

/* ---- pill ---- */
.seg-tabs.variant-pill {
  padding: 0.25rem;
  border-radius: 0.5rem;
  background: var(--surface-muted, rgba(243, 244, 246, 0.92));
  border: 1px solid color-mix(in srgb, var(--border-color, transparent) 65%, transparent);
}

.seg-tabs.variant-pill .seg-tabs__item {
  border: 0;
  border-radius: 0.375rem;
  background: transparent;
  color: var(--text-secondary);
}

.seg-tabs.variant-pill .seg-tabs__item:hover:not(.is-active) {
  background: var(--nav-item-hover);
  color: var(--text-primary);
}

.seg-tabs.variant-pill .seg-tabs__item.is-active {
  background: var(--surface-color, #fff);
  color: var(--primary-color);
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(15, 23, 42, 0.06));
}

/* ---- underline ---- */
.seg-tabs.variant-underline {
  gap: 0;
  width: 100%;
  border-bottom: 1px solid var(--divider-color, rgba(17, 24, 39, 0.08));
}

.seg-tabs.variant-underline .seg-tabs__item {
  margin-bottom: -1px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--text-secondary);
}

.seg-tabs.variant-underline .seg-tabs__item:hover:not(.is-active) {
  color: var(--text-primary);
  border-bottom-color: color-mix(in srgb, var(--text-muted) 45%, transparent);
}

.seg-tabs.variant-underline .seg-tabs__item.is-active {
  color: var(--primary-color);
  border-bottom-color: var(--primary-color);
  background: transparent;
  box-shadow: none;
}

/* ---- item shared ---- */
.seg-tabs__item {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  box-sizing: border-box;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
  -webkit-appearance: none;
  appearance: none;
}

.size-md .seg-tabs__item {
  height: 2rem;
  padding: 0 0.75rem;
  font-size: 0.875rem;
}

.size-sm .seg-tabs__item {
  height: 1.75rem;
  padding: 0 0.625rem;
  font-size: 0.875rem;
}

.variant-underline.size-md .seg-tabs__item {
  height: 2.25rem;
  padding: 0 1rem;
}


.seg-tabs__icon {
  display: block;
  width: 0.875rem;
  height: 0.875rem;
  flex-shrink: 0;
  background-color: currentColor;
  line-height: 1;
}

.seg-tabs__label {
  min-width: 0;
}

.seg-tabs__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  padding: 0 0.375rem;
  border-radius: 9999px;
  background: var(--surface-muted);
  color: var(--text-primary);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.25rem;
}

.seg-tabs__item.is-active .seg-tabs__badge {
  background: color-mix(in srgb, var(--primary-color) 16%, transparent);
  color: var(--primary-color);
}

.seg-tabs__extra {
  margin-left: auto;
  flex-shrink: 0;
}
</style>
