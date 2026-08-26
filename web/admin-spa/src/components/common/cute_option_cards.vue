<template>
  <!-- 可爱选项卡片：替代原生 radio 列表 -->
  <div
    class="grid gap-2"
    :class="[columnsClass, columnsNumber >= 3 ? 'items-stretch' : 'items-start']"
  >
    <button
      v-for="opt in options"
      :key="optionKey(opt)"
      class="cute-option-card group text-left"
      :class="[
        sizeClass,
        layoutClass,
        isActive(opt) ? 'is-active' : '',
        opt.disabled || disabled ? 'is-disabled' : ''
      ]"
      :disabled="!!(opt.disabled || disabled)"
      type="button"
      @click="onSelect(opt)"
    >
      <span
        v-if="opt.icon"
        class="cute-option-card__icon"
        :class="isActive(opt) ? 'is-active' : ''"
      >
        <i :class="opt.icon" />
      </span>
      <span class="cute-option-card__body min-w-0 flex-1">
        <span class="cute-option-card__label">{{ opt.label }}</span>
        <span v-if="opt.description" class="cute-option-card__desc">{{ opt.description }}</span>
      </span>
      <span class="cute-option-card__check" :class="{ 'is-on': isActive(opt) }">
        <i class="i-lucide-check" />
      </span>
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  // 支持 string/number/boolean/null（批量编辑「不修改」等哨兵）
  modelValue: { type: null, default: undefined },
  // [{ value, label, description?, icon?, disabled? }]
  options: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
  // 1 | 2 | 3 | 4
  columns: { type: [Number, String], default: 1 },
  size: { type: String, default: 'md' } // sm | md
})

const emit = defineEmits(['update:modelValue', 'change'])

const columnsNumber = computed(() => Number(props.columns) || 1)

const columnsClass = computed(() => {
  const n = columnsNumber.value
  // 3 列起 sm 就满列，避免 md 断点前先变 2 列把卡片拉得又窄又高
  if (n >= 4) {
    return 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4'
  }
  if (n >= 3) {
    return 'grid-cols-1 sm:grid-cols-3'
  }
  if (n >= 2) {
    return 'grid-cols-1 sm:grid-cols-2'
  }
  return 'grid-cols-1'
})

const sizeClass = computed(() => (props.size === 'sm' ? 'size-sm' : 'size-md'))

// 3 列及以上：窄卡改纵向，避免描述被挤成「使 / 用」孤字折行
const layoutClass = computed(() => (columnsNumber.value >= 3 ? 'is-stacked' : 'is-inline'))

// Object.is：正确区分 null/undefined/true/false/0/''
const isActive = (opt) => Object.is(props.modelValue, opt.value)

const optionKey = (opt) => {
  if (opt.value === null) return '__null__'
  if (opt.value === undefined) return '__undefined__'
  return String(opt.value)
}

const onSelect = (opt) => {
  if (opt.disabled || props.disabled) return
  emit('update:modelValue', opt.value)
  emit('change', opt.value)
}
</script>

<style scoped>
.cute-option-card {
  @apply relative flex w-full rounded-xl border transition-all duration-150;
  @apply border-gray-200 bg-white/80 dark:border-gray-600 dark:bg-gray-800/60;
  @apply hover:border-blue-300 hover:bg-blue-50/50 dark:hover:border-blue-500/50 dark:hover:bg-blue-900/20;
  @apply focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60;
  height: auto;
  min-height: 0;
  align-self: stretch;
}
.cute-option-card.is-inline {
  @apply items-center gap-2.5 px-3 py-2.5;
}
.cute-option-card.is-stacked {
  @apply flex-col items-start gap-2 px-2.5 py-2.5;
}
.cute-option-card.size-sm.is-inline {
  @apply gap-2 px-2.5 py-2;
}
.cute-option-card.size-sm.is-stacked {
  @apply gap-1.5 px-2 py-2;
}
.cute-option-card.is-active {
  @apply border-blue-500 bg-gradient-to-br from-blue-50 to-indigo-50 shadow-sm;
  @apply dark:border-blue-400 dark:from-blue-900/40 dark:to-indigo-900/30;
  box-shadow: 0 0 0 1px rgb(59 130 246 / 0.25);
}
.cute-option-card.is-disabled {
  @apply cursor-not-allowed opacity-50 hover:border-gray-200 hover:bg-white/80;
  @apply dark:hover:border-gray-600 dark:hover:bg-gray-800/60;
}
.cute-option-card:not(.is-disabled) {
  @apply cursor-pointer;
}
.cute-option-card__icon {
  @apply flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500;
  @apply dark:bg-gray-700 dark:text-gray-300;
}
.cute-option-card__icon.is-active {
  @apply bg-blue-500 text-white shadow-sm;
}
.size-sm .cute-option-card__icon {
  @apply h-7 w-7 text-sm;
}
.cute-option-card.is-stacked .cute-option-card__body {
  @apply w-full pr-5;
}
.cute-option-card.is-stacked .cute-option-card__check {
  @apply absolute right-2 top-2;
}
.cute-option-card__label {
  @apply block text-sm font-semibold leading-snug text-gray-800 dark:text-gray-100;
}
.cute-option-card__desc {
  @apply mt-0.5 block text-sm leading-snug text-gray-500 dark:text-gray-400;
}
.cute-option-card.is-stacked .cute-option-card__desc {
  /* 窄卡描述允许自然换行，但不强行撑高 */
  @apply break-words;
}
.cute-option-card__check {
  @apply flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-gray-300 text-[10px] text-transparent;
  @apply dark:border-gray-500;
}
.cute-option-card__check.is-on {
  @apply border-blue-500 bg-blue-500 text-white;
}
</style>
