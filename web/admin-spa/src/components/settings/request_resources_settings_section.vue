<template>
  <section class="max-w-3xl rounded-xl border p-4" style="border-color: var(--divider-color)">
    <h3 class="mb-2 text-base font-semibold t-text">实例资源保护</h3>
    <p class="mb-4 text-sm t-text-secondary">
      两项默认均不限制。填写正整数启用对应上限，保存后动态生效；已有请求继续完成。
    </p>
    <p v-if="loading" class="mb-3 text-sm t-text-secondary" role="status">正在加载配置...</p>
    <p v-if="loadError" class="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">
      {{ loadError }}
    </p>
    <form @submit.prevent="save">
      <fieldset
        class="grid grid-cols-1 gap-4 border-0 p-0 sm:grid-cols-2"
        :disabled="!ready || loading || saving"
      >
        <label class="block text-sm t-text">
          <span class="mb-1 block font-medium">最大在途请求数</span>
          <input
            v-model.number="form.maxRequests"
            aria-describedby="request-count-help"
            class="form-input block w-full"
            min="0"
            required
            step="1"
            type="number"
          />
          <span id="request-count-help" class="mt-1 block t-text-secondary"
            >0 表示不限制；单位：个。</span
          >
        </label>
        <label class="block text-sm t-text">
          <span class="mb-1 block font-medium">在途请求体总预算（MiB）</span>
          <input
            v-model.number="form.maxInflightBodyMiB"
            aria-describedby="request-body-help"
            class="form-input block w-full"
            min="0"
            required
            step="1"
            type="number"
          />
          <span id="request-body-help" class="mt-1 block t-text-secondary"
            >0 表示不限制；按解压后的正文大小计算。</span
          >
        </label>
      </fieldset>
      <p class="mt-3 text-sm t-text-secondary">
        上限分别作用于每个服务进程，与 Key、账户并发限制同时生效。容量不足时返回
        503，客户端可稍后重试。
      </p>
      <div class="mt-4 flex flex-wrap items-center gap-1">
        <button
          class="btn btn-primary h-9 px-3 text-sm"
          :disabled="!ready || loading || saving || !dirty"
          type="submit"
        >
          <i
            class="mr-1.5"
            :class="saving ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-save'"
          />
          {{ saving ? '保存中...' : '保存设置' }}
        </button>
        <button
          class="btn btn-secondary h-9 px-3 text-sm"
          :disabled="loading || saving || dirty"
          type="button"
          @click="load"
        >
          <i class="i-lucide-refresh-cw mr-1.5" />
          重新加载
        </button>
        <span v-if="dirty" class="ml-2 text-sm t-text-secondary">有未保存的修改</span>
      </div>
    </form>
    <div
      v-if="ready"
      class="mt-4 border-t pt-3 text-sm t-text-secondary"
      style="border-color: var(--divider-color)"
    >
      <div class="flex flex-wrap gap-x-4 gap-y-1">
        <span>当前请求：{{ runtime.activeRequests }} 个</span>
        <span>当前正文预留：{{ bodyMiB }} MiB</span>
      </div>
      <p class="mt-1">运行用量在重新加载时刷新；请求体预算不等同于服务总内存。</p>
      <p v-if="saved.updatedAt" class="mt-1">
        最后更新：{{ settingsStore.formatDateTime(saved.updatedAt)
        }}<span v-if="saved.updatedBy"> · {{ saved.updatedBy }}</span>
      </p>
    </div>
  </section>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { getRequestResourcesApi, updateRequestResourcesApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast } from '@/libs/tools'
import { useSettingsStore } from '@/stores/settings'

const settingsStore = useSettingsStore()
const controller = new AbortController()
const loading = ref(true)
const saving = ref(false)
const ready = ref(false)
const loadError = ref('')
const form = reactive({ maxRequests: 0, maxInflightBodyMiB: 0 })
const saved = ref({ maxRequests: 0, maxInflightBodyMiB: 0, updatedAt: null, updatedBy: null })
const runtime = ref({ activeRequests: 0, activeBodyBytes: 0 })
const dirty = computed(
  () =>
    form.maxRequests !== saved.value.maxRequests ||
    form.maxInflightBodyMiB !== saved.value.maxInflightBodyMiB
)
const bodyMiB = computed(() =>
  (runtime.value.activeBodyBytes / 1024 / 1024).toLocaleString(undefined, {
    maximumFractionDigits: 1
  })
)

const apply = (data) => {
  saved.value = data.config
  form.maxRequests = data.config.maxRequests
  form.maxInflightBodyMiB = data.config.maxInflightBodyMiB
  runtime.value = data.status
}

const load = async () => {
  loading.value = true
  loadError.value = ''
  try {
    const response = await getRequestResourcesApi({ signal: controller.signal })
    if (controller.signal.aborted) return
    if (!isOk(response)) throw new Error(msgOf(response, '加载配置失败，请重新加载'))
    apply(response.data)
    ready.value = true
  } catch (error) {
    if (controller.signal.aborted) return
    ready.value = false
    loadError.value = error.message
  } finally {
    loading.value = false
  }
}

const save = async () => {
  if (!ready.value || saving.value || loading.value) return
  if (
    ![form.maxRequests, form.maxInflightBodyMiB].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
  ) {
    showToast('请填写大于或等于 0 的整数，0 表示不限制', 'error')
    return
  }
  saving.value = true
  try {
    const response = await updateRequestResourcesApi({ ...form }, { signal: controller.signal })
    if (controller.signal.aborted) return
    if (!isOk(response)) throw new Error(msgOf(response, '保存配置失败'))
    apply(response.data)
    showToast('实例资源保护配置已保存并生效', 'success')
  } catch (error) {
    if (!controller.signal.aborted) showToast(error.message, 'error')
  } finally {
    saving.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => controller.abort())
</script>
