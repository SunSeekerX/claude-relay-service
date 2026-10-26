<template>
  <div class="min-w-0 space-y-3 text-sm">
    <fieldset class="m-0 flex min-w-0 flex-wrap gap-x-5 gap-y-2 border-0 p-0" :disabled="disabled">
      <legend class="mb-2 font-semibold">调用范围</legend>
      <label class="inline-flex cursor-pointer items-center gap-2">
        <input
          :checked="!restricted"
          :name="scopeId"
          type="radio"
          @change="emit('update:restricted', false)"
        />
        不限制
      </label>
      <label class="inline-flex cursor-pointer items-center gap-2">
        <input
          :checked="restricted"
          :name="scopeId"
          type="radio"
          @change="emit('update:restricted', true)"
        />
        仅允许所选
      </label>
    </fieldset>
    <div class="flex flex-wrap items-center justify-between gap-2 text-gray-500 dark:text-gray-400">
      <span>{{
        restricted ? `已选 ${modelValue.length} 个模型` : '允许调用上游支持的所有模型'
      }}</span>
      <span>保存账号后生效</span>
    </div>
    <div class="flex flex-wrap gap-2">
      <input
        v-model="search"
        aria-label="搜索模型"
        class="form-input min-w-0 flex-1 basis-full sm:basis-0"
        placeholder="搜索模型"
        type="search"
      />
      <input
        v-model="customModel"
        aria-label="手动添加模型"
        class="form-input min-w-0 flex-1"
        :disabled="disabled || !restricted"
        placeholder="模型名称，支持 prefix*"
        type="text"
        @keydown.enter.prevent="addModel"
      />
      <button
        class="btn btn-secondary"
        :disabled="disabled || !restricted || !customModel.trim()"
        type="button"
        @click="addModel"
      >
        添加
      </button>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <label class="inline-flex items-center gap-2">
        <input
          :checked="allSelected"
          :disabled="disabled || !restricted || !filtered.length"
          type="checkbox"
          @change="selectVisible($event.target.checked)"
        />
        选择筛选结果
      </label>
      <button
        class="text-blue-600 dark:text-blue-400"
        :disabled="disabled || !restricted || !modelValue.length"
        type="button"
        @click="emit('update:modelValue', [])"
      >
        清空选择
      </button>
      <span class="ml-auto text-gray-500">共 {{ choices.length }} 个候选</span>
    </div>
    <div
      class="custom-scrollbar max-h-72 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-600"
    >
      <label
        v-for="option in filtered"
        :key="option.id"
        class="flex min-w-0 items-center gap-3 border-b border-gray-100 px-3 py-2 last:border-b-0 dark:border-gray-700"
      >
        <input
          :aria-label="`允许模型 ${option.id}`"
          :checked="!restricted || modelValue.includes(option.id)"
          :disabled="disabled || !restricted"
          type="checkbox"
          @change="toggle(option.id, $event.target.checked)"
        />
        <span class="min-w-0 flex-1 break-all font-mono">{{ option.id }}</span>
        <span class="shrink-0 text-gray-500 dark:text-gray-400">{{ option.label }}</span>
      </label>
      <p v-if="!filtered.length" class="px-3 py-5 text-center text-gray-500">
        {{ search ? '没有匹配的模型' : '暂无候选模型，可同步上游或手动添加' }}
      </p>
    </div>
    <p v-if="restricted && !modelValue.length" class="text-red-600 dark:text-red-400" role="alert">
      请至少选择一个模型，或切换为“不限制”。
    </p>
  </div>
</template>

<script setup>
import { computed, ref, useId } from 'vue'
const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  restricted: { type: Boolean, default: false },
  options: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'update:restricted'])
const scopeId = useId()
const search = ref('')
const customModel = ref('')
const addedModels = ref([])
const choices = computed(() => {
  const result = new Map(props.options.map((item) => [item.id, item]))
  for (const id of [...props.modelValue, ...addedModels.value]) {
    if (!result.has(id)) result.set(id, { id, label: '自定义' })
  }
  return [...result.values()]
})
const filtered = computed(() =>
  choices.value.filter((item) => item.id.toLowerCase().includes(search.value.trim().toLowerCase()))
)
const allSelected = computed(
  () =>
    filtered.value.length > 0 &&
    filtered.value.every((item) => !props.restricted || props.modelValue.includes(item.id))
)
const toggle = (model, checked) =>
  emit(
    'update:modelValue',
    checked
      ? [...new Set([...props.modelValue, model])]
      : props.modelValue.filter((item) => item !== model)
  )
const selectVisible = (checked) => {
  const visible = new Set(filtered.value.map((item) => item.id))
  emit(
    'update:modelValue',
    checked
      ? [...new Set([...props.modelValue, ...visible])]
      : props.modelValue.filter((model) => !visible.has(model))
  )
}
const addModel = () => {
  const id = customModel.value.trim()
  if (!id || props.disabled || !props.restricted) return
  addedModels.value = [...new Set([...addedModels.value, id])]
  if (props.restricted) toggle(id, true)
  customModel.value = ''
}
</script>
