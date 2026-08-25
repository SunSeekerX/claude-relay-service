<template>
  <div
    class="app-date-range flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
    :style="width ? { width } : undefined"
  >
    <i class="fas fa-calendar-alt text-gray-400" />
    <input
      class="min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none dark:text-gray-100"
      :max="endLocal || undefined"
      type="datetime-local"
      :value="startLocal"
      @change="onStart"
    />
    <span class="text-sm text-gray-400">至</span>
    <input
      class="min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none dark:text-gray-100"
      :min="startLocal || undefined"
      type="datetime-local"
      :value="endLocal"
      @change="onEnd"
    />
    <button
      v-if="clearable && (startLocal || endLocal)"
      class="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
      type="button"
      @click="clear"
    >
      <i class="fas fa-times" />
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'

// modelValue: [start, end] 字符串 'YYYY-MM-DD HH:mm:ss' 或 Date/可解析值；空为 null
const props = defineProps({
  modelValue: { type: [Array, null], default: null },
  clearable: { type: Boolean, default: true },
  width: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'change'])

const toLocalInput = (value) => {
  if (value == null || value === '') return ''
  // 已是 datetime-local
  if (typeof value === 'string' && value.includes('T') && value.length >= 16) {
    return value.slice(0, 16)
  }
  // 'YYYY-MM-DD HH:mm:ss'
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} /.test(value)) {
    return value.replace(' ', 'T').slice(0, 16)
  }
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const toStore = (local) => {
  if (!local) return ''
  // datetime-local → YYYY-MM-DD HH:mm:ss
  const [d, t] = local.split('T')
  if (!d || !t) return ''
  const time = t.length === 5 ? `${t}:00` : t
  return `${d} ${time}`
}

const startLocal = computed(() => {
  const range = Array.isArray(props.modelValue) ? props.modelValue : null
  return toLocalInput(range?.[0])
})
const endLocal = computed(() => {
  const range = Array.isArray(props.modelValue) ? props.modelValue : null
  return toLocalInput(range?.[1])
})

const emitRange = (start, end) => {
  if (!start && !end) {
    emit('update:modelValue', null)
    emit('change', null)
    return
  }
  const next = [start || '', end || '']
  emit('update:modelValue', next)
  emit('change', next)
}

const onStart = (event) => {
  const start = toStore(event.target.value)
  const end = Array.isArray(props.modelValue) ? props.modelValue[1] || '' : ''
  emitRange(start, typeof end === 'string' && end.includes('T') ? toStore(end) : end)
}
const onEnd = (event) => {
  const end = toStore(event.target.value)
  const start = Array.isArray(props.modelValue) ? props.modelValue[0] || '' : ''
  emitRange(typeof start === 'string' && start.includes('T') ? toStore(start) : start, end)
}
const clear = () => emitRange('', '')
</script>
