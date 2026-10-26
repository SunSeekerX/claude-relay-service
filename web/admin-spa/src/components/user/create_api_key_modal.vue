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
            <h3 class="text-lg font-medium text-gray-900 dark:text-gray-100">Create New API Key</h3>
            <button
              aria-label="Close dialog"
              class="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              @click="$emit('close')"
            >
              <i aria-hidden="true" class="i-lucide-x h-6 w-6" />
            </button>
          </div>

          <form class="space-y-4" @submit.prevent="handleSubmit(false)">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-200" for="name">
                Name *
              </label>
              <input
                id="name"
                v-model="form.name"
                class="form-input w-full mt-1"
                :disabled="loading || !!newApiKey"
                placeholder="Enter API key name"
                required
                type="text"
              />
            </div>

            <div>
              <label
                class="block text-sm font-medium text-gray-700 dark:text-gray-200"
                for="description"
              >
                Description
              </label>
              <textarea
                id="description"
                v-model="form.description"
                class="form-input w-full mt-1"
                :disabled="loading || !!newApiKey"
                placeholder="Optional description"
                rows="3"
              ></textarea>
            </div>

            <div
              v-if="error"
              class="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20"
            >
              <div class="flex">
                <div class="flex-shrink-0">
                  <i aria-hidden="true" class="i-lucide-circle-x h-5 w-5 text-red-400" />
                </div>
                <div class="ml-3">
                  <p class="text-sm text-red-700 dark:text-red-300">{{ error }}</p>
                </div>
              </div>
            </div>

            <div class="flex justify-end gap-2 pt-2.5">
              <DialogSaveActions
                :disabled="!form.name.trim()"
                :loading="loading"
                @cancel="emit('close')"
                @save="handleSubmit"
              />
            </div>
          </form>

          <!-- Success Modal for showing the new API key -->
          <div
            v-if="newApiKey"
            class="mt-6 rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/20"
          >
            <div class="flex items-start">
              <div class="flex-shrink-0">
                <i aria-hidden="true" class="i-lucide-circle-check h-5 w-5 text-green-400" />
              </div>
              <div class="ml-3 flex-1">
                <h4 class="text-sm font-medium text-green-800 dark:text-green-300">
                  API Key Created Successfully!
                </h4>
                <div class="mt-3">
                  <p class="mb-2 text-sm text-green-700 dark:text-green-300">
                    <strong>Important:</strong> Copy your API key now. You won't be able to see it
                    again!
                  </p>
                  <div
                    class="rounded-md border border-green-300 bg-white p-3 dark:border-green-700 dark:bg-gray-800"
                  >
                    <div class="flex items-center justify-between">
                      <code class="break-all font-mono text-sm text-gray-900 dark:text-gray-100">{{
                        newApiKey.key
                      }}</code>
                      <button
                        class="ml-3 inline-flex flex-shrink-0 items-center rounded border border-transparent bg-green-100 px-2 py-1 text-sm font-medium text-green-700 hover:bg-green-200 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 dark:bg-green-900/40 dark:text-green-300 dark:hover:bg-green-900/60 dark:focus:ring-offset-gray-800"
                        @click="copyToClipboard(newApiKey.key)"
                      >
                        <i aria-hidden="true" class="i-lucide-copy mr-1 h-3 w-3" />
                        Copy
                      </button>
                    </div>
                  </div>
                </div>
                <div class="mt-4 flex justify-end">
                  <button
                    class="rounded-md border border-transparent bg-green-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
                    @click="handleClose"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </ModalTransition>
</template>

<script setup>
import { ref, reactive, watch } from 'vue'

import ModalTransition from '@/components/common/modal_transition.vue'
import { useUserStore } from '@/stores/user'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast } from '@/libs/tools'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close', 'created'])

const userStore = useUserStore()

const loading = ref(false)
const error = ref('')
const newApiKey = ref(null)

const form = reactive({
  name: '',
  description: ''
})

const resetForm = () => {
  form.name = ''
  form.description = ''
  error.value = ''
  newApiKey.value = null
}

const handleSubmit = async (closeAfter = false) => {
  if (newApiKey.value) {
    if (closeAfter) handleClose()
    return
  }
  if (!form.name.trim()) {
    error.value = 'API key name is required'
    return
  }

  loading.value = true
  error.value = ''

  try {
    const apiKeyData = {
      name: form.name.trim(),
      description: form.description.trim() || undefined
    }

    const result = await userStore.createApiKey(apiKeyData)

    if (isOk(result)) {
      newApiKey.value = result.data.apiKey
      showToast('API key created successfully!', 'success')
      emit('created', newApiKey.value, closeAfter)
      if (closeAfter) emit('close')
    } else {
      error.value = msgOf(result, 'Failed to create API key')
    }
  } catch (err) {
    console.error('Create API key error:', err)
    error.value = err.response?.data?.message || err.message || 'Failed to create API key'
  } finally {
    loading.value = false
  }
}

const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text)
    showToast('API key copied to clipboard!', 'success')
  } catch (err) {
    console.error('Failed to copy:', err)
    showToast('Failed to copy to clipboard', 'error')
  }
}

const handleClose = () => {
  resetForm()
  emit('close')
}

// Reset form when modal is shown
watch(
  () => props.show,
  (newValue) => {
    if (newValue) {
      resetForm()
    }
  }
)
</script>
