<template>
  <ModalTransition>
    <div v-if="show" class="modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div
        class="modal-content mx-auto w-full max-w-md rounded-2xl bg-white p-4 shadow-xl dark:bg-gray-800 sm:p-3 sm:p-4"
      >
        <div class="mb-4 flex items-start gap-3">
          <div
            class="confirm-modal__icon"
            :class="{
              'is-danger': type === 'danger',
              'is-warning': type === 'warning'
            }"
          >
            <i
              :class="[
                'text-base text-white',
                type === 'danger'
                  ? 'i-lucide-trash-2'
                  : type === 'warning'
                    ? 'i-lucide-circle-alert'
                    : 'i-lucide-circle-question-mark'
              ]"
            />
          </div>
          <div class="flex-1">
            <h3 class="mb-1.5 text-base font-bold text-gray-900 dark:text-white sm:text-lg">
              {{ title }}
            </h3>
            <p class="whitespace-pre-line text-sm leading-relaxed text-gray-700 dark:text-gray-300">
              {{ message }}
            </p>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
          <button class="toolbar-btn h-10 flex-1 text-sm" type="button" @click="$emit('cancel')">
            {{ cancelText }}
          </button>
          <button
            type="button"
            class="btn h-10 flex-1 text-sm"
            :class="
              type === 'danger' ? 'btn-danger' : type === 'warning' ? 'btn-warning' : 'btn-primary'
            "
            @click="$emit('confirm')"
          >
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </ModalTransition>
</template>

<script setup>
import ModalTransition from '@/components/common/modal_transition.vue'

defineProps({
  show: {
    type: Boolean,
    required: true
  },
  title: {
    type: String,
    default: ''
  },
  message: {
    type: String,
    default: ''
  },
  confirmText: {
    type: String,
    default: '继续'
  },
  cancelText: {
    type: String,
    default: '取消'
  },
  type: {
    type: String,
    default: 'primary', // primary | warning | danger
    validator: (value) => ['primary', 'warning', 'danger'].includes(value)
  }
})

defineEmits(['confirm', 'cancel'])
</script>

<style scoped>
.modal {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
}

:global(.dark) .modal {
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
}

/* 图标底：默认主题渐变，危险/警告用语义色 */
.confirm-modal__icon {
  display: flex;
  width: 2.5rem;
  height: 2.5rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  color: #fff;
  background: linear-gradient(135deg, var(--primary-color) 0%, var(--secondary-color) 100%);
  box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.35);
}
.confirm-modal__icon.is-danger {
  background: linear-gradient(135deg, var(--error-color, #ef4444) 0%, #dc2626 100%);
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.35);
}
.confirm-modal__icon.is-warning {
  background: linear-gradient(135deg, var(--warning-color, #f59e0b) 0%, #ea580c 100%);
  box-shadow: 0 2px 8px rgba(245, 158, 11, 0.35);
}

/* 项目 components.css 无 btn-warning，这里补齐，走主题 warning 变量 */
.btn-warning {
  background: linear-gradient(135deg, var(--warning-color, #f59e0b) 0%, #ea580c 100%);
  color: #fff;
  box-shadow:
    0 10px 15px -3px rgba(245, 158, 11, 0.3),
    0 4px 6px -2px rgba(245, 158, 11, 0.05);
}
.btn-warning:hover {
  transform: translateY(-1px);
  box-shadow:
    0 20px 25px -5px rgba(245, 158, 11, 0.3),
    0 10px 10px -5px rgba(245, 158, 11, 0.1);
}
</style>
