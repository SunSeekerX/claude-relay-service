<template>
  <section class="rounded-xl border border-gray-200 p-3 text-sm dark:border-gray-700">
    <div class="mb-2 flex items-center justify-between gap-2">
      <h3 class="font-semibold text-gray-800 dark:text-gray-100">调用入口授权</h3>
      <button
        class="btn btn-secondary px-2 py-1 text-sm"
        :disabled="loading || disabled"
        type="button"
        @click="load"
      >
        刷新入口
      </button>
    </div>
    <p class="mb-3 text-gray-500 dark:text-gray-400">
      勾选此 Key 可使用的入口；每种接口格式可设置一个默认入口。未设置时沿用现有账号绑定。
    </p>
    <p v-if="error" class="mb-3 text-red-600 dark:text-red-400">{{ error }}</p>
    <p v-if="loading" class="py-2 text-gray-500">正在加载入口...</p>
    <div v-else class="max-h-52 space-y-2 overflow-y-auto">
      <label
        v-for="route in displayedRoutes"
        :key="route.code"
        class="flex cursor-pointer items-center gap-2 rounded-lg bg-gray-50 p-2 dark:bg-gray-800"
      >
        <input
          :checked="routing.allowedRoutes.includes(route.code)"
          class="h-4 w-4"
          :disabled="disabled"
          type="checkbox"
          @change="toggleRoute(route.code, $event.target.checked)"
        />
        <span class="min-w-0 flex-1"
          ><span class="font-medium">{{ route.name }}</span
          ><span class="ml-2 text-gray-500">{{ route.code }}</span></span
        >
        <span class="text-gray-500">{{
          route.missing ? '已删除' : route.isActive ? '已启用' : '已停用'
        }}</span>
      </label>
      <p v-if="displayedRoutes.length === 0" class="py-2 text-gray-500">
        暂无调用入口，可在 API Keys 的“调用入口”页创建。
      </p>
    </div>
    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <div v-for="format in formats" :key="format.value">
        <label class="mb-1 block text-gray-600 dark:text-gray-300"
          >{{ format.label }} 默认入口</label
        >
        <CustomDropdown
          :disabled="disabled"
          :model-value="routing.defaults[format.value] ?? ''"
          :options="defaultOptions(format.value)"
          @update:model-value="setDefault(format.value, $event)"
        />
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import CustomDropdown from '@/components/common/custom_dropdown.vue'
import { getRelayRoutesApi } from '@/libs/http_apis'
import { parseKeyRouting } from '@/libs/relay_routing'
import { isOk } from '@/libs/http_envelope'

const props = defineProps({
  modelValue: { type: [Object, String], default: undefined },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])
const routes = ref([])
const formats = ref([
  { value: 'claude-messages', label: 'Claude Messages' },
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'gemini-generate', label: 'Gemini generateContent' }
])
const loading = ref(false)
const error = ref('')
const routing = computed(() => parseKeyRouting(props.modelValue))
const displayedRoutes = computed(() => [
  ...routes.value,
  ...routing.value.allowedRoutes
    .filter((code) => !routes.value.some((route) => route.code === code))
    .map((code) => ({ code, name: code, missing: true }))
])
const load = async () => {
  loading.value = true
  error.value = ''
  try {
    const response = await getRelayRoutesApi()
    if (!isOk(response)) throw new Error(response.msg)
    routes.value = response.data.routes
    formats.value = response.data.formats
  } catch (cause) {
    error.value = cause.message
  } finally {
    loading.value = false
  }
}
const toggleRoute = (code, selected) => {
  const value = routing.value
  value.allowedRoutes = selected
    ? [...value.allowedRoutes, code]
    : value.allowedRoutes.filter((item) => item !== code)
  if (!selected)
    for (const [format, entry] of Object.entries(value.defaults))
      if (entry === code) delete value.defaults[format]
  emit('update:modelValue', value)
}
const defaultOptions = (format) => {
  const selected = routing.value.defaults[format]
  const choices = routes.value.filter(
    (route) => routing.value.allowedRoutes.includes(route.code) && route.formats.includes(format)
  )
  const options = [
    { value: '', label: '沿用原有账号绑定' },
    ...choices.map((route) => ({
      value: route.code,
      label: `${route.name}${route.isActive ? '' : '（已停用）'}`
    }))
  ]
  if (selected && !options.some((option) => option.value === selected))
    options.push({ value: selected, label: `${selected}（不可用）` })
  return options
}
const setDefault = (format, code) => {
  const value = routing.value
  if (code) value.defaults[format] = code
  else delete value.defaults[format]
  emit('update:modelValue', value)
}
onMounted(load)
</script>
