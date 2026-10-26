<template>
  <ModalTransition>
    <div v-if="show" class="test-overlay" @keydown.esc.prevent="handleClose">
      <div class="test-mask" @click="handleClose" />
      <section
        aria-labelledby="endpoint-test-title"
        aria-modal="true"
        class="modal-panel test-dialog"
        role="dialog"
        tabindex="-1"
      >
        <header class="test-header">
          <div>
            <h3 id="endpoint-test-title">{{ modalTitle }}</h3>
            <p>{{ modalSubtitle }}</p>
          </div>
          <button
            aria-label="关闭测试弹窗"
            class="test-icon-button"
            :disabled="state.testStatus.value === 'testing'"
            type="button"
            @click="handleClose"
          >
            <i class="i-lucide-x" />
          </button>
        </header>
        <div class="test-body">
          <div class="test-identity">
            <span v-if="mode === 'apikey'" class="test-protocol">{{
              apikeyServiceConfig.name
            }}</span
            ><span v-else class="test-platform" :class="platformBadgeClass"
              ><i :class="platformIcon" />{{ platformLabel }}</span
            ><span v-if="mode === 'apikey'" class="test-key"
              ><i class="i-lucide-key" />{{ maskedApiKey }}</span
            ><span
              v-if="mode === 'account' && account?.platform === 'bedrock'"
              class="test-platform"
              :class="credentialTypeBadgeClass"
              ><i :class="credentialTypeIcon" />{{ credentialTypeLabel }}</span
            >
          </div>
          <div v-if="mode === 'apikey'" class="test-endpoint">
            <span>请求地址</span>
            <div>
              <code>{{ testDisplayEndpoint }}</code
              ><button
                class="test-text-button"
                title="复制测试地址"
                type="button"
                @click="copyText(testDisplayEndpoint)"
              >
                <i class="i-lucide-copy" />复制
              </button>
            </div>
          </div>
          <div class="test-fields">
            <div class="test-model-field">
              <label>测试模型</label
              ><ModelSelector
                v-model="selectedModel"
                :disabled="state.testStatus.value === 'testing'"
                :models="availableModels"
              />
            </div>
            <div v-if="mode === 'apikey'" class="test-tokens-field">
              <label>最大输出 Token</label
              ><CustomDropdown
                v-model="maxTokens"
                :disabled="state.testStatus.value === 'testing'"
                :options="maxTokensOptions"
              />
            </div>
          </div>
          <p v-if="selectedModelDetail" class="test-note">
            {{ modelSourceLabel(selectedModelDetail.source) }} ·
            {{ modelAvailabilityLabel(selectedModelDetail.availability) }}
            <span v-if="selectedModelDetail.interfaceSupport === 'unknown'"> · 接口能力未确认</span>
          </p>
          <p v-if="mode === 'apikey' && routeModels && !routeModels.length" class="test-note">
            此入口暂无候选模型，请联系管理员确认。
          </p>
          <div v-if="modelLoadError" class="test-error">
            <span>{{ modelLoadError }}</span
            ><button
              class="test-text-button"
              :disabled="state.testStatus.value === 'testing'"
              type="button"
              @click="loadModels"
            >
              重试
            </button>
          </div>
          <div class="test-prompt-heading">
            <label for="endpoint-test-prompt">测试问题</label>
            <div>
              <CustomDropdown
                :disabled="
                  prompts.loading.value ||
                  prompts.failed.value ||
                  state.testStatus.value === 'testing'
                "
                :model-value="prompts.selectedId.value"
                :options="prompts.options.value"
                placeholder="从题库选择"
                searchable
                @update:model-value="prompts.select"
              /><button
                class="test-text-button"
                :disabled="!prompts.canRandomize.value || state.testStatus.value === 'testing'"
                type="button"
                @click="prompts.randomize"
              >
                <i class="i-lucide-shuffle" />换一题
              </button>
            </div>
          </div>
          <textarea
            id="endpoint-test-prompt"
            v-model="testPrompt"
            class="form-input test-prompt"
            :disabled="state.testStatus.value === 'testing'"
            placeholder="输入要发送的测试问题"
            rows="3"
          />
          <p v-if="prompts.loading.value" class="test-note">正在加载题库…</p>
          <div v-else-if="prompts.failed.value" class="test-error">
            <span>{{ prompts.errorMessage.value }}，可手动输入。</span
            ><button
              class="test-text-button"
              :disabled="state.testStatus.value === 'testing'"
              type="button"
              @click="prompts.reload"
            >
              重试题库</button
            ><button
              v-if="prompts.errorRequestId.value"
              class="test-text-button"
              type="button"
              @click="copyText(prompts.errorRequestId.value, '请求 ID 已复制')"
            >
              复制请求 ID
            </button>
          </div>
          <p v-else-if="prompts.hint.value" class="test-note">{{ prompts.hint.value }}</p>
          <section
            aria-label="测试结果"
            aria-live="polite"
            class="test-result"
            :class="`result-${state.testStatus.value}`"
          >
            <header>
              <span><i :class="state.statusIcon.value" />{{ state.statusTitle.value }}</span>
              <div>
                <span v-if="state.testDuration.value"
                  >{{ (state.testDuration.value / 1000).toFixed(2) }} 秒</span
                ><button
                  class="test-text-button"
                  :disabled="!state.responseText.value"
                  title="复制响应内容"
                  type="button"
                  @click="copyText(state.responseText.value)"
                >
                  <i class="i-lucide-copy" />复制
                </button>
              </div>
            </header>
            <p v-if="state.testStatus.value === 'error'" class="test-result-error" role="alert">
              {{ state.errorMessage.value || '测试失败' }}
            </p>
            <pre v-if="state.responseText.value">{{ state.responseText.value }}</pre>
            <p v-else class="test-result-empty">
              {{
                state.testStatus.value === 'testing'
                  ? '等待模型响应…'
                  : state.testStatus.value === 'cancelled'
                    ? '测试已停止，可调整后重新测试。'
                    : state.testStatus.value === 'success'
                      ? '请求已完成，未返回文本。'
                      : state.testStatus.value === 'error'
                        ? '未收到模型输出。'
                        : '开始测试后，响应会显示在这里。'
              }}
            </p>
            <p v-if="state.testStatus.value === 'success'" class="test-result-success">
              {{ statusDescription }}
            </p>
          </section>
        </div>
        <footer class="test-footer">
          <span>{{
            mode === 'apikey' ? '测试会计入当前 Key 用量' : '测试会发起实际模型请求'
          }}</span>
          <div>
            <button
              class="btn btn-secondary"
              :disabled="state.testStatus.value === 'testing'"
              type="button"
              @click="handleClose"
            >
              关闭</button
            ><button
              v-if="state.testStatus.value === 'testing'"
              class="btn btn-secondary"
              type="button"
              @click="state.stopTest"
            >
              <i class="i-lucide-square" />停止测试</button
            ><button
              v-else
              class="btn btn-primary"
              :disabled="disableTest"
              type="button"
              @click="startTest"
            >
              <i class="i-lucide-play" />{{
                state.testStatus.value === 'idle' ? '开始测试' : '重新测试'
              }}
            </button>
          </div>
        </footer>
      </section>
    </div>
  </ModalTransition>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import ModalTransition from '@/components/common/modal_transition.vue'
import CustomDropdown from '@/components/common/custom_dropdown.vue'
import { APP_CONFIG, copyText } from '@/libs/tools'
import { PLATFORM_ICONS } from '@/libs/platform_icons'
import {
  getModelsApi,
  getTestModelDefaultsApi,
  getPublicTestPromptConfigApi,
  getAccountSupportedModelsApi
} from '@/libs/http_apis'
import { useTestPrompts } from '@/libs/use_test_prompts'
import { isOk } from '@/libs/http_envelope'
import { useTestState } from '@/libs/use_test_state'
import ModelSelector from '@/components/common/model_selector.vue'
import { modelSourceLabel, modelAvailabilityLabel, routeAddress } from '@/libs/relay_routing'

const props = defineProps({
  show: { type: Boolean, default: false },
  mode: { type: String, default: 'account' }, // 'account' | 'apikey'
  // account 模式
  account: { type: Object, default: null },
  // apikey 模式
  apiKeyValue: { type: String, default: '' },
  apiKeyName: { type: String, default: '' },
  routeCode: { type: String, default: '' },
  basePath: { type: String, default: '' },
  expectedApiKeyId: { type: String, default: '' },
  legacyProvider: { type: String, default: '' },
  interfaceFormat: { type: String, default: '' },
  routeModels: { type: Array, default: null },
  modelDetails: { type: Array, default: () => [] },
  preferredModel: { type: String, default: '' },
  serviceType: { type: String, default: 'claude' }
})

const emit = defineEmits(['close'])
const state = useTestState()

// ========== 模型相关 ==========
const selectedModel = ref('')
const modelsFromApi = ref({
  claude: [],
  gemini: [],
  openai: [],
  platforms: {},
  defaultModels: null
})

// 后台配置的默认测试模型（account 模式按平台，apikey 模式按服务）
const configuredDefault = computed(() => {
  const cfg = modelsFromApi.value.defaultModels
  if (!cfg) return null
  if (props.mode === 'account') {
    return cfg.account?.[props.account?.platform] || null
  }
  return cfg.apikey?.[props.serviceType] || null
})

// 标记模型配置是否已成功加载（弹窗常驻挂载、onMounted 只跑一次，失败需在打开时重试）
const modelsLoaded = ref(false)
const accountModelDetails = ref([])
const modelLoadError = ref('')
let modelLoadSequence = 0

const loadModels = async () => {
  const sequence = ++modelLoadSequence
  modelLoadError.value = ''
  if (props.mode === 'account' && !props.account) return
  try {
    if (props.mode === 'account' || props.routeModels !== null) {
      const defaults = await getTestModelDefaultsApi()
      if (sequence !== modelLoadSequence) return
      if (!isOk(defaults)) throw new Error('加载测试默认模型失败')
      modelsFromApi.value.defaultModels = defaults.data
    }
    if (
      props.mode === 'account' &&
      props.account &&
      !['azure-openai', 'azure_openai'].includes(props.account.platform)
    ) {
      accountModelDetails.value = []
      const type =
        props.account.platform === 'gemini-antigravity' ? 'gemini' : props.account.platform
      const result = await getAccountSupportedModelsApi(type, props.account.id)
      if (sequence !== modelLoadSequence) return
      if (isOk(result)) {
        accountModelDetails.value = result.data.models
        modelsLoaded.value = true
      } else modelLoadError.value = '加载此账号支持的模型失败，请重新打开后重试'
      return
    }
    if (props.mode === 'apikey' && props.routeModels !== null) {
      modelsLoaded.value = true
      return
    }
    const result = await getModelsApi()
    if (sequence !== modelLoadSequence) return
    if (isOk(result) && result.data) {
      modelsFromApi.value = result.data
      modelsLoaded.value = true
    }
  } catch {
    if (sequence === modelLoadSequence) modelLoadError.value = '加载模型失败，请重新打开后重试'
  }
}

onMounted(() => {
  if (!props.show) loadModels()
})

// 把默认模型钉在列表首位（保证可选中、是默认值、"返回列表"也回到它）
const pinDefaultModel = (list, defaultModel, defaultLabel) => {
  if (!defaultModel) return list
  const rest = list.filter((m) => m.value !== defaultModel)
  const head = list.find((m) => m.value === defaultModel) || {
    value: defaultModel,
    label: defaultLabel || defaultModel
  }
  return [head, ...rest]
}

const availableModels = computed(() => {
  if (props.mode === 'apikey' && props.routeModels)
    return props.routeModels.map((model) => {
      const detail = props.modelDetails.find((entry) => entry.id === model)
      return {
        value: model,
        label: detail?.source === 'unconfirmed' ? `${model}（未向上游确认）` : model
      }
    })
  if (props.mode === 'account') {
    const platform = props.account?.platform
    if (!platform) return []
    // azure-openai 使用 deploymentName（AccountsView 标准化成 azure_openai，两种写法都兼容）
    if (platform === 'azure-openai' || platform === 'azure_openai') {
      return [{ value: props.account.deploymentName, label: props.account.deploymentName }]
    }
    const list = accountModelDetails.value.map((model) => ({
      value: model.id,
      label: model.source === 'unconfirmed' ? `${model.id}（未向上游确认）` : model.id
    }))
    // 后台配置了默认模型则钉到首位（defaultModel 取 models[0] 即用它）
    return pinDefaultModel(
      list,
      list.some((model) => model.value === configuredDefault.value) ? configuredDefault.value : null
    )
  }
  // apikey 模式: 仅用后台配置的默认置顶（未加载时无默认、列表为空，由 watch 在加载后回填）
  const list = modelsFromApi.value[props.serviceType] || []
  return pinDefaultModel(list, configuredDefault.value)
})
const selectedModelDetail = computed(() =>
  (props.mode === 'account' ? accountModelDetails.value : props.modelDetails).find(
    (model) => model.id === selectedModel.value
  )
)

const defaultModel = computed(() => {
  // azure 用账户的 deploymentName（不在测试模型配置内）
  const accountPlatform = props.account?.platform
  if (
    props.mode === 'account' &&
    (accountPlatform === 'azure-openai' || accountPlatform === 'azure_openai')
  ) {
    return props.account?.deploymentName || ''
  }
  // 其余取已加载列表首项（后台配置默认已置顶）；未加载时为空，由 watch 在加载后回填
  // 不保留任何前端硬编码 fallback：避免在 /apiStats/models 返回前把旧默认绕过后端发出
  if (!modelsLoaded.value) return ''
  for (const model of [props.preferredModel, configuredDefault.value]) {
    if (availableModels.value.some((entry) => entry.value === model)) return model
  }
  return availableModels.value[0]?.value || ''
})

// ========== apikey 模式专用 ==========
const testPrompt = ref('')
const prompts = useTestPrompts(
  getPublicTestPromptConfigApi,
  computed(() => props.show),
  testPrompt,
  () => state.testStatus.value !== 'testing'
)
const maxTokens = ref(1000)
const maxTokensOptions = [
  { value: 100, label: '100' },
  { value: 500, label: '500' },
  { value: 1000, label: '1000' },
  { value: 2000, label: '2000' },
  { value: 4096, label: '4096' }
]

// 默认模型不在此硬编码：统一由后台"测试模型"配置（/apiStats/models 的 defaultModels）提供
const apikeyServiceConfigs = {
  claude: {
    name: 'Claude',
    endpoint: '/api-key/test',
    displayEndpoint: '/api/v1/messages'
  },
  gemini: {
    name: 'Gemini',
    endpoint: '/api-key/test-gemini',
    displayEndpoint: '/gemini/v1/models/:model:streamGenerateContent'
  },
  openai: {
    name: 'OpenAI (Codex)',
    endpoint: '/api-key/test-openai',
    displayEndpoint: '/openai/responses'
  }
}

const apikeyServiceConfig = computed(() =>
  props.interfaceFormat === 'openai-chat'
    ? {
        name: 'Chat Completions',
        endpoint: '/api-key/test-openai-chat',
        displayEndpoint: '/v1/chat/completions'
      }
    : apikeyServiceConfigs[props.serviceType] || apikeyServiceConfigs.claude
)
const testDisplayEndpoint = computed(() => {
  const format =
    props.interfaceFormat ||
    { claude: 'claude-messages', gemini: 'gemini-generate', openai: 'openai-responses' }[
      props.serviceType
    ]
  const base = props.routeCode
    ? `/r/${props.routeCode}`
    : props.basePath ||
      {
        'claude-messages': '/api',
        'gemini-generate': '/gemini',
        'openai-chat': '/openai/native',
        'openai-responses': '/openai'
      }[format]
  const path =
    format === 'gemini-generate'
      ? `/v1beta/models/${encodeURIComponent(selectedModel.value || 'MODEL')}:streamGenerateContent`
      : {
          'claude-messages': '/v1/messages',
          'openai-chat': '/v1/chat/completions',
          'openai-responses': '/v1/responses'
        }[format]
  return routeAddress(`${base}${path}`)
})

const maskedApiKey = computed(() => {
  const key = props.apiKeyValue
  if (!key) return ''
  if (key.length <= 10) return '****'
  return key.substring(0, 6) + '****' + key.substring(key.length - 4)
})

// selectedModel 为空 = 后台测试模型配置尚未加载完；此时禁用测试，避免发出未经后台解析的请求
const disableTest = computed(
  () =>
    !selectedModel.value ||
    !testPrompt.value.trim() ||
    prompts.loading.value ||
    (props.mode === 'apikey' && !props.apiKeyValue)
)

// ========== account 模式 - 平台信息 ==========
const platformConfigs = {
  claude: {
    label: 'Claude OAuth',
    icon: PLATFORM_ICONS.claude,
    badge: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
  },
  'claude-console': {
    label: 'Claude Console',
    icon: PLATFORM_ICONS.claude,
    badge: 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300'
  },
  bedrock: {
    label: 'AWS Bedrock',
    icon: PLATFORM_ICONS.bedrock,
    badge: 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300'
  },
  gemini: {
    label: 'Gemini',
    icon: PLATFORM_ICONS.gemini,
    badge: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300'
  },
  'gemini-api': {
    label: 'Gemini API',
    icon: PLATFORM_ICONS.gemini,
    badge: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300'
  },
  'openai-responses': {
    label: 'OpenAI Responses',
    icon: PLATFORM_ICONS.openai,
    badge: 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
  },
  'azure-openai': {
    label: 'Azure OpenAI',
    icon: PLATFORM_ICONS.azure_openai,
    badge: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300'
  },
  droid: {
    label: 'Droid',
    icon: PLATFORM_ICONS.droid,
    badge: 'bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300'
  },
  ccr: {
    label: 'CCR',
    icon: PLATFORM_ICONS.ccr,
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
  }
}

const platformConfig = computed(
  () =>
    platformConfigs[props.account?.platform] || {
      label: '未知',
      icon: 'i-lucide-circle-question-mark',
      badge: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
    }
)
const platformLabel = computed(() => platformConfig.value.label)
const platformIcon = computed(() => platformConfig.value.icon)
const platformBadgeClass = computed(() => platformConfig.value.badge)

const credentialTypeLabel = computed(() => {
  const ct = props.account?.credentialType
  if (ct === 'access_key') return 'Access Key'
  if (ct === 'bearer_token') return 'Bearer Token'
  return 'Unknown'
})
const credentialTypeIcon = computed(() => {
  const ct = props.account?.credentialType
  if (ct === 'access_key') return 'i-lucide-key'
  if (ct === 'bearer_token') return 'i-lucide-ticket'
  return 'i-lucide-circle-question-mark'
})
const credentialTypeBadgeClass = computed(() => {
  const ct = props.account?.credentialType
  if (ct === 'access_key') return 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300'
  if (ct === 'bearer_token')
    return 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
  return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
})

// ========== 通用计算属性 ==========
const modalTitle = computed(() =>
  props.mode === 'account' ? '账户连通性测试' : 'API Key 端点测试'
)
const modalSubtitle = computed(() => {
  if (props.mode === 'account') return props.account?.name || '未知账户'
  return props.apiKeyName || '当前 API Key'
})

const statusDescription = computed(() => {
  const s = state.testStatus.value
  const apiName = props.mode === 'account' ? platformLabel.value : apikeyServiceConfig.value.name
  if (s === 'idle')
    return props.mode === 'account'
      ? '点击下方按钮开始测试账户连通性'
      : '点击下方按钮开始测试 API Key 连通性'
  if (s === 'testing') return '正在发送测试请求并等待响应'
  if (s === 'success')
    return props.mode === 'account' ? `账户可以正常访问 ${apiName}` : 'API Key 可以正常访问服务'
  if (s === 'error') return state.errorMessage.value || `无法连接到 ${apiName}`
  return ''
})

// ========== 测试逻辑 ==========
const getAccountEndpoint = () => {
  if (!props.account) return ''
  const platform = props.account.platform
  const endpoints = {
    claude: `${APP_CONFIG.apiPrefix}/admin/claude-accounts/${props.account.id}/test`,
    'claude-console': `${APP_CONFIG.apiPrefix}/admin/claude-console-accounts/${props.account.id}/test`,
    bedrock: `${APP_CONFIG.apiPrefix}/admin/bedrock-accounts/${props.account.id}/test`,
    gemini: `${APP_CONFIG.apiPrefix}/admin/gemini-accounts/${props.account.id}/test`,
    'gemini-api': `${APP_CONFIG.apiPrefix}/admin/gemini-api-accounts/${props.account.id}/test`,
    'openai-responses': `${APP_CONFIG.apiPrefix}/admin/openai-responses-accounts/${props.account.id}/test`,
    'azure-openai': `${APP_CONFIG.apiPrefix}/admin/azure-openai-accounts/${props.account.id}/test`,
    azure_openai: `${APP_CONFIG.apiPrefix}/admin/azure-openai-accounts/${props.account.id}/test`,
    droid: `${APP_CONFIG.apiPrefix}/admin/droid-accounts/${props.account.id}/test`,
    ccr: `${APP_CONFIG.apiPrefix}/admin/ccr-accounts/${props.account.id}/test`
  }
  return endpoints[platform] || ''
}

const startTest = () => {
  if (disableTest.value || state.testStatus.value === 'testing') return
  if (props.mode === 'account') {
    const endpoint = getAccountEndpoint()
    if (!endpoint) return
    const authToken = localStorage.getItem('authToken')
    const useSSE = ['claude', 'claude-console', 'bedrock', 'gemini-api'].includes(
      props.account.platform
    )
    state.sendTestRequest(
      endpoint,
      { model: selectedModel.value, prompt: testPrompt.value },
      {
        useSSE,
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      }
    )
  } else {
    const endpoint = `${APP_CONFIG.apiPrefix}/apiStats${apikeyServiceConfig.value.endpoint}`
    state.sendTestRequest(
      endpoint,
      {
        apiKey: props.apiKeyValue,
        apiId: props.expectedApiKeyId ? props.expectedApiKeyId : undefined,
        routeCode: props.routeCode || undefined,
        legacyProvider: props.legacyProvider || undefined,
        model: selectedModel.value,
        prompt: testPrompt.value,
        maxTokens: maxTokens.value
      },
      { useSSE: true }
    )
  }
}

const handleClose = () => {
  if (state.testStatus.value === 'testing') return
  state.cleanup()
  state.resetState()
  emit('close')
}

// ========== 监听 ==========
watch(
  () => props.show,
  (newVal) => {
    if (newVal) {
      state.resetState()
      // 首轮加载失败时每次打开重试拉取（成功后由 watch(defaultModel) 回填 selectedModel、解除按钮禁用）
      if (props.mode === 'account' || !modelsLoaded.value) loadModels()
      selectedModel.value = defaultModel.value
      if (props.mode === 'apikey') {
        maxTokens.value = 1000
      }
    }
  },
  { immediate: true }
)

watch(
  () => [props.account, props.serviceType],
  () => {
    modelsLoaded.value = false
    loadModels()
    selectedModel.value = defaultModel.value
  },
  { deep: true }
)

// /apiStats/models 异步返回、后台配置默认加载完成后回填默认选择：
// 仅当弹窗打开且用户尚未选择（selectedModel 为空）时同步，避免覆盖手动选择
watch(defaultModel, (newVal) => {
  if (props.show && newVal && !selectedModel.value) {
    selectedModel.value = newVal
  }
})
watch(
  () => props.routeModels,
  (models) => {
    if (models && !models.includes(selectedModel.value)) selectedModel.value = defaultModel.value
  }
)
</script>

<style scoped>
.test-overlay {
  position: fixed;
  inset: 0;
  z-index: 1050;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: rgb(15 23 42 / 0.4);
  backdrop-filter: blur(3px);
  font-size: 14px;
}
.test-mask {
  position: absolute;
  inset: 0;
}
.test-dialog {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 640px;
  max-height: 92dvh;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--surface-color, #fff);
  color: var(--text-primary);
  box-shadow: var(--shadow-lg);
}
.test-header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px 12px;
  border-bottom: 1px solid var(--border-color);
}
.test-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.test-header p {
  margin-top: 4px;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.test-icon-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 6px;
}
.test-icon-button:hover {
  background: var(--surface-muted);
}
.test-body {
  min-height: 0;
  overflow: auto;
  padding: 14px 18px;
}
.test-identity {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}
.test-protocol {
  color: var(--primary-color);
  font-weight: 600;
}
.test-key {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
}
.test-platform {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px;
  border-radius: 4px;
}
.test-endpoint {
  margin-bottom: 12px;
}
.test-endpoint > span {
  display: block;
  color: var(--text-secondary);
  margin-bottom: 4px;
}
.test-endpoint > div {
  display: flex;
  align-items: start;
  gap: 8px;
}
.test-endpoint code {
  min-width: 0;
  flex: 1;
  white-space: normal;
  overflow-wrap: anywhere;
}
.test-text-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--primary-color);
  white-space: nowrap;
  flex-shrink: 0;
}
.test-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 144px;
  gap: 12px;
}
.test-fields label {
  display: block;
  margin-bottom: 5px;
  font-weight: 500;
}
.test-model-field {
  min-width: 0;
}
.test-model-field :deep(.cute-dropdown),
.test-model-field :deep(.form-input) {
  min-width: 0;
}
.test-note {
  margin-top: 6px;
  color: var(--text-secondary);
}
.test-prompt-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 14px 0 7px;
}
.test-prompt-heading > div {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.test-prompt-heading .cute-dropdown {
  width: 190px;
  min-width: 0;
}
.test-prompt-heading label {
  font-weight: 500;
  flex-shrink: 0;
}
.test-prompt {
  width: 100%;
  min-height: 76px;
  resize: vertical;
}
.test-error {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  color: var(--danger-color, #dc2626);
}
.test-result {
  margin-top: 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-muted);
}
.test-result header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
}
.test-result header > span,
.test-result header > div {
  display: flex;
  align-items: center;
  gap: 8px;
}
.test-result header > span {
  font-weight: 500;
}
.test-result header > div {
  color: var(--text-secondary);
}
.test-result pre {
  max-height: 220px;
  min-height: 70px;
  margin: 0;
  padding: 10px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.55;
  font-family: inherit;
}
.test-result-empty {
  min-height: 70px;
  margin: 0;
  padding: 12px;
  color: var(--text-secondary);
}
.test-result-error {
  margin: 10px;
  color: var(--danger-color, #dc2626);
  overflow-wrap: anywhere;
}
.test-result-success {
  color: var(--success-color, #047857);
  padding: 0 10px 10px;
}
.result-success header > span {
  color: var(--success-color, #047857);
}
.result-error header > span {
  color: var(--danger-color, #dc2626);
}
.result-testing header > span {
  color: var(--primary-color);
}
.test-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--border-color);
}
.test-footer > span {
  color: var(--text-secondary);
}
.test-footer > div {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
.test-footer .btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.test-dialog button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.test-dialog button:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 2px;
}
@media (max-width: 480px) {
  .test-header,
  .test-body,
  .test-footer {
    padding: 12px;
  }
  .test-fields {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
  .test-tokens-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .test-tokens-field .cute-dropdown {
    width: 140px;
  }
  .test-prompt-heading {
    align-items: start;
    flex-wrap: wrap;
  }
  .test-prompt-heading > div {
    flex: 1;
    justify-content: flex-end;
  }
  .test-prompt-heading .cute-dropdown {
    width: 150px;
  }
  .test-result pre {
    max-height: 170px;
  }
}
</style>
