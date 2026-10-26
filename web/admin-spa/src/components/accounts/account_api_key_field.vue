<template>
  <div class="space-y-2 text-sm">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <label class="font-semibold text-gray-700 dark:text-gray-300" :for="inputId"
        >{{ label }}{{ editing ? '' : ' *' }}</label
      >
      <button
        v-if="editing"
        class="text-blue-600 hover:underline dark:text-blue-400"
        type="button"
        @click="toggleReplacement"
      >
        {{ replaceEnabled ? '取消更换' : '更换 Key' }}
      </button>
    </div>
    <div class="relative">
      <input
        :id="inputId"
        autocomplete="new-password"
        class="form-input form-input--with-icon w-full"
        :class="{ 'border-red-500': error }"
        :disabled="!editable"
        :name="inputId"
        :placeholder="editable ? placeholder : '已保存；普通编辑不会更换 Key'"
        :required="editable"
        :spellcheck="false"
        :type="showKey ? 'text' : 'password'"
        :value="editable ? modelValue : ''"
        @input="updateValue"
      />
      <button
        :aria-label="showKey ? '隐藏 Key' : '显示 Key'"
        class="password-toggle"
        :disabled="!editable"
        type="button"
        @click="showKey = !showKey"
      >
        <i :class="showKey ? 'i-lucide-eye-off' : 'i-lucide-eye'" />
      </button>
    </div>
    <p v-if="error" class="text-red-600 dark:text-red-400" role="alert">{{ error }}</p>
    <p v-else-if="editing && replaceEnabled" class="text-amber-700 dark:text-amber-400">
      保存后替换原 Key，请确认填写的是上游 API Key。
    </p>
  </div>
</template>

<script setup>
import { computed, ref, useId, watch } from 'vue'
const props = defineProps({
  modelValue: { type: String, default: '' },
  replaceEnabled: { type: Boolean, default: false },
  editing: { type: Boolean, default: false },
  label: { type: String, default: 'API Key' },
  placeholder: { type: String, default: '输入上游 API Key' },
  error: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'update:replaceEnabled'])
const inputId = `upstream-key-${useId()}`
const showKey = ref(false)
const editable = computed(() => !props.editing || props.replaceEnabled)
const toggleReplacement = () => {
  showKey.value = false
  emit('update:modelValue', '')
  emit('update:replaceEnabled', !props.replaceEnabled)
}
const updateValue = (event) => {
  if (editable.value) emit('update:modelValue', event.target.value)
}
watch(
  () => props.replaceEnabled,
  () => {
    showKey.value = false
  }
)
</script>
