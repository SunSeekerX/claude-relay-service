<template>
  <details
    class="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-600"
    :open="modelValue.length > 0"
  >
    <summary class="cursor-pointer font-semibold">模型映射（{{ modelValue.length }}）</summary>
    <p class="my-3 text-gray-500 dark:text-gray-400">
      将客户端模型名转换为上游模型名；未匹配的模型保持原名。
    </p>
    <div class="space-y-2">
      <div
        v-for="(row, index) in modelValue"
        :key="index"
        class="flex flex-wrap items-center gap-2"
      >
        <input
          :aria-label="`客户端模型 ${index + 1}`"
          class="form-input min-w-0 flex-1"
          placeholder="客户端模型"
          type="text"
          :value="row.from"
          @input="updateRow(index, 'from', $event.target.value)"
        />
        <input
          :aria-label="`上游模型 ${index + 1}`"
          class="form-input min-w-0 flex-1"
          placeholder="上游模型"
          type="text"
          :value="row.to"
          @input="updateRow(index, 'to', $event.target.value)"
        />
        <button
          :aria-label="`删除映射 ${index + 1}`"
          class="btn btn-secondary"
          type="button"
          @click="
            emit(
              'update:modelValue',
              modelValue.filter((_, item) => item !== index)
            )
          "
        >
          <i class="i-lucide-trash-2" />
        </button>
      </div>
    </div>
    <div class="mt-3 flex gap-2">
      <button
        class="btn btn-secondary"
        type="button"
        @click="emit('update:modelValue', [...modelValue, { from: '', to: '' }])"
      >
        添加映射
      </button>
      <button
        class="btn btn-secondary"
        :disabled="!modelValue.length"
        type="button"
        @click="emit('update:modelValue', [])"
      >
        清空映射
      </button>
    </div>
  </details>
</template>
<script setup>
const props = defineProps({ modelValue: { type: Array, default: () => [] } })
const emit = defineEmits(['update:modelValue'])
const updateRow = (index, field, value) =>
  emit(
    'update:modelValue',
    props.modelValue.map((row, item) => (item === index ? { ...row, [field]: value } : row))
  )
</script>
