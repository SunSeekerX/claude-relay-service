<template>
  <ModalTransition>
    <div
      v-if="show"
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-gray-900/50 p-3 backdrop-blur-sm sm:p-4"
    >
      <div class="absolute inset-0" @click="emit('close')" />
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
              <span>{{ accountName || accountId }}</span>
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
          <AccountUsageRecordsPanel
            v-if="accountId"
            :account-id="accountId"
            :account-name="accountName"
            embedded
            :fetch-api="fetchApi"
            :platform="platform"
            :show-header="false"
          />
        </div>
      </div>
    </div>
  </ModalTransition>
</template>

<script setup>
import ModalTransition from '@/components/common/modal_transition.vue'
import AccountUsageRecordsPanel from '@/components/accounts/account_usage_records_panel.vue'

defineProps({
  show: {
    type: Boolean,
    default: false
  },
  accountId: {
    type: String,
    default: ''
  },
  accountName: {
    type: String,
    default: ''
  },
  platform: {
    type: String,
    default: ''
  },
  fetchApi: {
    type: Function,
    default: null
  },
  title: {
    type: String,
    default: '账户请求时间线'
  }
})

const emit = defineEmits(['close'])
</script>
