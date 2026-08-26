<template>
  <!-- 可搜索模型选择：输入 + 候选浮层（Teleport，避免被设置页 overflow 裁切） -->
  <div class="model-picker">
    <div class="model-picker__field">
      <input
        ref="inputRef"
        class="form-input model-picker__input"
        :disabled="disabled"
        :placeholder="placeholder"
        type="text"
        :value="text"
        @blur="onBlur"
        @focus="onFocus"
        @input="onInput"
        @keydown="onKeydown"
      />
      <button
        class="model-picker__chevron"
        :class="{ 'is-open': open }"
        :disabled="disabled"
        tabindex="-1"
        type="button"
        @mousedown.prevent="toggle"
      >
        <i class="i-lucide-chevron-down" />
      </button>
    </div>

    <Teleport to="body">
      <transition
        enter-active-class="model-picker-enter-active"
        enter-from-class="model-picker-enter-from"
        enter-to-class="model-picker-enter-to"
        leave-active-class="model-picker-leave-active"
        leave-from-class="model-picker-leave-from"
        leave-to-class="model-picker-leave-to"
      >
        <div
          v-if="open"
          ref="panelRef"
          class="model-picker__panel"
          :style="panelStyle"
          @mousedown.prevent
        >
          <div v-if="visible.length" class="model-picker__list">
            <button
              v-for="(item, index) in visible"
              :key="item.value"
              class="model-picker__option"
              :class="{
                'is-selected': item.value === text,
                'is-highlighted': index === highlightIndex
              }"
              type="button"
              @mouseenter="highlightIndex = index"
              @mousedown.prevent="select(item.value)"
            >
              <span class="model-picker__option-body">
                <span class="model-picker__option-main">
                  <span class="model-picker__option-label">{{ item.label }}</span>
                  <span v-if="item.preset" class="model-picker__preset">预设</span>
                </span>
                <span
                  v-if="item.label !== item.value"
                  class="model-picker__option-id"
                >
                  {{ item.value }}
                </span>
              </span>
              <span
                v-if="item.value === text"
                class="model-picker__check"
                aria-hidden="true"
              >
                <i class="i-lucide-check" />
              </span>
            </button>
          </div>
          <div v-else class="model-picker__empty">
            无匹配，当前输入将作为自定义模型 ID
          </div>
          <div v-if="truncated" class="model-picker__more">
            共 {{ matched.length }} 项，继续输入以缩小范围
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  // [{ value, label }] 平台预设模型
  presets: { type: Array, default: () => [] },
  // [modelId] 模型价格表全量 id
  catalog: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: '选择或输入模型 ID...' }
})

const emit = defineEmits(['update:modelValue'])

const text = ref(props.modelValue)
const open = ref(false)
const inputRef = ref(null)
const panelRef = ref(null)
const panelStyle = ref({})
const highlightIndex = ref(0)

watch(
  () => props.modelValue,
  (value) => {
    if (value !== text.value) text.value = value
  }
)

// 预设置顶 + 价格表，按 value 去重
const allItems = computed(() => {
  const map = new Map()
  for (const preset of props.presets) {
    if (preset && preset.value) {
      map.set(preset.value, {
        value: preset.value,
        label: preset.label || preset.value,
        preset: true
      })
    }
  }
  for (const modelId of props.catalog) {
    if (modelId && !map.has(modelId)) {
      map.set(modelId, { value: modelId, label: modelId, preset: false })
    }
  }
  return [...map.values()]
})

const matched = computed(() => {
  const query = text.value.trim().toLowerCase()
  if (!query) return allItems.value
  return allItems.value.filter(
    (item) =>
      item.value.toLowerCase().includes(query) || item.label.toLowerCase().includes(query)
  )
})

const visible = computed(() => matched.value.slice(0, 50))
const truncated = computed(() => matched.value.length > 50)

const updatePanelPosition = () => {
  const field = inputRef.value
  if (!field || !open.value) return
  const rect = field.getBoundingClientRect()
  const margin = 8
  const maxPanel = 288
  const spaceBelow = window.innerHeight - rect.bottom - margin
  const spaceAbove = rect.top - margin
  const placeBelow = spaceBelow >= 160 || spaceBelow >= spaceAbove
  const maxHeight = Math.max(120, Math.min(maxPanel, placeBelow ? spaceBelow : spaceAbove))
  let top = placeBelow ? rect.bottom + 4 : rect.top - maxHeight - 4
  if (top < margin) top = margin
  let left = rect.left
  const width = Math.max(rect.width, 200)
  if (left + width > window.innerWidth - margin) {
    left = window.innerWidth - width - margin
  }
  if (left < margin) left = margin
  panelStyle.value = {
    top: `${top}px`,
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`
  }
}

const openPanel = async () => {
  if (props.disabled) return
  open.value = true
  highlightIndex.value = 0
  await nextTick()
  updatePanelPosition()
  requestAnimationFrame(() => updatePanelPosition())
}

const closePanel = () => {
  open.value = false
  highlightIndex.value = 0
}

const onFocus = () => {
  openPanel()
}

const onInput = (event) => {
  text.value = event.target.value
  emit('update:modelValue', event.target.value)
  open.value = true
  highlightIndex.value = 0
  nextTick(() => updatePanelPosition())
}

const onBlur = () => {
  // 延迟关闭：候选项 mousedown + leave 动画
  window.setTimeout(() => {
    closePanel()
  }, 180)
}

const select = (value) => {
  text.value = value
  emit('update:modelValue', value)
  // 稍留选中勾动画再收起
  window.setTimeout(() => {
    closePanel()
  }, 160)
}

const toggle = () => {
  if (props.disabled) return
  if (open.value) {
    closePanel()
  } else {
    openPanel()
    inputRef.value?.focus()
  }
}

const onKeydown = (event) => {
  if (!open.value && (event.key === 'ArrowDown' || event.key === 'Enter')) {
    openPanel()
    return
  }
  if (!open.value) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (!visible.value.length) return
    highlightIndex.value = (highlightIndex.value + 1) % visible.value.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!visible.value.length) return
    highlightIndex.value =
      (highlightIndex.value - 1 + visible.value.length) % visible.value.length
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const item = visible.value[highlightIndex.value]
    if (item) select(item.value)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closePanel()
  }
}

const onScroll = () => {
  if (open.value) updatePanelPosition()
}

const onResize = () => {
  if (open.value) closePanel()
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onResize)
})
</script>

<style scoped>
.model-picker {
  position: relative;
  width: 100%;
}

.model-picker__field {
  position: relative;
  width: 100%;
}

.model-picker__input {
  width: 100%;
  padding-right: 2.25rem;
}

.model-picker__chevron {
  position: absolute;
  top: 50%;
  right: 0.65rem;
  display: inline-flex;
  width: 1rem;
  height: 1rem;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: rgb(156 163 175);
  transform: translateY(-50%);
  cursor: pointer;
  transition: transform 0.2s ease, color 0.15s ease;
}

.model-picker__chevron.is-open {
  transform: translateY(-50%) rotate(180deg);
  color: var(--primary-color, #3b82f6);
}

.model-picker__chevron:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>

<!-- 面板 Teleport 到 body，非 scoped -->
<style>
.model-picker__panel {
  position: fixed;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgb(229 231 235);
  border-radius: 0.875rem;
  background: #fff;
  box-shadow:
    0 10px 28px -6px rgba(15, 23, 42, 0.14),
    0 4px 10px -4px rgba(15, 23, 42, 0.08);
  transform-origin: top center;
  will-change: opacity, transform;
}

.model-picker__list {
  min-height: 0;
  flex: 1 1 auto;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0.35rem;
}

.model-picker__option {
  display: flex;
  width: 100%;
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
  border: 0;
  border-radius: 0.625rem;
  background: transparent;
  padding: 0.45rem 0.75rem;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    transform 0.12s ease;
}

.model-picker__option:active {
  transform: scale(0.985);
}

.model-picker__option-body {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.15rem;
}

.model-picker__option:hover,
.model-picker__option.is-highlighted {
  background: color-mix(in srgb, var(--primary-color, #3b82f6) 10%, transparent);
}

.model-picker__option.is-selected {
  background: color-mix(in srgb, var(--primary-color, #3b82f6) 14%, transparent);
}

.model-picker__option-main {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 0.35rem;
}

.model-picker__option-label {
  overflow: hidden;
  color: rgb(31 41 55);
  font-size: 0.875rem;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-picker__option.is-selected .model-picker__option-label {
  color: var(--primary-color, #2563eb);
  font-weight: 600;
}

.model-picker__preset {
  flex-shrink: 0;
  border-radius: 0.25rem;
  background: rgb(243 244 246);
  padding: 0.05rem 0.35rem;
  color: rgb(107 114 128);
  font-size: 0.875rem;
  line-height: 1.25;
}

.model-picker__check {
  display: inline-flex;
  flex-shrink: 0;
  width: 1.25rem;
  height: 1.25rem;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--primary-color, #3b82f6) 16%, transparent);
  color: var(--primary-color, #3b82f6);
  font-size: 0.875rem;
  animation: model-picker-check-pop 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.model-picker__option-id {
  max-width: 100%;
  overflow: hidden;
  color: rgb(107 114 128);
  font-size: 0.875rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-picker__empty,
.model-picker__more {
  padding: 0.65rem 0.75rem;
  color: rgb(156 163 175);
  font-size: 0.875rem;
}

.model-picker__more {
  border-top: 1px solid rgb(243 244 246);
}


/* 展开/收起动画 */
.model-picker-enter-active {
  transition:
    opacity 0.18s ease,
    transform 0.22s cubic-bezier(0.34, 1.4, 0.64, 1);
  transform-origin: top center;
}
.model-picker-leave-active {
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
  transform-origin: top center;
}
.model-picker-enter-from {
  opacity: 0;
  transform: translateY(-8px) scale(0.96);
}
.model-picker-enter-to {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.model-picker-leave-from {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.model-picker-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
}

@keyframes model-picker-check-pop {
  0% {
    opacity: 0;
    transform: scale(0.4);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

html.dark .model-picker__panel,
.dark .model-picker__panel {
  border-color: rgb(75 85 99 / 0.65);
  background: rgb(31 41 55);
  box-shadow:
    0 12px 32px -6px rgba(0, 0, 0, 0.55),
    0 4px 12px -4px rgba(0, 0, 0, 0.35);
}

html.dark .model-picker__option-label,
.dark .model-picker__option-label {
  color: rgb(229 231 235);
}

html.dark .model-picker__option.is-selected .model-picker__option-label,
.dark .model-picker__option.is-selected .model-picker__option-label {
  color: var(--primary-color, #60a5fa);
}

html.dark .model-picker__check,
.dark .model-picker__check {
  background: color-mix(in srgb, var(--primary-color, #60a5fa) 22%, transparent);
  color: var(--primary-color, #60a5fa);
}

html.dark .model-picker__preset,
.dark .model-picker__preset {
  background: rgb(55 65 81);
  color: rgb(156 163 175);
}

html.dark .model-picker__option-id,
.dark .model-picker__option-id,
html.dark .model-picker__empty,
.dark .model-picker__empty,
html.dark .model-picker__more,
.dark .model-picker__more {
  color: rgb(156 163 175);
}

html.dark .model-picker__more,
.dark .model-picker__more {
  border-top-color: rgb(55 65 81);
}
</style>
