<template>
  <!-- 全局弹窗壳：统一内边距 / 头-身-底结构 / 底栏吸底 -->
  <ModalTransition @after-leave="emit('after-leave')">
    <div
      v-if="modelValue"
      class="modal fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-3"
      @mousedown.self="onMask"
    >
      <div
        class="modal-content app-dialog mx-auto flex w-full flex-col overflow-hidden"
        :class="sizeClass"
        role="dialog"
        aria-modal="true"
      >
        <!-- 头 -->
        <div v-if="showHeader" class="app-dialog__header">
          <div class="flex min-w-0 items-center gap-2.5">
            <div
              v-if="icon || $slots.icon"
              class="app-dialog__icon"
              :class="iconToneClass"
            >
              <slot name="icon">
                <i :class="icon" />
              </slot>
            </div>
            <div class="min-w-0">
              <h3 v-if="title || $slots.title" class="app-dialog__title">
                <slot name="title">{{ title }}</slot>
              </h3>
              <p v-if="description || $slots.description" class="app-dialog__desc">
                <slot name="description">{{ description }}</slot>
              </p>
            </div>
          </div>
          <button
            v-if="closable"
            class="app-dialog__close"
            type="button"
            title="关闭"
            @click="close"
          >
            <i class="i-lucide-x" />
          </button>
        </div>

        <!-- 身：可滚 -->
        <div class="app-dialog__body custom-scrollbar" :class="bodyClass">
          <slot />
        </div>

        <!-- 底：吸底 -->
        <div v-if="$slots.footer" class="app-dialog__footer">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </ModalTransition>
</template>

<script setup>
import { computed } from 'vue'
import ModalTransition from '@/components/common/modal_transition.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  icon: { type: String, default: '' },
  // blue | green | purple | orange | red | gray
  iconTone: { type: String, default: 'blue' },
  // sm | md | lg | xl | full
  size: { type: String, default: 'md' },
  closable: { type: Boolean, default: true },
  closeOnMask: { type: Boolean, default: true },
  showHeader: { type: Boolean, default: true },
  bodyClass: { type: [String, Array, Object], default: '' }
})

const emit = defineEmits(['update:modelValue', 'close', 'after-leave'])

const sizeClass = computed(() => {
  const map = {
    sm: 'app-dialog--sm',
    md: 'app-dialog--md',
    lg: 'app-dialog--lg',
    xl: 'app-dialog--xl',
    full: 'app-dialog--full'
  }
  return map[props.size] || map.md
})

const iconToneClass = computed(() => `is-${props.iconTone}`)

const close = () => {
  emit('update:modelValue', false)
  emit('close')
}

const onMask = () => {
  if (props.closeOnMask && props.closable) close()
}
</script>

<style scoped>
.app-dialog {
  max-height: min(92dvh, 960px);
  /* 统一紧凑内边距：不再 p-6/p-8 */
  padding: 0;
}

.app-dialog--sm {
  max-width: 24rem; /* 384 */
}
.app-dialog--md {
  max-width: 28rem; /* 448 */
}
.app-dialog--lg {
  max-width: 36rem; /* 576 */
}
.app-dialog--xl {
  max-width: 56rem; /* 896 */
}
.app-dialog--full {
  max-width: 72rem;
}

.app-dialog__header {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 0.875rem 0.625rem;
  border-bottom: 1px solid rgb(229 231 235 / 0.9);
}

.app-dialog__icon {
  display: inline-flex;
  width: 2.25rem;
  height: 2.25rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 0.75rem;
  color: #fff;
  background: linear-gradient(135deg, var(--primary-color, #3b82f6), var(--secondary-color, #6366f1));
}

.app-dialog__icon.is-green {
  background: linear-gradient(135deg, #22c55e, #16a34a);
}
.app-dialog__icon.is-purple {
  background: linear-gradient(135deg, #a855f7, #7c3aed);
}
.app-dialog__icon.is-orange {
  background: linear-gradient(135deg, #f59e0b, #ea580c);
}
.app-dialog__icon.is-red {
  background: linear-gradient(135deg, #ef4444, #dc2626);
}
.app-dialog__icon.is-gray {
  background: linear-gradient(135deg, #6b7280, #4b5563);
}

.app-dialog__title {
  margin: 0;
  overflow: hidden;
  color: rgb(17 24 39);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-dialog__desc {
  margin: 0.15rem 0 0;
  color: rgb(107 114 128);
  font-size: 0.875rem;
  line-height: 1.35;
}

.app-dialog__close {
  display: inline-flex;
  width: 1.75rem;
  height: 1.75rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: rgb(156 163 175);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.app-dialog__close:hover {
  background: rgb(243 244 246);
  color: rgb(75 85 99);
}

.app-dialog__body {
  min-height: 0;
  flex: 1 1 auto;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0.875rem 1rem;
}

.app-dialog__footer {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid rgb(229 231 235 / 0.9);
}
</style>

<style>
html.dark .app-dialog__header,
.dark .app-dialog__header,
html.dark .app-dialog__footer,
.dark .app-dialog__footer {
  border-color: rgb(75 85 99 / 0.65);
}
html.dark .app-dialog__title,
.dark .app-dialog__title {
  color: rgb(243 244 246);
}
html.dark .app-dialog__desc,
.dark .app-dialog__desc {
  color: rgb(156 163 175);
}
html.dark .app-dialog__close:hover,
.dark .app-dialog__close:hover {
  background: rgb(55 65 81);
  color: rgb(209 213 219);
}

/* 底栏按钮约定：配合 AppDialog footer */
.app-dialog__footer .btn,
.app-dialog__footer .toolbar-btn {
  min-height: 2.5rem;
}
</style>
