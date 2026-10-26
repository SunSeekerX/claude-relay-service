<template>
  <section aria-label="账号模型配置" class="min-w-0 space-y-4 text-sm">
    <div class="flex flex-wrap items-center gap-2">
      <button
        class="btn btn-secondary"
        :disabled="loading || syncing || savingKey || !canSync"
        :title="canSync ? '只更新候选目录，不改变调用范围' : '保存账号后可同步上游模型'"
        type="button"
        @click="sync"
      >
        <i :class="syncing ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw'" />
        {{ syncing ? '同步中…' : '同步上游模型' }}
      </button>
      <button
        v-if="accountId"
        class="btn btn-secondary"
        :disabled="loading || syncing || savingKey"
        type="button"
        @click="load"
      >
        刷新显示
      </button>
      <span class="text-gray-500 dark:text-gray-400">{{
        catalog.succeededAt
          ? `上次同步 ${formatDateTime(catalog.succeededAt)}`
          : accountId
            ? '尚未同步'
            : '保存前可手动添加模型'
      }}</span>
    </div>
    <p v-if="catalog.error || error" class="text-red-600 dark:text-red-400" role="alert">
      {{ error || catalog.error }}
    </p>
    <p v-if="catalog.stale" class="text-amber-600 dark:text-amber-400">
      连接配置已变化，请重新同步。
    </p>
    <AccountModelScope
      :key="`${platform}:${accountId}`"
      :disabled="!ready"
      :model-value="modelValue"
      :options="options"
      :restricted="restricted"
      @update:model-value="emit('update:modelValue', $event)"
      @update:restricted="emit('update:restricted', $event)"
    />
    <AccountModelMapping
      v-if="canMap"
      :model-value="modelMappings"
      @update:model-value="emit('update:modelMappings', $event)"
    />
    <details
      v-if="platform === 'droid'"
      class="rounded-lg border border-gray-200 p-3 dark:border-gray-600"
    >
      <summary class="cursor-pointer font-medium">
        模型同步凭据 {{ catalog.hasDiscoveryKey ? '（已配置）' : '' }}
      </summary>
      <label class="mb-2 mt-3 block" for="model-discovery-key">Factory Key（仅用于模型同步）</label>
      <input
        id="model-discovery-key"
        v-model="discoveryKey"
        autocomplete="new-password"
        class="form-input w-full"
        :disabled="savingKey || syncing || loading || !accountId"
        :placeholder="catalog.hasDiscoveryKey ? '留空保持原值' : '填写 Factory API Key'"
        type="password"
      />
      <div class="mt-2 flex flex-wrap gap-2">
        <button
          class="btn btn-secondary"
          :disabled="!discoveryKey.trim() || savingKey || syncing || loading || !accountId"
          type="button"
          @click="saveDiscoveryKey(false)"
        >
          保存同步 Key
        </button>
        <button
          class="btn btn-secondary"
          :disabled="!catalog.hasDiscoveryKey || savingKey || syncing || loading"
          type="button"
          @click="saveDiscoveryKey(true)"
        >
          清除同步 Key
        </button>
      </div>
    </details>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  getAccountModelCatalogApi,
  syncAccountModelCatalogApi,
  getAccountSupportedModelsApi,
  fetchOpenAIResponsesUpstreamModelsApi,
  updateDroidAccountApi
} from '@/libs/http_apis'
import { modelSourceLabel } from '@/libs/relay_routing'
import { isOk, msgOf } from '@/libs/http_envelope'
import { formatLocalDateTime as formatDateTime } from '@/libs/time'
import AccountModelScope from './account_model_scope.vue'
import AccountModelMapping from './account_model_mapping.vue'

const props = defineProps({
  accountId: { type: String, default: '' },
  platform: { type: String, required: true },
  modelValue: { type: Array, default: () => [] },
  restricted: { type: Boolean, default: false },
  ready: { type: Boolean, default: true },
  modelMappings: { type: Array, default: () => [] },
  baseApi: { type: String, default: '' },
  apiKey: { type: String, default: '' },
  fallbackModels: { type: Array, default: () => [] }
})
const emit = defineEmits([
  'update:modelValue',
  'update:restricted',
  'update:modelMappings',
  'loaded'
])
const catalog = ref({ models: [], modelDetails: [] })
const loading = ref(false)
const syncing = ref(false)
const savingKey = ref(false)
const discoveryKey = ref('')
const error = ref('')
let sequence = 0
let keySaveSequence = 0
const canMap = computed(() =>
  ['claude-console', 'ccr', 'openai-responses'].includes(props.platform)
)
const canSync = computed(() =>
  Boolean(
    props.accountId ||
    (props.platform === 'openai-responses' && props.baseApi.trim() && props.apiKey.trim())
  )
)
const options = computed(() => {
  const result = new Map(
    props.fallbackModels.map((item) => {
      const id = typeof item === 'string' ? item : (item.value ?? item.id)
      return [id, { id, label: '未向上游确认' }]
    })
  )
  for (const detail of catalog.value.modelDetails ?? [])
    result.set(detail.id, { id: detail.id, label: modelSourceLabel(detail.source) })
  for (const id of catalog.value.models) result.set(id, { id, label: '上游模型' })
  for (const row of props.modelMappings)
    if (row.from && !result.has(row.from)) result.set(row.from, { id: row.from, label: '映射名称' })
  return [...result.values()]
})
const accountType = () => (props.platform === 'gemini-antigravity' ? 'gemini' : props.platform)
const load = async () => {
  const request = ++sequence
  if (!props.accountId) return
  loading.value = true
  error.value = ''
  try {
    const [catalogResult, modelResult] = await Promise.allSettled([
      getAccountModelCatalogApi(accountType(), props.accountId),
      getAccountSupportedModelsApi(accountType(), props.accountId)
    ])
    if (request !== sequence) return
    const result = catalogResult.status === 'fulfilled' ? catalogResult.value : null
    const supported = modelResult.status === 'fulfilled' ? modelResult.value : null
    if (isOk(result)) {
      catalog.value = { ...catalog.value, ...result.data }
      emit('loaded', result.data.configuredModels ?? [])
    } else error.value = msgOf(result, '加载模型范围失败，请重试')
    if (isOk(supported)) catalog.value.modelDetails = supported.data.models
    else if (!error.value) error.value = msgOf(supported, '加载候选模型失败，请重试')
  } catch (failure) {
    if (request === sequence) error.value = failure.message
  } finally {
    if (request === sequence) loading.value = false
  }
}
const sync = async () => {
  const request = ++sequence
  syncing.value = true
  error.value = ''
  try {
    const result = props.accountId
      ? await syncAccountModelCatalogApi(accountType(), props.accountId)
      : await fetchOpenAIResponsesUpstreamModelsApi({
          baseApi: props.baseApi.trim(),
          apiKey: props.apiKey.trim()
        })
    if (request !== sequence) return
    if (!isOk(result)) error.value = msgOf(result, '同步模型目录失败')
    else catalog.value = { ...catalog.value, ...result.data }
  } catch (failure) {
    if (request === sequence) error.value = failure.message
  } finally {
    if (request === sequence) {
      syncing.value = false
      if (props.accountId) {
        const failure = error.value
        await load()
        if (failure) error.value = failure
      }
    }
  }
}
const saveDiscoveryKey = async (clear) => {
  const request = ++sequence
  const operation = ++keySaveSequence
  savingKey.value = true
  error.value = ''
  try {
    const result = await updateDroidAccountApi(props.accountId, {
      modelDiscoveryApiKey: clear ? null : discoveryKey.value
    })
    if (request !== sequence) return
    if (!isOk(result)) {
      error.value = msgOf(result, '保存同步 Key 失败')
      return
    }
    discoveryKey.value = ''
    await load()
  } catch (failure) {
    if (request === sequence) error.value = failure.message
  } finally {
    if (operation === keySaveSequence) savingKey.value = false
  }
}
watch(
  () => [props.accountId, props.platform],
  () => {
    catalog.value = { models: [], modelDetails: [] }
    syncing.value = false
    keySaveSequence += 1
    savingKey.value = false
    discoveryKey.value = ''
    load()
  },
  { immediate: true }
)
watch(
  () => [props.baseApi, props.apiKey],
  () => {
    if (!props.accountId) {
      sequence += 1
      syncing.value = false
      catalog.value = { models: [], modelDetails: [] }
    }
  }
)
onBeforeUnmount(() => {
  sequence += 1
  keySaveSequence += 1
})
</script>
