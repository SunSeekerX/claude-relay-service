<template>
  <div class="flex min-w-0 flex-wrap items-center justify-end gap-2">
    <slot name="before" />
    <button
      v-if="showCancel"
      class="btn btn-secondary h-10 shrink-0 whitespace-nowrap px-4 text-sm disabled:opacity-60"
      :disabled="loading"
      type="button"
      @click="emit('cancel')"
    >
      取消
    </button>
    <button
      class="btn btn-primary inline-flex h-10 shrink-0 items-center justify-center whitespace-nowrap px-4 text-sm disabled:opacity-60"
      :disabled="disabled || loading"
      :form="form"
      type="submit"
      @click.prevent="save(false, $event)"
    >
      <i v-if="loading && !pendingClose" class="i-lucide-loader-circle mr-1 animate-spin" />
      {{ loading && !pendingClose ? '保存中...' : '保存' }}
    </button>
    <button
      class="btn btn-primary inline-flex h-10 shrink-0 items-center justify-center whitespace-nowrap px-4 text-sm disabled:opacity-60"
      :disabled="disabled || loading"
      :form="form"
      type="submit"
      @click.prevent="save(true, $event)"
    >
      <i v-if="loading && pendingClose" class="i-lucide-loader-circle mr-1 animate-spin" />
      {{ loading && pendingClose ? '保存中...' : '保存并关闭' }}
    </button>
    <slot name="after" />
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  showCancel: { type: Boolean, default: true },
  form: { type: String, default: undefined }
})
const emit = defineEmits(['save', 'cancel'])
const pendingClose = ref(false)

const save = (closeAfter, event) => {
  if (props.loading || props.disabled) return
  if (event.currentTarget.form && !event.currentTarget.form.reportValidity()) return
  pendingClose.value = closeAfter
  emit('save', closeAfter)
}
</script>
