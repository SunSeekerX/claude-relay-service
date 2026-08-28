<template>
  <div class="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-700 dark:text-gray-200">
    <div v-if="showTotal" class="text-gray-500 dark:text-gray-400">
      共 <span class="font-medium text-gray-800 dark:text-gray-100">{{ total }}</span> 条
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <button
        class="rounded-lg border border-gray-200 px-3 py-1.5 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
        :disabled="currentPage <= 1"
        type="button"
        @click="go(currentPage - 1)"
      >
        上一页
      </button>
      <span class="min-w-[4.5rem] text-center">
        {{ currentPage }} / {{ pageCount }}
      </span>
      <button
        class="rounded-lg border border-gray-200 px-3 py-1.5 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
        :disabled="currentPage >= pageCount"
        type="button"
        @click="go(currentPage + 1)"
      >
        下一页
      </button>
      <div v-if="pageSizes?.length" class="w-[7.5rem]">
        <CustomDropdown
          :model-value="pageSize"
          accent="gray"
          :glow="false"
          :options="pageSizeOptions"
          size="sm"
          @update:model-value="onSizeChange"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import CustomDropdown from '@/components/common/custom_dropdown.vue'

const props = defineProps({
  currentPage: { type: Number, default: 1 },
  pageSize: { type: Number, default: 20 },
  total: { type: Number, default: 0 },
  pageSizes: { type: Array, default: () => [10, 20, 50, 100] },
  showTotal: { type: Boolean, default: true }
})

const emit = defineEmits(['update:currentPage', 'update:pageSize', 'current-change', 'size-change'])

const pageCount = computed(() => Math.max(1, Math.ceil((props.total || 0) / (props.pageSize || 1))))

const pageSizeOptions = computed(() =>
  (props.pageSizes || []).map((size) => ({
    value: size,
    label: `${size} / 页`
  }))
)

const go = (page) => {
  const next = Math.min(pageCount.value, Math.max(1, page))
  if (next === props.currentPage) return
  emit('update:currentPage', next)
  emit('current-change', next)
}

const onSizeChange = (value) => {
  const size = Number(value)
  if (!Number.isFinite(size) || size === props.pageSize) return
  emit('update:pageSize', size)
  // 只发 size-change：消费者 handleSizeChange 内会重置页码并请求一次，避免再触发 current-change 双请求
  emit('update:currentPage', 1)
  emit('size-change', size)
}
</script>
