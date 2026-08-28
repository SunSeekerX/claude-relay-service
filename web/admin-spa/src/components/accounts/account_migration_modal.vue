<template>
  <ModalTransition>
    <div
      v-if="show"
      class="modal fixed inset-0 z-50 flex items-center justify-center p-3"
      @click.self="close"
    >
      <div
        class="modal-content mx-auto flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-gray-800"
      >
        <!-- 头：标题单独一行 -->
        <div
          class="flex shrink-0 items-center justify-between border-b border-gray-100 px-3 py-2.5 dark:border-gray-700"
        >
          <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100">账户导入 / 导出</h3>
          <button
            class="inline-flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            type="button"
            @click="close"
          >
            <i class="i-lucide-x text-base" />
          </button>
        </div>

        <!-- Tab 在标题下方 -->
        <div class="shrink-0 border-b border-gray-100 px-3 py-2 dark:border-gray-700">
          <div class="flex rounded-lg bg-gray-100 p-0.5 dark:bg-gray-700/80">
            <button
              class="inline-flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium transition"
              :class="
                activeTab === 'export'
                  ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-800 dark:text-blue-300'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
              "
              type="button"
              @click="activeTab = 'export'"
            >
              <i class="i-lucide-download" />
              导出
            </button>
            <button
              class="inline-flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium transition"
              :class="
                activeTab === 'import'
                  ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-800 dark:text-blue-300'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
              "
              type="button"
              @click="activeTab = 'import'"
            >
              <i class="i-lucide-upload" />
              导入
            </button>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-3">
          <ExportPanel v-if="activeTab === 'export'" :selected-ids="selectedIds" />
          <ImportPanel v-else @imported="emit('imported')" />
        </div>
      </div>
    </div>
  </ModalTransition>
</template>

<script setup>
import { ref } from 'vue'

import ModalTransition from '@/components/common/modal_transition.vue'
import ExportPanel from '@/components/accounts/migration/export_panel.vue'
import ImportPanel from '@/components/accounts/migration/import_panel.vue'

defineProps({
  show: { type: Boolean, default: false },
  selectedIds: { type: Array, default: () => [] }
})

const emit = defineEmits(['close', 'imported'])
const activeTab = ref('export')
const close = () => emit('close')
</script>
