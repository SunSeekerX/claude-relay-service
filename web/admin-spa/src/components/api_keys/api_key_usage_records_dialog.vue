<template>
  <ModalTransition>
    <div
      v-if="show"
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-gray-900/50 p-3 backdrop-blur-sm sm:p-4"
    >
      <div class="absolute inset-0" @click="emit('close')" />
      <!-- 视口高度锁定：头固定、身 flex 吃满剩余，日期面板不被矮 max-h 裁切 -->
      <div
        class="modal-panel relative z-10 flex h-[min(92dvh,960px)] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-gray-200/70 bg-white shadow-2xl dark:border-gray-700/60 dark:bg-gray-900"
      >
        <div
          class="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-2.5 dark:border-gray-800"
        >
          <div class="min-w-0">
            <h3 class="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
              <span class="text-gray-500 dark:text-gray-400">{{ title }}</span>
              <span class="mx-1.5 text-gray-300 dark:text-gray-600">/</span>
              <span>{{ apiKeyName || keyId }}</span>
            </h3>
          </div>
          <button
            class="rounded-full p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
            type="button"
            @click="emit('close')"
          >
            <i class="i-lucide-x text-base" />
          </button>
        </div>

        <div class="flex min-h-0 flex-1 flex-col overflow-hidden p-3 sm:p-4">
          <ApiKeyUsageRecordsPanel
            class="min-h-0 flex-1"
            :api-key-name="apiKeyName"
            :fetch-api="fetchApi"
            :key-id="keyId"
            :show-account-column="showAccountColumn"
            :show-account-filter="showAccountFilter"
            :show-header="false"
            table-body-class="min-h-0 flex-1 overflow-auto"
          />
        </div>
      </div>
    </div>
  </ModalTransition>
</template>

<script setup>
import ModalTransition from '@/components/common/modal_transition.vue'
import ApiKeyUsageRecordsPanel from '@/components/api_keys/api_key_usage_records_panel.vue'

defineProps({
  show: {
    type: Boolean,
    default: false
  },
  keyId: {
    type: String,
    required: true
  },
  apiKeyName: {
    type: String,
    default: ''
  },
  fetchApi: {
    type: Function,
    required: true
  },
  title: {
    type: String,
    default: 'API Key 请求详情时间线'
  },
  showAccountColumn: {
    type: Boolean,
    default: true
  },
  showAccountFilter: {
    type: Boolean,
    default: true
  }
})

const emit = defineEmits(['close'])
</script>
