<template>
  <div class="service-rates-settings max-w-3xl">
    <div v-if="loading" class="py-12 text-center">
      <div class="loading-spinner mx-auto mb-4"></div>
      <p class="t-text-secondary text-sm">正在加载配置...</p>
    </div>

    <div v-else-if="loadFailed" class="py-12 text-center">
      <p class="mb-3 text-sm text-red-600 dark:text-red-400">{{ loadError || '加载服务倍率配置失败' }}</p>
      <button class="btn btn-primary h-8 px-3 text-sm" type="button" @click="loadServiceRates">
        <i class="i-lucide-refresh-cw mr-1.5"></i>
        重新加载
      </button>
    </div>

    <template v-else>
      <p class="mb-4 t-text-secondary text-sm">
        以 <strong>{{ serviceRates.baseService || 'claude' }}</strong>
        为基准（1.0），其他服务按倍率换算。例如 Gemini 0.5 表示消耗 $1 只扣 $0.5 额度。
      </p>

      <div class="sr-list">
        <div v-for="(rate, service) in serviceRates.rates" :key="service" class="sr-row">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2">
              <span class="text-sm font-medium text-gray-900 dark:text-gray-100">
                {{ getServiceName(service) }}
              </span>
              <span class="t-text-secondary text-sm">{{ service }}</span>
              <span
                v-if="service === serviceRates.baseService"
                class="rounded bg-blue-100 px-1.5 py-0.5 text-sm text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
              >
                基准
              </span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <input
              v-model.number="serviceRates.rates[service]"
              class="form-input w-24"
              max="10"
              min="0.1"
              step="0.1"
              type="number"
            />
            <span class="t-text-secondary text-sm">倍</span>
          </div>
        </div>
      </div>

      <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          class="btn btn-primary h-8 px-3 text-sm"
          type="button"
          :disabled="saving || !configReady"
          @click="saveServiceRates"
        >
          <div v-if="saving" class="loading-spinner mr-1.5"></div>
          <i v-else class="i-lucide-save mr-1.5" />
          {{ saving ? '保存中...' : '保存' }}
        </button>
        <div v-if="serviceRates.updatedAt" class="t-text-secondary text-sm">
          最后更新：{{ formatDateTime(serviceRates.updatedAt) }}
          <span v-if="serviceRates.updatedBy">· {{ serviceRates.updatedBy }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

import { isOk, msgOf } from '@/libs/http_envelope'
import * as httpApis from '@/libs/http_apis'
import { showToast } from '@/libs/tools'
import { useSettingsStore } from '@/stores/settings'

const settingsStore = useSettingsStore()
const formatDateTime = settingsStore.formatDateTime

const isMounted = ref(true)
const abortController = ref(new AbortController())
const loading = ref(true)
const loadFailed = ref(false)
const loadError = ref('')
// 仅在成功拉到服务端配置后允许保存，避免失败时用本地默认倍率覆盖真实配置
const configReady = ref(false)
const saving = ref(false)
const serviceRates = ref({
  baseService: 'claude',
  rates: {
    claude: 1.0,
    codex: 1.0,
    gemini: 1.0,
    droid: 1.0,
    bedrock: 1.0,
    azure: 1.0,
    ccr: 1.0
  },
  updatedAt: null,
  updatedBy: null
})

const getServiceName = (service) => {
  const names = {
    claude: 'Claude',
    codex: 'Codex (OpenAI)',
    gemini: 'Gemini',
    droid: 'Droid',
    bedrock: 'AWS Bedrock',
    azure: 'Azure OpenAI',
    ccr: 'CCR'
  }
  return names[service] || service
}

const loadServiceRates = async () => {
  if (!isMounted.value) return
  loading.value = true
  loadFailed.value = false
  loadError.value = ''
  try {
    const response = await httpApis.getAdminServiceRatesApi({
      signal: abortController.value.signal
    })
    if (!isMounted.value) return
    if (isOk(response)) {
      serviceRates.value = {
        baseService: response.data?.baseService || 'claude',
        rates: response.data?.rates || serviceRates.value.rates,
        updatedAt: response.data?.updatedAt,
        updatedBy: response.data?.updatedBy
      }
      configReady.value = true
      loadFailed.value = false
    } else {
      configReady.value = false
      loadFailed.value = true
      loadError.value = msgOf(response, '加载服务倍率配置失败')
      showToast(loadError.value, 'error')
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    configReady.value = false
    loadFailed.value = true
    loadError.value = error.message || '加载服务倍率配置失败'
    console.error(error)
    showToast(loadError.value, 'error')
  } finally {
    if (isMounted.value) loading.value = false
  }
}

const saveServiceRates = async () => {
  if (!isMounted.value) return
  if (!configReady.value || loadFailed.value) {
    showToast('配置未加载成功，请先重新加载后再保存', 'error')
    return
  }
  saving.value = true
  try {
    const response = await httpApis.updateAdminServiceRatesApi(
      {
        rates: serviceRates.value.rates,
        baseService: serviceRates.value.baseService
      },
      { signal: abortController.value.signal }
    )
    if (!isMounted.value) return
    if (isOk(response)) {
      serviceRates.value.updatedAt = response.data?.updatedAt || new Date().toISOString()
      serviceRates.value.updatedBy = response.data?.updatedBy
      showToast('服务倍率配置已保存', 'success')
    } else {
      showToast(msgOf(response, '保存服务倍率配置失败'), 'error')
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    showToast('保存服务倍率配置失败', 'error')
    console.error(error)
  } finally {
    if (isMounted.value) saving.value = false
  }
}

onMounted(() => {
  loadServiceRates()
})

onBeforeUnmount(() => {
  isMounted.value = false
  abortController.value.abort()
})
</script>

<style scoped>
.sr-list {
  border: 1px solid var(--divider-color);
  border-radius: 0.5rem;
  overflow: hidden;
}
.sr-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border-bottom: 1px solid var(--divider-color);
}
.sr-row:last-child {
  border-bottom: 0;
}
.sr-row:hover {
  background: color-mix(in srgb, var(--text-primary) 3%, transparent);
}
</style>
