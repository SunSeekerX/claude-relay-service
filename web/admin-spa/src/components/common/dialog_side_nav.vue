<template>
  <!-- 左右分栏弹窗侧栏：PC 左竖 / 移动端顶横 -->
  <!-- 父容器需 flex flex-col md:flex-row；本组件作首个子项 -->
  <!-- 尺寸：项高 h-9、字 text-sm、图标 16px；颜色走 dark: 跟主题 -->
  <div class="flex gap-1.5 overflow-x-auto px-1 pb-2.5 md:hidden">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      class="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border-none px-3 text-sm font-medium transition-colors"
      :class="
        modelValue === tab.key
          ? 'bg-blue-500 text-white shadow-sm'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
      "
      :disabled="tab.disabled"
      :title="tab.title || tab.label"
      type="button"
      @click="!tab.disabled && select(tab.key)"
    >
      <i
        v-if="tab.icon"
        class="block h-4 w-4 shrink-0 text-sm leading-none"
        :class="tab.icon"
      />
      {{ tab.label }}
    </button>
  </div>

  <nav
    class="hidden w-40 shrink-0 flex-col gap-1 self-stretch overflow-y-auto border-r border-gray-200 py-1.5 pl-1.5 pr-2 dark:border-gray-700 md:flex"
    aria-label="弹窗分节"
  >
    <button
      v-for="tab in tabs"
      :key="tab.key"
      class="flex h-9 min-h-9 max-h-9 items-center gap-2 rounded-lg border-y-0 border-r-0 text-left text-sm font-medium transition-colors"
      :class="
        modelValue === tab.key
          ? '-mr-2 border-l-[3px] border-l-blue-500 bg-white py-0 pl-3.5 pr-3 font-semibold text-blue-600 dark:border-l-blue-400 dark:bg-gray-800 dark:text-blue-400'
          : 'border-l-[3px] border-l-transparent bg-transparent py-0 pl-3.5 pr-2.5 text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800/80 dark:hover:text-gray-100'
      "
      :disabled="tab.disabled"
      :title="tab.title || tab.label"
      type="button"
      @click="!tab.disabled && select(tab.key)"
    >
      <i
        v-if="tab.icon"
        class="block h-4 w-4 shrink-0 text-sm leading-none"
        :class="tab.icon"
      />
      <span class="min-w-0 truncate">{{ tab.label }}</span>
    </button>
  </nav>
</template>

<script setup>
// tabs: [{ key, label, icon?, disabled?, title? }]
defineProps({
  modelValue: { type: [String, Number], default: '' },
  tabs: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:modelValue', 'change'])

const select = (key) => {
  emit('update:modelValue', key)
  emit('change', key)
}
</script>
