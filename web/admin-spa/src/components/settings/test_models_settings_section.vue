<template>
  <div class="test-models-settings max-w-3xl">
    <div v-if="loading" class="py-12 text-center">
      <div class="loading-spinner mx-auto mb-4"></div>
      <p class="t-text-secondary text-sm">正在加载配置...</p>
    </div>

    <template v-else>
      <p class="mb-4 t-text-secondary text-sm">
        账户连通性测试与 API Key 测试弹窗的默认模型，保存后立即生效。
      </p>

      <section class="tm-section">
        <h3 class="tm-section__title">账户连通性测试</h3>
        <div class="t-setting-stack">
          <div
            v-for="platform in TEST_MODEL_ACCOUNT_PLATFORMS"
            :key="`account-${platform.key}`"
            class="t-setting-row sm:items-center"
          >
            <div class="t-setting-row__label">
              <div class="t-setting-row__title">{{ platform.label }}</div>
            </div>
            <div class="t-setting-row__control max-w-md">
              <ModelPicker
                v-model="testModelConfig.account[platform.key]"
                :catalog="pricingModelIds"
                :presets="accountOptions(platform.key)"
              />
            </div>
          </div>
        </div>
      </section>

      <section class="tm-section">
        <h3 class="tm-section__title">API Key 测试</h3>
        <div class="t-setting-stack">
          <div
            v-for="service in TEST_MODEL_APIKEY_SERVICES"
            :key="`apikey-${service.key}`"
            class="t-setting-row sm:items-center"
          >
            <div class="t-setting-row__label">
              <div class="t-setting-row__title">{{ service.label }}</div>
            </div>
            <div class="t-setting-row__control max-w-md">
              <ModelPicker
                v-model="testModelConfig.apikey[service.key]"
                :catalog="pricingModelIds"
                :presets="apikeyOptions(service.key)"
              />
            </div>
          </div>
        </div>
      </section>

      <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          class="btn btn-primary h-8 px-3 text-sm"
          type="button"
          :disabled="saving"
          @click="saveTestModelConfig"
        >
          <div v-if="saving" class="loading-spinner mr-1.5"></div>
          <i v-else class="i-lucide-save mr-1.5" />
          {{ saving ? '保存中...' : '保存' }}
        </button>
        <div v-if="testModelConfig.updatedAt" class="t-text-secondary text-sm">
          最后更新：{{ formatDateTime(testModelConfig.updatedAt) }}
          <span v-if="testModelConfig.updatedBy">· {{ testModelConfig.updatedBy }}</span>
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
import ModelPicker from '@/components/common/model_picker.vue'

const TEST_MODEL_ACCOUNT_PLATFORMS = [
  { key: 'claude', label: 'Claude OAuth' },
  { key: 'claude-console', label: 'Claude Console' },
  { key: 'bedrock', label: 'AWS Bedrock' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'gemini-api', label: 'Gemini API' },
  { key: 'openai-responses', label: 'OpenAI Responses' },
  { key: 'droid', label: 'Droid' },
  { key: 'ccr', label: 'CCR' }
]

const TEST_MODEL_APIKEY_SERVICES = [
  { key: 'claude', label: 'Claude' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'openai', label: 'OpenAI (Codex)' }
]

const settingsStore = useSettingsStore()
const formatDateTime = settingsStore.formatDateTime

const isMounted = ref(true)
const abortController = ref(new AbortController())
const loading = ref(true)
const saving = ref(false)
const testModelOptions = ref({ claude: [], gemini: [], openai: [], platforms: {} })
const testModelConfig = ref({ account: {}, apikey: {}, updatedAt: null, updatedBy: null })
const pricingModelIds = ref([])

const accountOptions = (platform) => testModelOptions.value.platforms?.[platform] || []
const apikeyOptions = (service) => testModelOptions.value[service] || []

const loadTestModelConfig = async () => {
  if (!isMounted.value) return
  loading.value = true
  try {
    const [optsRes, cfgRes, pricingRes] = await Promise.all([
      httpApis.getModelsApi(),
      httpApis.getTestModelConfigApi({ signal: abortController.value.signal }),
      httpApis.getModelPricingApi()
    ])
    if (!isMounted.value) return
    if (isOk(optsRes) && optsRes.data) {
      testModelOptions.value = optsRes.data
    }
    const cfg = cfgRes.data?.config || cfgRes.config
    if (isOk(cfgRes) && cfg) {
      testModelConfig.value = {
        account: { ...cfg.account },
        apikey: { ...cfg.apikey },
        updatedAt: cfg.updatedAt || null,
        updatedBy: cfg.updatedBy || null
      }
    }
    if (isOk(pricingRes) && pricingRes.data) {
      pricingModelIds.value = Object.keys(pricingRes.data).sort()
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    showToast('获取测试默认模型配置失败', 'error')
    console.error(error)
  } finally {
    if (isMounted.value) loading.value = false
  }
}

const saveTestModelConfig = async () => {
  if (!isMounted.value) return
  saving.value = true
  try {
    const payload = {
      account: { ...testModelConfig.value.account },
      apikey: { ...testModelConfig.value.apikey }
    }
    const response = await httpApis.updateTestModelConfigApi(payload, {
      signal: abortController.value.signal
    })
    const savedCfg = response.data?.config || response.config
    if (isOk(response) && savedCfg && isMounted.value) {
      testModelConfig.value = {
        account: { ...savedCfg.account },
        apikey: { ...savedCfg.apikey },
        updatedAt: savedCfg.updatedAt || new Date().toISOString(),
        updatedBy: savedCfg.updatedBy || null
      }
      showToast(msgOf(response, '测试默认模型配置已保存'), 'success')
    } else if (isMounted.value) {
      showToast(msgOf(response, '保存测试默认模型配置失败'), 'error')
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    showToast('保存测试默认模型配置失败', 'error')
    console.error(error)
  } finally {
    if (isMounted.value) saving.value = false
  }
}

onMounted(() => {
  loadTestModelConfig()
})

onBeforeUnmount(() => {
  isMounted.value = false
  abortController.value.abort()
})
</script>

<style scoped>
.tm-section {
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--divider-color);
}
.tm-section:first-of-type {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.tm-section__title {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
}
</style>
