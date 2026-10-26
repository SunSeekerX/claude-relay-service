<template>
  <section aria-labelledby="available-routes-title" class="access-panel glass-strong">
    <header class="access-heading">
      <div>
        <h3 id="available-routes-title"><i class="i-lucide-route" />我的可用入口</h3>
        <p>选择协议、入口和模型，即可复制配置或测试。</p>
      </div>
      <span class="access-muted">{{ protocolEntries.length }} 个入口</span>
    </header>
    <SegmentedTabs
      v-model="selectedFormat"
      class="protocol-tabs"
      :style="protocolColors"
      :tabs="protocolTabs"
    />
    <div class="access-workspace">
      <nav aria-label="选择调用入口" class="access-entries">
        <p class="access-section-label">调用入口</p>
        <button
          v-for="entry in protocolEntries"
          :key="entry.selectionId"
          :aria-pressed="selectedId === entry.selectionId"
          class="access-entry"
          :class="{ 'is-selected': selectedId === entry.selectionId }"
          type="button"
          @click="selectedId = entry.selectionId"
        >
          <span class="access-entry-title"
            ><span>{{ entry.name }}</span
            ><i v-if="selectedId === entry.selectionId" class="i-lucide-check"
          /></span>
          <span class="access-entry-target">{{ targetLabel(entry) }}</span>
          <span class="access-entry-meta"
            ><span v-if="entry.isDefault" class="access-badge">默认</span
            ><span v-if="entry.status !== 'configured'" class="access-unavailable">{{
              statusLabels[entry.status] ?? entry.status
            }}</span
            ><span v-else>{{ modelsFor(entry).length }} 个模型</span></span
          >
        </button>
        <p v-if="!protocolEntries.length" class="access-empty">
          该协议暂无入口，请联系管理员开通。
        </p>
        <details v-if="unavailableEntries.length" class="access-config">
          <summary>不可用入口（{{ unavailableEntries.length }}）</summary>
          <p v-for="entry in unavailableEntries" :key="entry.code">
            {{ entry.name }}：{{ statusLabels[entry.status] ?? '未开放此协议' }}
          </p>
        </details>
      </nav>
      <div class="access-content">
        <header class="access-selection">
          <div>
            <h4>{{ selectedEntry?.name ?? '尚未开通' }}</h4>
            <p>
              {{
                selectedEntry ? targetLabel(selectedEntry) : '请联系管理员确认此 Key 的服务权限。'
              }}
            </p>
          </div>
          <span v-if="selectedEntry?.isDefault" class="access-badge">{{
            selectedEntry.ordinary ? '普通地址默认' : '协议默认入口'
          }}</span>
        </header>
        <p v-if="selectedEntry?.description" class="access-description">
          {{ selectedEntry.description }}
        </p>
        <div class="access-model-heading">
          <label for="access-model-search"
            >可用模型 <span>{{ selectedModels.length }}</span></label
          ><input
            id="access-model-search"
            v-model="modelSearch"
            class="form-input"
            placeholder="搜索模型"
            type="search"
          />
        </div>
        <div aria-label="选择测试和配置使用的模型" class="access-models" role="group">
          <button
            v-for="model in visibleModels"
            :key="model.id"
            :aria-label="model.id"
            :aria-pressed="selectedModel === model.id"
            class="access-model"
            :class="{ 'is-selected': selectedModel === model.id }"
            type="button"
            @click="selectedModel = model.id"
          >
            <span class="access-model-id">{{ model.id }}</span
            ><span class="access-model-meta"
              ><span>{{ modelSourceLabel(model.source) }}</span
              ><span v-if="model.interfaceSupport === 'unknown'">接口能力未确认</span
              ><span class="access-model-state" :class="`state-${model.availability ?? 'unknown'}`"
                ><i />{{ availabilityLabel(model.availability) }}</span
              ></span
            >
          </button>
          <p v-if="!visibleModels.length" class="access-empty">
            {{
              modelSearch
                ? '没有匹配的模型，试试其他名称。'
                : selectedEntry?.status === 'configured'
                  ? '暂无模型，请联系管理员同步或配置。'
                  : '此入口当前不可用。'
            }}
          </p>
        </div>
        <div class="access-chosen-model">
          <span
            >当前模型：<strong>{{ selectedModel || '尚未选择' }}</strong></span
          ><button
            class="access-text-button"
            :disabled="!selectedModel"
            type="button"
            @click="copyText(selectedModel)"
          >
            <i class="i-lucide-copy" />复制模型名
          </button>
        </div>
        <p v-if="selectedDetail?.availabilityReason" class="access-footnote">
          {{ selectedDetail.availabilityReason }}
        </p>
        <div class="access-addresses">
          <div class="access-address">
            <span>客户端地址 <span class="access-muted">Base URL</span></span>
            <div>
              <code>{{ clientBaseUrl || '—' }}</code
              ><button
                class="access-copy"
                :disabled="!clientBaseUrl"
                title="复制客户端地址"
                type="button"
                @click="copyText(clientBaseUrl)"
              >
                <i class="i-lucide-copy" />复制
              </button>
            </div>
          </div>
          <div class="access-address">
            <span>完整请求地址</span>
            <div>
              <code>{{ requestUrl || '—' }}</code
              ><button
                class="access-copy"
                :disabled="!requestUrl"
                title="复制完整请求地址"
                type="button"
                @click="copyText(requestUrl)"
              >
                <i class="i-lucide-copy" />复制
              </button>
            </div>
          </div>
        </div>
        <div class="access-actions">
          <button
            class="btn btn-secondary"
            :disabled="!canUse"
            type="button"
            @click="copyText(clientConfig)"
          >
            <i class="i-lucide-copy" />复制接入配置</button
          ><button
            class="btn btn-primary"
            :disabled="!canUse || !apiKey"
            :title="
              apiKey
                ? '发起实际模型请求，会计入此 Key 的用量'
                : '请先输入并查询此页面对应的完整 API Key'
            "
            type="button"
            @click="openTest"
          >
            <i class="i-lucide-play" />测试所选模型
          </button>
        </div>
        <p class="access-footnote">
          {{
            apiKey
              ? '测试会计入当前 Key 用量。列表状态供参考，请求时会再次检查。'
              : '输入并查询此 Key 后可测试；复制配置时请填入自己的 Key。'
          }}
        </p>
        <details class="access-config">
          <summary>查看配置示例</summary>
          <pre>{{ selectedModel ? clientConfig : '选择模型后显示配置示例。' }}</pre>
        </details>
      </div>
    </div>
  </section>
  <UnifiedTestModal
    :key="`${testSelection?.selectionId}:${testSelection?.format}:${testSelection?.model}`"
    :api-key-name="testSelection?.name ?? ''"
    :api-key-value="apiKey"
    :base-path="testSelection?.basePath ?? ''"
    :expected-api-key-id="apiId"
    :interface-format="testSelection?.format ?? ''"
    :legacy-provider="testSelection?.legacyProvider ?? ''"
    mode="apikey"
    :model-details="testSelection?.details ?? []"
    :preferred-model="testSelection?.model ?? ''"
    :route-code="testSelection?.routeCode ?? ''"
    :route-models="testSelection?.models ?? []"
    :service-type="testService"
    :show="showTest"
    @close="showTest = false"
  />
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useThemeStore } from '@/stores/theme'
import SegmentedTabs from '@/components/common/segmented_tabs.vue'
import UnifiedTestModal from '@/components/common/unified_test_modal.vue'
import { copyText } from '@/libs/tools'
import { routeAddress, ROUTE_STATUS_LABELS, modelSourceLabel } from '@/libs/relay_routing'

const props = defineProps({
  routing: { type: Object, default: () => ({ defaults: {}, routes: [], legacyTargets: [] }) },
  apiKey: { type: String, default: '' },
  apiId: { type: String, default: '' }
})
const formats = [
  {
    value: 'claude-messages',
    label: 'Claude Messages',
    path: '/v1/messages',
    provider: 'claude',
    base: '/api',
    icon: 'i-lucide-sparkles'
  },
  {
    value: 'openai-chat',
    label: 'Chat Completions',
    path: '/v1/chat/completions',
    provider: 'openai',
    base: '/openai/native',
    icon: 'i-lucide-messages-square'
  },
  {
    value: 'openai-responses',
    label: 'Responses',
    path: '/v1/responses',
    provider: 'openai',
    base: '/openai',
    icon: 'i-lucide-code'
  },
  {
    value: 'gemini-generate',
    label: 'Gemini',
    path: '/v1beta/models',
    provider: 'gemini',
    base: '/gemini',
    icon: 'i-lucide-orbit'
  }
]
const selectedFormat = ref('claude-messages')
const selectedId = ref('ordinary')
const selectedModel = ref('')
const modelSearch = ref('')
const showTest = ref(false)
const testSelection = ref(null)
const themeStore = useThemeStore()
const statusLabels = ROUTE_STATUS_LABELS
const activeFormat = computed(() => formats.find((format) => format.value === selectedFormat.value))
const protocolTabs = formats.map((format) => ({
  key: format.value,
  label: format.label,
  icon: format.icon
}))
const protocolColors = computed(() => ({
  '--route-claude-color': themeStore.isDarkMode ? '#fbbf24' : '#92400e',
  '--route-chat-color': themeStore.isDarkMode ? '#34d399' : '#047857',
  '--route-responses-color': themeStore.isDarkMode ? '#60a5fa' : '#1d4ed8',
  '--route-gemini-color': themeStore.isDarkMode ? '#c4b5fd' : '#6d28d9'
}))
const modelsFor = (entry) => entry?.modelsByFormat?.[selectedFormat.value] ?? entry?.models ?? []
const protocolEntries = computed(() => {
  const format = selectedFormat.value
  const defaultCode = props.routing.defaults[format]
  const defaultRoute = props.routing.routes.find((route) => route.code === defaultCode)
  const legacy = props.routing.legacyTargets?.find(
    (target) => target.provider === activeFormat.value.provider
  )
  const entries = []
  if (defaultCode || legacy)
    entries.push({
      ...(defaultCode ? defaultRoute : legacy),
      selectionId: 'ordinary',
      ordinary: true,
      isDefault: true,
      name: '使用默认入口',
      targetName: defaultCode ? (defaultRoute?.targetName ?? defaultCode) : legacy?.targetName,
      status: defaultCode ? (defaultRoute?.status ?? 'deleted') : (legacy.status ?? 'configured'),
      description: defaultCode ? `管理员默认：${defaultRoute?.name ?? defaultCode}` : '',
      basePath: props.routing.defaultBasePathsByFormat?.[format] ?? activeFormat.value.base,
      modelsByFormat: {
        [format]: (props.routing.defaultModelDetailsByFormat?.[format] ?? []).map(
          (model) => model.id
        )
      },
      modelDetailsByFormat: props.routing.defaultModelDetailsByFormat ?? {}
    })
  entries.push(
    ...props.routing.routes
      .filter((route) => route.formats.some((item) => item.value === format))
      .map((route) => ({
        ...route,
        selectionId: `route:${route.code}`,
        isDefault: defaultCode === route.code
      }))
  )
  entries.push(
    ...(props.routing.legacyTargets ?? [])
      .filter(
        (target) =>
          target.formats?.some((item) => item.value === format) &&
          target.provider !== activeFormat.value.provider
      )
      .map((target) => ({
        ...target,
        selectionId: `legacy:${target.provider}`,
        legacyProvider: target.provider,
        name: `${target.label} ${target.targetKind === 'shared' ? '共享池' : '原有绑定'}`,
        basePath: target.basePathsByFormat[format],
        status: target.status ?? 'configured'
      }))
  )
  return entries
})
const unavailableEntries = computed(() =>
  props.routing.routes.filter((route) => !route.formats.length)
)
const selectedEntry = computed(() =>
  protocolEntries.value.find((entry) => entry.selectionId === selectedId.value)
)
const selectedModels = computed(() => modelsFor(selectedEntry.value))
const modelDetails = computed(
  () => selectedEntry.value?.modelDetailsByFormat?.[selectedFormat.value] ?? []
)
const detailMap = computed(() => new Map(modelDetails.value.map((model) => [model.id, model])))
const visibleModels = computed(() =>
  selectedModels.value
    .filter((id) => id.toLowerCase().includes(modelSearch.value.trim().toLowerCase()))
    .map((id) => detailMap.value.get(id) ?? { id, source: 'unconfirmed', availability: 'unknown' })
)
const selectedDetail = computed(() => detailMap.value.get(selectedModel.value))
const baseUrl = computed(() =>
  selectedEntry.value ? routeAddress(selectedEntry.value.basePath) : ''
)
const clientBaseUrl = computed(() =>
  baseUrl.value
    ? `${baseUrl.value}${['openai-chat', 'openai-responses'].includes(selectedFormat.value) ? '/v1' : ''}`
    : ''
)
const requestUrl = computed(() =>
  baseUrl.value
    ? `${baseUrl.value}${activeFormat.value.path}${selectedFormat.value === 'gemini-generate' ? `/${encodeURIComponent(selectedModel.value || 'MODEL')}:generateContent` : ''}`
    : ''
)
const targetLabel = (entry) =>
  `${{ group: '分组', shared: '共享池', account: '账号' }[entry.targetKind] ?? '目标'}：${entry.targetName || '未配置'}`
const availabilityLabel = (state) =>
  ({ ready: '可调度', blocked: '暂不可用', unknown: '待确认' })[state] ?? '待确认'
const canUse = computed(() =>
  Boolean(selectedEntry.value?.status === 'configured' && selectedModel.value)
)
const quoteShell = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'"
const clientConfig = computed(() => {
  if (selectedFormat.value === 'claude-messages')
    return [
      `export ANTHROPIC_BASE_URL=${quoteShell(baseUrl.value)}`,
      "export ANTHROPIC_AUTH_TOKEN='YOUR_API_KEY'",
      `export ANTHROPIC_MODEL=${quoteShell(selectedModel.value)}`
    ].join('\n')
  if (selectedFormat.value === 'gemini-generate')
    return `POST ${requestUrl.value}\nx-goog-api-key: YOUR_API_KEY`
  return [
    `base_url = ${JSON.stringify(clientBaseUrl.value)}`,
    'api_key = "YOUR_API_KEY"',
    `model = ${JSON.stringify(selectedModel.value)}`
  ].join('\n')
})
const testService = computed(
  () =>
    ({
      'claude-messages': 'claude',
      'openai-chat': 'openai',
      'openai-responses': 'openai',
      'gemini-generate': 'gemini'
    })[testSelection.value?.format] ?? 'claude'
)
const openTest = () => {
  if (!canUse.value || !props.apiKey) return
  const entry = selectedEntry.value
  testSelection.value = {
    selectionId: entry.selectionId,
    name: entry.name,
    basePath: entry.basePath,
    format: selectedFormat.value,
    model: selectedModel.value,
    routeCode: entry.ordinary || entry.legacyProvider ? '' : entry.code,
    legacyProvider: entry.legacyProvider ?? '',
    details: modelDetails.value,
    models: [
      selectedModel.value,
      ...selectedModels.value.filter((id) => id !== selectedModel.value)
    ]
  }
  showTest.value = true
}
watch(selectedFormat, () => {
  selectedId.value = 'ordinary'
  modelSearch.value = ''
})
watch(
  protocolEntries,
  (entries) => {
    if (!entries.some((entry) => entry.selectionId === selectedId.value))
      selectedId.value = entries[0]?.selectionId ?? ''
  },
  { immediate: true }
)
watch(selectedId, () => {
  modelSearch.value = ''
})
watch(
  selectedModels,
  (models) => {
    if (!models.includes(selectedModel.value)) selectedModel.value = models[0] ?? ''
  },
  { immediate: true }
)
</script>

<style scoped>
.access-panel {
  padding: 16px;
  border: 1px solid var(--border-color, #d1d5db);
  border-radius: 16px;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  font-size: 14px;
}
.access-heading,
.access-selection,
.access-model-heading,
.access-chosen-model {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.access-heading {
  margin-bottom: 12px;
}
.access-heading h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 650;
  margin: 0;
}
.access-heading h3 i {
  color: var(--primary-color);
}
.access-heading p,
.access-selection p,
.access-description {
  margin-top: 4px;
  color: var(--text-secondary);
}
.access-muted {
  color: var(--text-muted);
  white-space: nowrap;
}
.access-workspace {
  display: grid;
  grid-template-columns: minmax(200px, 260px) minmax(0, 1fr);
  gap: 20px;
  margin-top: 16px;
}
.access-entries {
  min-width: 0;
  border-right: 1px solid var(--border-color);
  padding-right: 16px;
}
.access-section-label {
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.access-entry {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 10px;
  margin: 4px 0;
  white-space: normal;
  color: var(--text-primary);
}
.access-entry:hover {
  background: var(--surface-muted);
}
.access-entry.is-selected {
  border-color: color-mix(in srgb, var(--primary-color) 50%, transparent);
  background: var(--surface-muted);
}
.access-entry-title {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.access-entry-title i {
  flex-shrink: 0;
  color: var(--primary-color);
}
.access-entry-target {
  display: block;
  color: var(--text-secondary);
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.access-entry-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  color: var(--text-muted);
}
.access-badge {
  display: inline-flex;
  border-radius: 4px;
  padding: 1px 6px;
  color: var(--primary-color);
  background: color-mix(in srgb, var(--primary-color) 10%, transparent);
  white-space: nowrap;
}
.access-unavailable {
  color: var(--warning-color, #b45309);
}
.access-content {
  min-width: 0;
}
.access-selection {
  margin-bottom: 12px;
}
.access-selection h4 {
  font-size: 16px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.access-model-heading {
  margin: 12px 0 8px;
}
.access-model-heading label {
  font-weight: 600;
  white-space: nowrap;
}
.access-model-heading label span {
  color: var(--text-muted);
  font-weight: 400;
  margin-left: 4px;
}
.access-model-heading input {
  max-width: 230px;
  min-width: 0;
}
.access-models {
  max-height: 224px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}
.access-model {
  display: block;
  width: 100%;
  padding: 8px 10px;
  text-align: left;
  white-space: normal;
  color: var(--text-primary);
  border-bottom: 1px solid var(--divider-color, var(--border-color));
}
.access-model:last-child {
  border-bottom: 0;
}
.access-model:hover,
.access-model.is-selected {
  background: var(--surface-muted);
}
.access-model.is-selected {
  box-shadow: inset 3px 0 var(--primary-color);
}
.access-model-id {
  display: block;
  font-family: var(--font-code, monospace);
  overflow-wrap: anywhere;
}
.access-model-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 3px;
  color: var(--text-secondary);
}
.access-model-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.access-model-state i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}
.state-ready i {
  background: var(--success-color, #059669);
}
.state-blocked i {
  background: var(--warning-color, #d97706);
}
.access-chosen-model {
  margin-top: 10px;
  flex-wrap: wrap;
}
.access-chosen-model strong {
  font-family: var(--font-code, monospace);
  font-weight: 500;
  overflow-wrap: anywhere;
}
.access-text-button {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  color: var(--primary-color);
  white-space: nowrap;
}
.access-footnote {
  color: var(--text-secondary);
  margin-top: 6px;
}
.access-addresses {
  margin-top: 14px;
  border-top: 1px solid var(--border-color);
  padding-top: 12px;
}
.access-address + .access-address {
  margin-top: 10px;
}
.access-address > span {
  display: block;
  color: var(--text-secondary);
  margin-bottom: 4px;
}
.access-address > div {
  display: flex;
  align-items: start;
  gap: 8px;
}
.access-address code {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: normal;
  line-height: 1.5;
}
.access-copy {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 2px 5px;
  color: var(--primary-color);
}
.access-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.access-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.access-config {
  margin-top: 10px;
  color: var(--text-secondary);
}
.access-config summary {
  cursor: pointer;
}
.access-config pre {
  color: var(--text-primary);
  background: var(--surface-muted);
  border-radius: 8px;
  padding: 10px;
  margin-top: 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
}
.access-empty {
  color: var(--text-secondary);
  padding: 14px 10px;
}
.access-panel button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.access-panel button:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 2px;
}
.protocol-tabs :deep(.seg-tabs__item:nth-child(1)) {
  --protocol-tab-color: var(--route-claude-color);
}
.protocol-tabs :deep(.seg-tabs__item:nth-child(2)) {
  --protocol-tab-color: var(--route-chat-color);
}
.protocol-tabs :deep(.seg-tabs__item:nth-child(3)) {
  --protocol-tab-color: var(--route-responses-color);
}
.protocol-tabs :deep(.seg-tabs__item:nth-child(4)) {
  --protocol-tab-color: var(--route-gemini-color);
}
.protocol-tabs :deep(.seg-tabs__item) {
  --primary-color: var(--protocol-tab-color);
  --control-accent-text: var(--protocol-tab-color);
}
.protocol-tabs :deep(.seg-tabs__icon) {
  color: var(--protocol-tab-color);
}
.protocol-tabs :deep(.seg-tabs__item.is-active) {
  color: var(--protocol-tab-color);
  background: color-mix(in srgb, var(--protocol-tab-color) 12%, var(--surface-color, white));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--protocol-tab-color) 28%, transparent);
}
@media (max-width: 640px) {
  .access-panel {
    padding: 12px;
  }
  .access-workspace {
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
  }
  .access-entries {
    border-right: 0;
    border-bottom: 1px solid var(--border-color);
    padding-right: 0;
    padding-bottom: 10px;
    max-height: 240px;
    overflow-y: auto;
  }
  .access-heading {
    align-items: start;
  }
  .access-model-heading {
    gap: 8px;
  }
  .access-model-heading input {
    max-width: 180px;
    width: 55%;
  }
  .access-selection {
    align-items: start;
    flex-wrap: wrap;
  }
}
</style>
