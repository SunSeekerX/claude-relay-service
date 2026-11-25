<template>
  <div>
    <h4 class="mb-2 text-sm font-semibold t-text">{{ label }}</h4>
    <div class="space-y-1">
      <div v-for="(_, index) in modelValue" :key="index" class="flex items-center gap-1">
        <input
          :aria-label="`${label} ${index + 1}`"
          class="form-input min-w-0 flex-1"
          :max="maximum"
          :min="step"
          required
          :step="step"
          type="number"
          :value="modelValue[index]"
          @input="replace(index, $event.target.value)"
        />
        <button
          :aria-label="`${label} ${index + 1} 上移`"
          class="btn btn-secondary shrink-0 px-2 text-sm"
          :disabled="index === 0"
          type="button"
          @click="move(index, -1)"
        >
          上移
        </button>
        <button
          :aria-label="`${label} ${index + 1} 下移`"
          class="btn btn-secondary shrink-0 px-2 text-sm"
          :disabled="index === modelValue.length - 1"
          type="button"
          @click="move(index, 1)"
        >
          下移
        </button>
        <button
          :aria-label="`${label} ${index + 1} 移除`"
          class="btn btn-secondary shrink-0 px-2 text-sm"
          type="button"
          @click="remove(index)"
        >
          移除
        </button>
      </div>
    </div>
    <p v-if="modelValue.length === 0" class="mb-2 text-sm t-text-secondary">
      未设置快捷值，仍可在弹窗中手动输入。
    </p>
    <button
      class="btn btn-secondary mt-2 px-3 text-sm"
      :disabled="modelValue.length >= 20"
      type="button"
      @click="emit('update:modelValue', [...modelValue, ''])"
    >
      新增{{ label }}
    </button>
  </div>
</template>

<script setup>
const props = defineProps({
  modelValue: { type: Array, required: true },
  label: { type: String, required: true },
  step: { type: Number, required: true },
  maximum: { type: Number, required: true }
})
const emit = defineEmits(['update:modelValue'])
const replace = (index, value) => {
  const values = [...props.modelValue]
  values[index] = value === '' ? '' : Number(value)
  emit('update:modelValue', values)
}
const remove = (index) =>
  emit(
    'update:modelValue',
    props.modelValue.filter((_, i) => i !== index)
  )
const move = (index, offset) => {
  const values = [...props.modelValue]
  const previous = values[index]
  values[index] = values[index + offset]
  values[index + offset] = previous
  emit('update:modelValue', values)
}
</script>
