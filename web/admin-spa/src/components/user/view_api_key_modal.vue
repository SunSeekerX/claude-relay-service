<template>
  <ModalTransition>
    <div
      v-if="show"
      class="fixed inset-0 z-50 h-full w-full overflow-y-auto bg-gray-600 bg-opacity-50 dark:bg-gray-900 dark:bg-opacity-70"
    >
      <div
        class="modal-panel relative top-20 mx-auto w-[768px] max-w-4xl rounded-md border border-gray-200 bg-white p-5 shadow-lg dark:border-gray-700 dark:bg-gray-800"
      >
        <div class="mt-3">
          <div class="mb-4 flex items-center justify-between">
            <h3 class="text-lg font-medium text-gray-900 dark:text-gray-100">API Key Details</h3>
            <button
              aria-label="Close dialog"
              class="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              @click="emit('close')"
            >
              <i aria-hidden="true" class="i-lucide-x h-6 w-6" />
            </button>
          </div>

          <div v-if="apiKey" class="space-y-4">
            <!-- API Key Name -->
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-200">Name</label>
              <p class="mt-1 text-sm text-gray-900 dark:text-gray-100">{{ apiKey.name }}</p>
            </div>

            <!-- Description -->
            <div v-if="apiKey.description">
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-200"
                >Description</label
              >
              <p class="mt-1 text-sm text-gray-900 dark:text-gray-100">{{ apiKey.description }}</p>
            </div>

            <!-- API Key -->
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-200"
                >API Key</label
              >
              <div class="mt-1 flex items-center space-x-2">
                <div class="flex-1">
                  <div
                    v-if="showFullKey"
                    class="rounded-md border border-gray-300 bg-gray-50 p-3 dark:border-gray-600 dark:bg-gray-900/40"
                  >
                    <code class="break-all font-mono text-sm text-gray-900 dark:text-gray-100">{{
                      apiKey.key || 'Not available'
                    }}</code>
                  </div>
                  <div
                    v-else
                    class="rounded-md border border-gray-300 bg-gray-50 p-3 dark:border-gray-600 dark:bg-gray-900/40"
                  >
                    <code class="font-mono text-sm text-gray-900 dark:text-gray-100">{{
                      apiKey.keyPreview || 'cr_****'
                    }}</code>
                  </div>
                </div>
                <div class="flex flex-col space-y-1">
                  <button
                    v-if="apiKey.key"
                    class="inline-flex items-center rounded border border-gray-300 bg-white px-2 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 dark:focus:ring-offset-gray-800"
                    @click="showFullKey = !showFullKey"
                  >
                    <i
                      v-if="showFullKey"
                      aria-hidden="true"
                      class="i-lucide-eye-off mr-1 h-3 w-3"
                    />
                    <i v-else aria-hidden="true" class="i-lucide-eye mr-1 h-3 w-3" />
                    {{ showFullKey ? 'Hide' : 'Show' }}
                  </button>
                  <button
                    v-if="showFullKey && apiKey.key"
                    class="inline-flex items-center rounded border border-gray-300 bg-white px-2 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 dark:focus:ring-offset-gray-800"
                    @click="copyToClipboard(apiKey.key)"
                  >
                    <i aria-hidden="true" class="i-lucide-copy mr-1 h-3 w-3" />
                    Copy
                  </button>
                </div>
              </div>
              <p v-if="!apiKey.key" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Full API key is only shown when first created or regenerated
              </p>
            </div>

            <!-- Status -->
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-200"
                >Status</label
              >
              <div class="mt-1">
                <span
                  :class="[
                    'inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium',
                    apiKey.isActive
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                      : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                  ]"
                >
                  {{ apiKey.isActive ? 'Active' : 'Disabled' }}
                </span>
              </div>
            </div>

            <!-- Usage Stats -->
            <div v-if="apiKey.usage" class="border-t border-gray-200 pt-4 dark:border-gray-700">
              <label class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200"
                >Usage Statistics</label
              >
              <div class="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span class="text-gray-500 dark:text-gray-400">Requests:</span>
                  <span class="ml-2 font-medium text-gray-900 dark:text-gray-100">{{
                    formatNumber(apiKey.usage.requests || 0)
                  }}</span>
                </div>
                <div>
                  <span class="text-gray-500 dark:text-gray-400">Input Tokens:</span>
                  <span class="ml-2 font-medium text-gray-900 dark:text-gray-100">{{
                    formatNumber(apiKey.usage.inputTokens || 0)
                  }}</span>
                </div>
                <div>
                  <span class="text-gray-500 dark:text-gray-400">Output Tokens:</span>
                  <span class="ml-2 font-medium text-gray-900 dark:text-gray-100">{{
                    formatNumber(apiKey.usage.outputTokens || 0)
                  }}</span>
                </div>
                <div>
                  <span class="text-gray-500 dark:text-gray-400">Total Cost:</span>
                  <span class="ml-2 font-medium text-gray-900 dark:text-gray-100"
                    >${{ (apiKey.usage.totalCost || 0).toFixed(4) }}</span
                  >
                </div>
              </div>
            </div>

            <!-- Timestamps -->
            <div class="space-y-2 border-t border-gray-200 pt-4 text-sm dark:border-gray-700">
              <div class="flex justify-between">
                <span class="text-gray-500 dark:text-gray-400">Created:</span>
                <span class="text-gray-900 dark:text-gray-100">{{
                  formatDate(apiKey.createdAt)
                }}</span>
              </div>
              <div v-if="apiKey.lastUsedAt" class="flex justify-between">
                <span class="text-gray-500 dark:text-gray-400">Last Used:</span>
                <span class="text-gray-900 dark:text-gray-100">{{
                  formatDate(apiKey.lastUsedAt)
                }}</span>
              </div>
              <div v-if="apiKey.expiresAt" class="flex justify-between">
                <span class="text-gray-500 dark:text-gray-400">Expires:</span>
                <span
                  :class="[
                    'font-medium',
                    new Date(apiKey.expiresAt) < new Date()
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-gray-900 dark:text-gray-100'
                  ]"
                >
                  {{ formatDate(apiKey.expiresAt) }}
                </span>
              </div>
            </div>

            <div class="flex justify-end pt-4">
              <button
                class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700 dark:focus:ring-offset-gray-800"
                @click="emit('close')"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </ModalTransition>
</template>

<script setup>
import { ref } from 'vue'

import ModalTransition from '@/components/common/modal_transition.vue'
import { showToast, formatNumber, formatDate } from '@/libs/tools'

defineProps({
  show: {
    type: Boolean,
    default: false
  },
  apiKey: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['close'])

const showFullKey = ref(false)

const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text)
    showToast('Copied to clipboard!', 'success')
  } catch (err) {
    console.error('Failed to copy:', err)
    showToast('Failed to copy to clipboard', 'error')
  }
}
</script>
