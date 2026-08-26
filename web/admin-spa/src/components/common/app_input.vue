<template>
  <!-- 无边框输入：底色 + focus ring；样式走全局 .form-input -->
  <div v-if="prefixIcon || $slots.prefix || $slots.suffix || clearable" class="app-input-wrap" :class="wrapClass">
    <span v-if="prefixIcon || $slots.prefix" class="app-input-wrap__prefix">
      <slot name="prefix">
        <i v-if="prefixIcon" :class="prefixIcon" />
      </slot>
    </span>
    <input
      ref="inputRef"
      class="form-input app-input"
      :class="[inputClass, { 'has-prefix': prefixIcon || $slots.prefix, 'has-suffix': clearable || $slots.suffix }]"
      :disabled="disabled"
      :max="max"
      :min="min"
      :placeholder="placeholder"
      :readonly="readonly"
      :step="step"
      :type="type"
      :value="modelValue"
      v-bind="attrs"
      @blur="emit('blur', $event)"
      @focus="emit('focus', $event)"
      @input="onInput"
      @keydown="emit('keydown', $event)"
      @keyup.enter="emit('enter', $event)"
    />
    <button
      v-if="clearable && hasValue && !disabled"
      class="app-input-wrap__clear"
      type="button"
      title="清除"
      @click="onClear"
    >
      <i class="i-lucide-x" />
    </button>
    <span v-if="$slots.suffix" class="app-input-wrap__suffix">
      <slot name="suffix" />
    </span>
  </div>
  <input
    v-else
    ref="inputRef"
    class="form-input app-input w-full"
    :class="inputClass"
    :disabled="disabled"
    :max="max"
    :min="min"
    :placeholder="placeholder"
    :readonly="readonly"
    :step="step"
    :type="type"
    :value="modelValue"
    v-bind="attrs"
    @blur="emit('blur', $event)"
    @focus="emit('focus', $event)"
    @input="onInput"
    @keydown="emit('keydown', $event)"
    @keyup.enter="emit('enter', $event)"
  />
</template>

<script setup>
import { computed, ref, useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  type: { type: String, default: 'text' },
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  clearable: { type: Boolean, default: false },
  prefixIcon: { type: String, default: '' },
  min: { type: [String, Number], default: undefined },
  max: { type: [String, Number], default: undefined },
  step: { type: [String, Number], default: undefined },
  inputClass: { type: [String, Array, Object], default: '' },
  wrapClass: { type: [String, Array, Object], default: '' }
})

const emit = defineEmits(['update:modelValue', 'input', 'change', 'blur', 'focus', 'keydown', 'enter', 'clear'])
const attrs = useAttrs()
const inputRef = ref(null)

const hasValue = computed(() => props.modelValue !== '' && props.modelValue !== null && props.modelValue !== undefined)

const onInput = (event) => {
  const raw = event.target.value
  const next = props.type === 'number' && raw !== '' ? Number(raw) : raw
  emit('update:modelValue', next)
  emit('input', next)
  emit('change', next)
}

const onClear = () => {
  emit('update:modelValue', props.type === 'number' ? null : '')
  emit('clear')
  inputRef.value?.focus?.()
}

defineExpose({ focus: () => inputRef.value?.focus?.() })
</script>

<style scoped>
.app-input-wrap {
  position: relative;
  display: block;
  width: 100%;
}
.app-input-wrap .app-input {
  width: 100%;
}
.app-input-wrap .app-input.has-prefix {
  padding-left: 2.25rem;
}
.app-input-wrap .app-input.has-suffix {
  padding-right: 2.25rem;
}
.app-input-wrap__prefix {
  position: absolute;
  top: 50%;
  left: 0.75rem;
  z-index: 1;
  display: inline-flex;
  color: var(--text-muted, #9ca3af);
  transform: translateY(-50%);
  pointer-events: none;
}
.app-input-wrap__suffix {
  position: absolute;
  top: 50%;
  right: 0.75rem;
  z-index: 1;
  display: inline-flex;
  transform: translateY(-50%);
}
.app-input-wrap__clear {
  position: absolute;
  top: 50%;
  right: 0.5rem;
  z-index: 1;
  display: inline-flex;
  width: 1.25rem;
  height: 1.25rem;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 9999px;
  background: transparent;
  color: var(--text-muted, #9ca3af);
  transform: translateY(-50%);
  cursor: pointer;
}
.app-input-wrap__clear:hover {
  background: color-mix(in srgb, var(--text-muted, #9ca3af) 16%, transparent);
  color: var(--text-primary, #111827);
}
</style>
