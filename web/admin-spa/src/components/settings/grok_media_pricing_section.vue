<template>
  <div class="grok-media-pricing-settings max-w-4xl">
    <div v-if="loading" class="py-12 text-center">
      <div class="loading-spinner mx-auto mb-4"></div>
      <p class="t-text-secondary text-sm">正在加载 Grok 媒体计费配置...</p>
    </div>

    <div v-else-if="loadFailed" class="py-12 text-center">
      <p class="mb-3 text-sm text-red-600 dark:text-red-400">
        {{ loadError || '加载 Grok 媒体计费配置失败' }}
      </p>
      <button class="btn btn-primary h-8 px-3 text-sm" type="button" @click="loadConfig">
        <i class="i-lucide-refresh-cw mr-1.5"></i>
        重新加载
      </button>
    </div>

    <template v-else>
      <p class="mb-4 t-text-secondary text-sm">
        配置 Grok Imagine 图片/视频按张、按秒与分档单价。保存后覆盖内置官方兜底价；内部完整计费模型仍优先。
      </p>

      <div class="space-y-4">
        <div
          v-for="modelName in modelNames"
          :key="modelName"
          class="rounded-xl border border-gray-200 p-4 dark:border-gray-700"
        >
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div class="text-sm font-semibold text-gray-900 dark:text-gray-100">{{ modelName }}</div>
              <div class="t-text-secondary text-sm">
                {{ draft[modelName]?.mode || '-' }}
                <span v-if="hasOverride(modelName)" class="ml-2 text-amber-600 dark:text-amber-400"
                  >已覆盖</span
                >
              </div>
            </div>
            <button
              class="btn btn-ghost h-8 px-2 text-sm"
              type="button"
              @click="resetModel(modelName)"
            >
              恢复内置
            </button>
          </div>

          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label
              v-for="field in flatFieldsFor(modelName)"
              :key="`${modelName}-${field.key}`"
              class="block"
            >
              <span class="mb-1 block text-sm text-gray-700 dark:text-gray-200">{{ field.label }}</span>
              <input
                v-model.number="draft[modelName][field.key]"
                class="form-input w-full"
                min="0"
                step="0.001"
                type="number"
              />
            </label>
          </div>

          <div
            v-if="draft[modelName].xai_image_output_tiers"
            class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2"
          >
            <label
              v-for="(value, tier) in draft[modelName].xai_image_output_tiers"
              :key="`${modelName}-img-${tier}`"
              class="block"
            >
              <span class="mb-1 block text-sm text-gray-700 dark:text-gray-200"
                >图片分档 {{ tier }} ($/张)</span
              >
              <input
                v-model.number="draft[modelName].xai_image_output_tiers[tier]"
                class="form-input w-full"
                min="0"
                step="0.001"
                type="number"
              />
            </label>
          </div>

          <div
            v-if="draft[modelName].xai_video_output_tiers"
            class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2"
          >
            <label
              v-for="(value, tier) in draft[modelName].xai_video_output_tiers"
              :key="`${modelName}-vid-${tier}`"
              class="block"
            >
              <span class="mb-1 block text-sm text-gray-700 dark:text-gray-200"
                >视频分档 {{ tier }} ($/秒)</span
              >
              <input
                v-model.number="draft[modelName].xai_video_output_tiers[tier]"
                class="form-input w-full"
                min="0"
                step="0.001"
                type="number"
              />
            </label>
          </div>
        </div>
      </div>

      <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex flex-wrap gap-2">
          <button
            class="btn btn-primary h-8 px-3 text-sm"
            type="button"
            :disabled="saving"
            @click="saveConfig"
          >
            <div v-if="saving" class="loading-spinner mr-1.5"></div>
            <i v-else class="i-lucide-save mr-1.5" />
            {{ saving ? '保存中...' : '保存' }}
          </button>
          <button
            class="btn btn-ghost h-8 px-3 text-sm"
            type="button"
            :disabled="saving"
            @click="resetAll"
          >
            全部恢复内置
          </button>
        </div>
        <div v-if="updatedAt" class="t-text-secondary text-sm">
          最后更新：{{ formatDateTime(updatedAt) }}
          <span v-if="updatedBy">· {{ updatedBy }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

import { isOk, msgOf } from '@/libs/http_envelope'
import * as httpApis from '@/libs/http_apis'
import { showToast, formatDateTime } from '@/libs/tools'

defineOptions({
  name: 'GrokMediaPricingSection'
})

const loading = ref(true)
const loadFailed = ref(false)
const loadError = ref('')
const saving = ref(false)
const draft = ref({})
const builtin = ref({})
const overlay = ref({})
const updatedAt = ref(null)
const updatedBy = ref(null)

const modelNames = computed(() => Object.keys(draft.value || {}))

const flatFieldsFor = (modelName) => {
  const model = draft.value[modelName] || {}
  const fields = []
  if (model.input_cost_per_image !== undefined) {
    fields.push({ key: 'input_cost_per_image', label: '输入图 ($/张)' })
  }
  if (model.output_cost_per_image !== undefined) {
    fields.push({ key: 'output_cost_per_image', label: '默认输出图 ($/张)' })
  }
  if (model.input_cost_per_video_per_second !== undefined) {
    fields.push({ key: 'input_cost_per_video_per_second', label: '输入视频 ($/秒)' })
  }
  if (model.output_cost_per_video_per_second !== undefined) {
    fields.push({ key: 'output_cost_per_video_per_second', label: '默认输出视频 ($/秒)' })
  }
  return fields
}

const hasOverride = (modelName) =>
  !!(overlay.value && overlay.value[modelName] && Object.keys(overlay.value[modelName]).length > 0)

const applyConfig = (data) => {
  draft.value = structuredClone(data.models || {})
  builtin.value = structuredClone(data.builtin || {})
  overlay.value = structuredClone(data.overlay || {})
  updatedAt.value = data.updatedAt || null
  updatedBy.value = data.updatedBy || null
}

const loadConfig = async () => {
  loading.value = true
  loadFailed.value = false
  loadError.value = ''
  try {
    const result = await httpApis.getGrokMediaPricingApi()
    if (!isOk(result)) {
      throw new Error(msgOf(result) || '加载失败')
    }
    applyConfig(result.data || {})
  } catch (error) {
    loadFailed.value = true
    loadError.value = error?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

const buildOverlayPayload = () => {
  const models = {}
  for (const [name, current] of Object.entries(draft.value || {})) {
    const base = builtin.value[name] || {}
    const entry = {}
    for (const key of [
      'input_cost_per_image',
      'output_cost_per_image',
      'input_cost_per_video_per_second',
      'output_cost_per_video_per_second'
    ]) {
      if (current[key] !== undefined && Number(current[key]) !== Number(base[key])) {
        entry[key] = Number(current[key])
      }
    }
    for (const tierField of ['xai_image_output_tiers', 'xai_video_output_tiers']) {
      if (!current[tierField]) continue
      const tiers = {}
      for (const [tier, value] of Object.entries(current[tierField])) {
        const baseValue = base[tierField]?.[tier]
        if (Number(value) !== Number(baseValue)) {
          tiers[tier] = Number(value)
        }
      }
      if (Object.keys(tiers).length > 0) {
        entry[tierField] = tiers
      }
    }
    if (Object.keys(entry).length > 0) {
      models[name] = entry
    }
  }
  return models
}

const saveConfig = async () => {
  saving.value = true
  try {
    const result = await httpApis.updateGrokMediaPricingApi({
      models: buildOverlayPayload(),
      baseUpdatedAt: updatedAt.value
    })
    if (!isOk(result)) {
      if (result?.code === 409) {
        showToast(msgOf(result) || '配置已被其他人更新，已重新加载', 'error')
        await loadConfig()
        return
      }
      throw new Error(msgOf(result) || '保存失败')
    }
    applyConfig(result.data || {})
    showToast('Grok 媒体计费已保存', 'success')
  } catch (error) {
    showToast(error?.message || '保存失败', 'error')
  } finally {
    saving.value = false
  }
}

const resetModel = (modelName) => {
  if (!builtin.value[modelName]) return
  draft.value[modelName] = structuredClone(builtin.value[modelName])
}

const resetAll = async () => {
  saving.value = true
  try {
    const result = await httpApis.resetGrokMediaPricingApi({
      baseUpdatedAt: updatedAt.value
    })
    if (!isOk(result)) {
      if (result?.code === 409) {
        showToast(msgOf(result) || '配置已被其他人更新，已重新加载', 'error')
        await loadConfig()
        return
      }
      throw new Error(msgOf(result) || '重置失败')
    }
    applyConfig(result.data || {})
    showToast('已恢复全部内置媒体价', 'success')
  } catch (error) {
    showToast(error?.message || '重置失败', 'error')
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadConfig()
})
</script>
