<template>
  <!-- OpenAI Responses：基本信息 / 模型白名单 / 模型映射 三分栏（两功能独立，非互斥 tab 模式） -->
  <div
    class="flex min-h-0 flex-col md:flex-row md:overflow-hidden"
    :class="[
      embedded || externalTab ? '' : 'rounded-xl border border-gray-200 dark:border-gray-700',
      externalTab ? '' : 'md:min-h-[420px]'
    ]"
  >
    <DialogSideNav v-if="!externalTab" v-model="activeTab" :tabs="tabs" />

    <div
      class="min-h-0 min-w-0 flex-1 space-y-4"
      :class="externalTab ? '' : 'overflow-y-auto px-1 py-1 md:px-4 md:py-2'"
    >
      <!-- ===== 基本信息 ===== -->
      <div v-show="currentTab === 'basic'" class="space-y-4">
        <div>
          <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >API 基础地址{{ isCreate ? ' *' : '' }}</label
          >
          <input
            class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
            placeholder="https://api.example.com/v1"
            :required="isCreate"
            type="url"
            :value="baseApi"
            @input="emit('update:baseApi', $event.target.value)"
          />
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            第三方 OpenAI 兼容 API 的基础地址，不要包含具体路径
          </p>
        </div>

        <div>
          <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >API 密钥{{ isCreate ? ' *' : '' }}</label
          >
          <div class="relative">
            <input
              class="form-input form-input--with-icon w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
              :placeholder="isCreate ? 'sk-xxxxxxxxxxxx' : '留空表示不更新'"
              :required="isCreate"
              :type="showApiKey ? 'text' : 'password'"
              :value="apiKey"
              @input="emit('update:apiKey', $event.target.value)"
            />
            <button
              class="password-toggle"
              type="button"
              @click="showApiKey = !showApiKey"
            >
              <i :class="showApiKey ? 'i-lucide-eye-off' : 'i-lucide-eye'" />
            </button>
          </div>
          <p v-if="!isCreate" class="mt-1 text-sm text-gray-500">留空表示不更新 API Key</p>
        </div>

        <div>
          <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >自定义 User-Agent</label
          >
          <input
            class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
            placeholder="留空则透传客户端 User-Agent"
            type="text"
            :value="userAgent"
            @input="emit('update:userAgent', $event.target.value)"
          />
        </div>

        <div>
          <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >Provider 端点类型</label
          >
          <CustomDropdown
            accent="blue"
            class="w-full"
            icon="i-lucide-route"
            :model-value="providerEndpoint"
            :options="providerEndpointOptions"
            placeholder="选择端点类型"
            @update:model-value="(v) => emit('update:providerEndpoint', v)"
          />
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Responses：含 chat/completions 也会转到 responses；自动则保持原始路径
          </p>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >每日额度限制 ($)</label
            >
            <input
              class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
              min="0"
              placeholder="0 表示不限制"
              step="0.01"
              type="number"
              :value="dailyQuota"
              @input="emit('update:dailyQuota', Number($event.target.value) || 0)"
            />
          </div>
          <div>
            <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >额度重置时间</label
            >
            <input
              class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
              type="time"
              :value="quotaResetTime"
              @input="emit('update:quotaResetTime', $event.target.value)"
            />
          </div>
        </div>

        <div>
          <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >最大并发任务数</label
          >
          <input
            class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
            min="0"
            placeholder="0 表示不限制"
            type="number"
            :value="maxConcurrentTasks"
            @input="emit('update:maxConcurrentTasks', Number($event.target.value) || 0)"
          />
        </div>
      </div>

      <!-- ===== 模型白名单（独立功能） ===== -->
      <div v-show="currentTab === 'whitelist'" class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="rounded-lg bg-blue-50 p-3 text-sm text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
            <i class="i-lucide-info mr-1" />
            限制<strong>哪些客户端模型</strong>可以调度到本账户。留空 = 不限制（全部可进）。
          </div>
          <button
            class="rounded-lg bg-emerald-100 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400"
            :disabled="fetching"
            type="button"
            @click="fetchUpstream"
          >
            <i class="mr-1" :class="fetching ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-cloud-download'" />
            从上游同步
          </button>
        </div>

        <div
          v-if="modelOptions.length > 0"
          class="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2"
        >
          <label
            v-for="model in modelOptions"
            :key="model"
            class="flex cursor-pointer items-center rounded-xl border p-3 transition-all hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
            :class="
              allowedModels.includes(model)
                ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/30'
                : 'border-gray-200 dark:border-gray-600'
            "
          >
            <input
              :checked="allowedModels.includes(model)"
              class="mr-2 text-blue-600 focus:ring-blue-500"
              type="checkbox"
              :value="model"
              @change="toggleAllowed(model, $event.target.checked)"
            />
            <span class="break-all text-sm font-medium text-gray-700 dark:text-gray-200">{{
              model
            }}</span>
          </label>
        </div>
        <p v-else class="text-sm text-gray-500">暂无模型列表，可手输或点「从上游同步」。</p>

        <div class="flex gap-2">
          <input
            v-model="customModel"
            class="form-input flex-1 border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
            placeholder="手输模型 ID 加入白名单"
            type="text"
            @keyup.enter="addCustomAllowed"
          />
          <button
            class="rounded-lg bg-blue-500 px-3 py-2 text-sm text-white hover:bg-blue-600"
            type="button"
            @click="addCustomAllowed"
          >
            添加
          </button>
        </div>
        <p class="text-sm text-gray-500 dark:text-gray-400">
          已选 {{ allowedModels.length }} 个
          <span v-if="allowedModels.length === 0">（不限制）</span>
          <button
            v-if="allowedModels.length > 0"
            class="ml-2 text-blue-500 hover:underline"
            type="button"
            @click="emit('update:allowedModels', [])"
          >
            清空
          </button>
        </p>
      </div>

      <!-- ===== 模型映射（独立功能） ===== -->
      <div v-show="currentTab === 'mapping'" class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div
            class="rounded-lg bg-purple-50 p-3 text-sm text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
          >
            <i class="i-lucide-info mr-1" />
            把客户端模型名改写成上游模型。支持前缀通配
            <code class="mx-0.5">gpt-*</code>
            →
            <code class="mx-0.5">gpt-5.4</code>
            ；目标含
            <code class="mx-0.5">*</code>
            时替换后缀。不限制调度（限制去「模型白名单」）。
          </div>
          <button
            class="rounded-lg bg-emerald-100 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400"
            :disabled="fetching"
            type="button"
            @click="fetchUpstream"
          >
            <i class="mr-1" :class="fetching ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-cloud-download'" />
            同步并预填
          </button>
        </div>

        <div class="space-y-2">
          <div
            v-if="localMappings.length === 0"
            class="rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500 dark:border-gray-600 dark:text-gray-400"
          >
            暂无映射。点「同步并预填」从上游拉模型并生成
            <code class="mx-1">客户端 → 上游</code>
            初值（默认同名，可再改），或下方手动添加。
          </div>
          <div
            v-for="(row, index) in localMappings"
            :key="index"
            class="flex items-center gap-2"
          >
            <input
              v-model="row.from"
              class="form-input flex-1 border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
              placeholder="客户端模型，如 gpt-*"
              type="text"
              @input="emitMappings"
            />
            <i class="i-lucide-arrow-right shrink-0 text-gray-400" />
            <input
              v-model="row.to"
              class="form-input flex-1 border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
              placeholder="上游模型"
              type="text"
              @input="emitMappings"
            />
            <button
              class="rounded-lg p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
              type="button"
              @click="removeMapping(index)"
            >
              <i class="i-lucide-trash-2" />
            </button>
          </div>
        </div>

        <button
          class="w-full rounded-xl border-2 border-dashed border-gray-300 px-4 py-2 text-gray-600 hover:border-gray-400 dark:border-gray-600 dark:text-gray-400"
          type="button"
          @click="addMapping"
        >
          <i class="i-lucide-plus mr-2" />
          添加映射
        </button>
        <p v-if="localMappings.length > 0" class="text-sm text-gray-500 dark:text-gray-400">
          共 {{ localMappings.length }} 条映射
          <button
            class="ml-2 text-blue-500 hover:underline"
            type="button"
            @click="clearMappings"
          >
            清空
          </button>
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

import DialogSideNav from '@/components/common/dialog_side_nav.vue'
import { isOk, msgOf } from '@/libs/http_envelope'
import * as httpApis from '@/libs/http_apis'
import { showToast } from '@/libs/tools'

const props = defineProps({
  // 父级侧栏接管时传入 basic|whitelist|mapping，隐藏内部导航只展示对应段
  externalTab: { type: String, default: '' },
  isCreate: { type: Boolean, default: false },
  accountId: { type: String, default: '' },
  embedded: { type: Boolean, default: true },
  baseApi: { type: String, default: '' },
  apiKey: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  providerEndpoint: { type: String, default: 'responses' },
  dailyQuota: { type: Number, default: 0 },
  quotaResetTime: { type: String, default: '00:00' },
  maxConcurrentTasks: { type: Number, default: 0 },
  // 白名单：客户端模型 ID 列表，空=不限制
  allowedModels: { type: Array, default: () => [] },
  // 映射行：[{from,to}]
  modelMappings: { type: Array, default: () => [] },
  providerEndpointOptions: {
    type: Array,
    default: () => [
      { value: 'responses', label: 'Responses（推荐）' },
      { value: 'auto', label: '自动（保持原始路径）' }
    ]
  }
})

const emit = defineEmits([
  'update:baseApi',
  'update:apiKey',
  'update:userAgent',
  'update:providerEndpoint',
  'update:dailyQuota',
  'update:quotaResetTime',
  'update:maxConcurrentTasks',
  'update:allowedModels',
  'update:modelMappings'
])

const tabs = [
  { key: 'basic', label: '基本信息', icon: 'i-lucide-sliders-horizontal' },
  { key: 'whitelist', label: '模型白名单', icon: 'i-lucide-circle-check' },
  { key: 'mapping', label: '模型映射', icon: 'i-lucide-shuffle' }
]

const activeTab = ref('basic')
const currentTab = computed(() => props.externalTab || activeTab.value)
const showApiKey = ref(false)
const fetching = ref(false)
const customModel = ref('')
const modelOptions = ref([])

// 本地可编辑映射副本（避免直接 mutate prop）
const localMappings = ref([])

watch(
  () => props.modelMappings,
  (rows) => {
    localMappings.value = Array.isArray(rows)
      ? rows.map((r) => ({ from: r.from || '', to: r.to || '' }))
      : []
  },
  { immediate: true, deep: true }
)

const emitMappings = () => {
  emit(
    'update:modelMappings',
    localMappings.value.map((r) => ({ from: r.from, to: r.to }))
  )
}

const addMapping = () => {
  localMappings.value.push({ from: '', to: '' })
  emitMappings()
}

const removeMapping = (index) => {
  localMappings.value.splice(index, 1)
  emitMappings()
}

const clearMappings = () => {
  localMappings.value = []
  emitMappings()
}

const toggleAllowed = (model, checked) => {
  const set = new Set(props.allowedModels || [])
  if (checked) {
    set.add(model)
  } else {
    set.delete(model)
  }
  emit('update:allowedModels', Array.from(set))
}

const addCustomAllowed = () => {
  const id = String(customModel.value || '').trim()
  if (!id) {
    return
  }
  if (!modelOptions.value.includes(id)) {
    modelOptions.value = [...modelOptions.value, id]
  }
  const set = new Set(props.allowedModels || [])
  set.add(id)
  emit('update:allowedModels', Array.from(set))
  customModel.value = ''
}

const fetchUpstream = async () => {
  try {
    fetching.value = true
    const payload = {}
    if (props.accountId) {
      payload.accountId = props.accountId
      if (props.baseApi?.trim()) {
        payload.baseApi = props.baseApi.trim()
      }
      if (props.apiKey?.trim()) {
        payload.apiKey = props.apiKey.trim()
      }
    } else {
      if (!props.baseApi?.trim() || !props.apiKey?.trim()) {
        showToast('请先在「基本信息」填写 API 地址和密钥', 'error')
        if (!props.externalTab) {
          activeTab.value = 'basic'
        }
        return
      }
      payload.baseApi = props.baseApi.trim()
      payload.apiKey = props.apiKey.trim()
    }

    const result = await httpApis.fetchOpenAIResponsesUpstreamModelsApi(payload)
    if (!isOk(result) || !Array.isArray(result.data?.models)) {
      showToast(msgOf(result, '同步上游模型失败'), 'error')
      return
    }
    const models = result.data.models.filter((m) => typeof m === 'string' && m.trim())
    modelOptions.value = models

    // 必须看 currentTab：父级侧栏用 externalTab 时 activeTab 不会变
    const tab = currentTab.value
    if (tab === 'whitelist') {
      // 同步后默认全选进白名单（用户可再取消）
      emit('update:allowedModels', [...models])
      showToast(`已同步 ${models.length} 个模型到白名单`, 'success')
    } else if (tab === 'mapping') {
      // 去掉空白占位行，再按上游模型预填 from=to（已有 from 不覆盖）
      localMappings.value = localMappings.value.filter((row) => row.from?.trim() || row.to?.trim())
      const existing = new Set(localMappings.value.map((m) => m.from).filter(Boolean))
      let added = 0
      for (const id of models) {
        if (!existing.has(id)) {
          localMappings.value.push({ from: id, to: id })
          existing.add(id)
          added += 1
        }
      }
      emitMappings()
      showToast(
        added > 0
          ? `已同步 ${models.length} 个上游模型，预填 ${added} 条映射（可改名）`
          : `已同步 ${models.length} 个上游模型，映射表已是最新`,
        'success'
      )
    } else {
      showToast(`已同步 ${models.length} 个上游模型（可到白名单/映射使用）`, 'success')
    }
  } catch (error) {
    console.error(error)
    showToast(error?.message || '同步上游模型失败', 'error')
  } finally {
    fetching.value = false
  }
}

// 编辑回填：用已有白名单/映射键填充选项
watch(
  () => [props.allowedModels, props.modelMappings],
  () => {
    const ids = new Set(modelOptions.value)
    for (const m of props.allowedModels || []) {
      if (m) {
        ids.add(m)
      }
    }
    for (const row of props.modelMappings || []) {
      if (row?.from) {
        ids.add(row.from)
      }
      if (row?.to) {
        ids.add(row.to)
      }
    }
    modelOptions.value = Array.from(ids)
  },
  { immediate: true, deep: true }
)
</script>
