<template>
  <section class="min-w-0 w-full max-w-full space-y-3 text-sm">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-gray-500 dark:text-gray-400">
        统一维护调用入口，再在创建或编辑 Key 时授权。账号分组、模型映射和转换选项由管理员配置。
      </p>
      <div class="flex gap-2">
        <button class="btn btn-secondary px-3 py-2" :disabled="loading" @click="load">刷新</button
        ><button class="btn btn-primary px-3 py-2" @click="openEditor()">创建入口</button>
      </div>
    </div>
    <p v-if="error" class="text-red-600 dark:text-red-400">{{ error }}</p>
    <input
      v-model="search"
      aria-label="搜索调用入口"
      class="form-input w-full sm:max-w-sm"
      placeholder="搜索入口名称或标识"
    />
    <div class="max-h-[60vh] overflow-auto rounded-xl border border-gray-200 dark:border-gray-700">
      <table class="w-full min-w-[760px] text-left">
        <thead class="sticky top-0 bg-gray-100 dark:bg-gray-800">
          <tr>
            <th class="p-3">
              <button @click="ascending = !ascending">入口名称 {{ ascending ? '↑' : '↓' }}</button>
            </th>
            <th class="p-3">上游平台</th>
            <th class="p-3">接口格式</th>
            <th class="p-3">状态</th>
            <th class="p-3">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
          <tr v-for="route in visibleRoutes" :key="route.code">
            <td class="p-3">
              <button class="font-medium" title="复制入口名称" @click="copyText(route.name)">
                {{ route.name }}</button
              ><button
                class="mt-1 block text-gray-500"
                title="复制入口标识"
                @click="copyText(route.code)"
              >
                {{ route.code }}
              </button>
            </td>
            <td class="p-3">{{ metadata.providers[route.provider]?.label }}</td>
            <td class="p-3">{{ route.formats.map(formatLabel).join('、') }}</td>
            <td class="p-3">{{ route.isActive ? '已启用' : '已停用' }}</td>
            <td class="p-3">
              <div class="flex gap-3">
                <button class="text-blue-600 dark:text-blue-400" @click="openEditor(route)">
                  编辑</button
                ><button
                  class="text-gray-600 dark:text-gray-300"
                  @click="copyText(routeAddress(`/r/${route.code}`))"
                >
                  复制地址</button
                ><button class="text-red-600 dark:text-red-400" @click="deleting = route">
                  删除
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="visibleRoutes.length === 0">
            <td class="p-6 text-center text-gray-500" colspan="5">
              {{ loading ? '正在加载...' : '暂无匹配入口，可点击“创建入口”配置' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <AppDialog
      v-model="editorOpen"
      :closable="!saving"
      :close-on-mask="false"
      icon="i-lucide-route"
      size="xl"
      title="调用入口配置"
    >
      <form id="relay-route-form" class="space-y-4" @submit.prevent="save(false)">
        <p v-if="formError" class="text-red-600 dark:text-red-400">{{ formError }}</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <label
            >入口名称<input
              v-model="form.name"
              class="form-input mt-1 w-full"
              maxlength="100"
              required
          /></label>
          <label
            >地址标识<input
              v-model="form.code"
              class="form-input mt-1 w-full"
              :disabled="editing"
              maxlength="48"
              pattern="[a-z][a-z0-9-]*"
              required
            /><span class="mt-1 block text-gray-500"
              >创建后固定，用于 /r/标识；修改名称不影响地址。</span
            ></label
          >
          <div>
            <label class="mb-1 block">上游平台</label
            ><CustomDropdown
              :model-value="form.provider"
              :options="providerOptions"
              @update:model-value="changeProvider"
            />
          </div>
          <div>
            <label class="mb-1 block">绑定账号或分组</label
            ><CustomDropdown
              v-model="form.binding"
              :disabled="targetsLoading"
              :options="
                targets.map((target) => ({
                  value: target.value,
                  label: `${target.kind === 'group' ? '分组' : '账号'} · ${target.label}`
                }))
              "
              placeholder="请选择绑定目标"
            />
          </div>
        </div>
        <label class="block"
          >单账号公开名称<input
            v-model="form.targetName"
            class="form-input mt-1 w-full sm:max-w-sm"
            maxlength="100"
            placeholder="用户可见的名称"
            :required="!form.binding.startsWith('group:')"
          /><span class="mt-1 block text-gray-500"
            >绑定分组时用户看到分组名称；单账号仅展示这里填写的名称。</span
          ></label
        >
        <div>
          <p class="mb-2 font-medium">开放的接口格式</p>
          <div class="flex flex-wrap gap-4">
            <label
              v-for="format in compatibleFormats"
              :key="format.value"
              class="flex items-center gap-2"
              ><input
                v-model="form.formats"
                class="h-4 w-4"
                type="checkbox"
                :value="format.value"
              />{{ format.label }}</label
            >
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="mb-1 block">模型开放方式</label
            ><CustomDropdown
              v-model="form.modelMode"
              :options="[
                { value: 'upstream', label: '沿用上游模型，并开放映射别名' },
                { value: 'mapped-only', label: '仅开放映射别名' }
              ]"
            />
          </div>
          <div>
            <label class="mb-1 block">响应模型名称</label
            ><CustomDropdown
              v-model="form.echoModel"
              :disabled="
                form.formats.length > 0 &&
                form.formats.every((format) => format === 'gemini-generate')
              "
              :options="[
                { value: 'requested', label: '返回用户请求的模型别名' },
                { value: 'upstream', label: '保留上游或转换器原有回显' }
              ]"
            />
          </div>
        </div>
        <div>
          <div class="mb-2 flex items-center justify-between">
            <h4 class="font-medium">模型映射</h4>
            <button
              class="btn btn-secondary px-2 py-1"
              type="button"
              @click="mappings.push({ alias: '', model: '' })"
            >
              添加映射
            </button>
          </div>
          <div
            v-for="(mapping, index) in mappings"
            :key="index"
            class="mb-2 flex flex-wrap items-center gap-2"
          >
            <input
              v-model="mapping.alias"
              aria-label="用户模型别名"
              class="form-input min-w-0 flex-1"
              maxlength="200"
              placeholder="用户调用的别名"
              required
            /><span>→</span
            ><input
              v-model="mapping.model"
              aria-label="入口目标模型"
              class="form-input min-w-0 flex-1"
              maxlength="200"
              placeholder="入口目标模型"
              required
            /><button
              class="text-red-600 dark:text-red-400"
              type="button"
              @click="mappings.splice(index, 1)"
            >
              移除
            </button>
          </div>
          <p v-if="mappings.length === 0" class="text-gray-500">
            尚未配置映射，将按原模型名调用。选择“仅开放映射别名”时，需要添加映射才能调用。
          </p>
          <p class="mt-2 text-gray-500">
            入口先解析用户别名，账号原有部署映射继续生效；按目标模型和现有规则计费。Gemini 原生
            modelVersion 保留真实版本。
          </p>
        </div>
        <div class="rounded-xl bg-gray-50 p-3 dark:bg-gray-800">
          <h4 class="mb-2 font-medium">转换器配置</h4>
          <template v-if="form.provider === 'openai' && form.formats.includes('claude-messages')"
            ><label class="mb-1 block">Claude Messages → Responses：并行工具调用</label
            ><CustomDropdown
              v-model="parallelToolCalls"
              :options="[
                { value: 'inherit', label: '沿用转换器默认' },
                { value: 'allow', label: '允许（仍尊重请求中的禁用设置）' },
                { value: 'deny', label: '关闭' }
              ]"
          /></template>
          <p v-else class="text-gray-500">
            所选接口使用现有原生处理器或转换器默认配置，当前没有额外可覆盖参数。
          </p>
          <label class="mb-1 mt-3 block">本地估算使用的词表</label
          ><CustomDropdown v-model="form.tokenizerOverride" :options="tokenizerOptions" />
          <p class="mt-2 text-gray-500">
            原生计数保持原行为；目标无等价 count_tokens
            时使用本地估算，并明确标记来源。词表和计数节点可在设置的“词表管理”中维护。
          </p>
        </div>
        <label class="block"
          >入口说明<textarea
            v-model="form.description"
            class="form-input mt-1 w-full"
            maxlength="500"
            rows="2"
          />
        </label>
        <label class="flex items-center gap-2"
          ><input v-model="form.isActive" class="h-4 w-4" type="checkbox" />启用此入口</label
        >
      </form>
      <template #footer>
        <DialogSaveActions
          class="w-full"
          :disabled="targetsLoading"
          form="relay-route-form"
          :loading="saving"
          @cancel="editorOpen = false"
          @save="save"
        />
      </template>
    </AppDialog>
    <ConfirmModal
      confirm-text="删除入口"
      :message="`删除“${deleting?.name ?? ''}”后，已授权 Key 的该入口和默认配置将显示不可用，不会自动切换。`"
      :show="Boolean(deleting)"
      title="删除调用入口"
      type="danger"
      @cancel="deleting = null"
      @confirm="remove"
    />
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import AppDialog from '@/components/common/app_dialog.vue'
import ConfirmModal from '@/components/common/confirm_modal.vue'
import CustomDropdown from '@/components/common/custom_dropdown.vue'
import {
  getRelayRoutesApi,
  getRelayRouteTargetsApi,
  createRelayRouteApi,
  updateRelayRouteApi,
  deleteRelayRouteApi,
  getTokenizerCatalogApi
} from '@/libs/http_apis'
import { isOk } from '@/libs/http_envelope'
import { copyText, showToast } from '@/libs/tools'
import { routeAddress } from '@/libs/relay_routing'

const metadata = reactive({ routes: [], formats: [], providers: {} })
const loading = ref(false)
const error = ref('')
const search = ref('')
const ascending = ref(true)
const editorOpen = ref(false)
const editing = ref(false)
const saving = ref(false)
const formError = ref('')
const targetsLoading = ref(false)
const targets = ref([])
const deleting = ref(null)
const mappings = ref([])
const parallelToolCalls = ref('inherit')
const tokenizerOptions = ref([{ value: '', label: '沿用全局模型规则' }])
const form = reactive({
  code: '',
  name: '',
  provider: 'claude',
  binding: '',
  targetName: '',
  formats: ['claude-messages'],
  modelMode: 'upstream',
  echoModel: 'requested',
  tokenizerOverride: '',
  description: '',
  isActive: true
})
let targetLoadSequence = 0
const visibleRoutes = computed(() =>
  metadata.routes
    .filter((route) =>
      `${route.name} ${route.code}`.toLowerCase().includes(search.value.toLowerCase())
    )
    .sort((a, b) => (ascending.value ? 1 : -1) * a.name.localeCompare(b.name, 'zh-CN'))
)
const providerOptions = computed(() =>
  Object.entries(metadata.providers).map(([value, provider]) => ({ value, label: provider.label }))
)
const compatibleFormats = computed(() =>
  metadata.formats.filter((format) =>
    metadata.providers[form.provider]?.formats.includes(format.value)
  )
)
const formatLabel = (value) =>
  metadata.formats.find((format) => format.value === value)?.label ?? value
const load = async () => {
  loading.value = true
  error.value = ''
  try {
    const response = await getRelayRoutesApi()
    if (!isOk(response)) throw new Error(response.msg)
    Object.assign(metadata, response.data)
  } catch (cause) {
    error.value = cause.message
  } finally {
    loading.value = false
  }
}
const loadTargets = async () => {
  const sequence = ++targetLoadSequence
  targetsLoading.value = true
  try {
    const response = await getRelayRouteTargetsApi(form.provider)
    if (sequence !== targetLoadSequence) return
    if (!isOk(response)) throw new Error(response.msg)
    targets.value = response.data
  } catch (cause) {
    if (sequence === targetLoadSequence) formError.value = cause.message
  } finally {
    if (sequence === targetLoadSequence) targetsLoading.value = false
  }
}
const openEditor = (route = null) => {
  editing.value = route !== null
  formError.value = ''
  Object.assign(
    form,
    {
      code: '',
      name: '',
      provider: 'claude',
      binding: '',
      targetName: '',
      formats: ['claude-messages'],
      modelMode: 'upstream',
      echoModel: 'requested',
      tokenizerOverride: '',
      description: '',
      isActive: true
    },
    route ? { ...route, formats: [...route.formats] } : {}
  )
  mappings.value = Object.entries(route?.modelMapping ?? {}).map(([alias, model]) => ({
    alias,
    model
  }))
  const parallel = route?.converterOptions?.['claude-messages']?.parallelToolCalls
  parallelToolCalls.value = parallel === undefined ? 'inherit' : parallel ? 'allow' : 'deny'
  editorOpen.value = true
  loadTargets()
  getTokenizerCatalogApi()
    .then((response) => {
      if (!isOk(response)) throw new Error(response.msg)
      tokenizerOptions.value = [
        { value: '', label: '沿用全局模型规则' },
        ...response.data.tokenizers
      ]
    })
    .catch((cause) => {
      formError.value = cause.message
    })
}
const changeProvider = (provider) => {
  form.provider = provider
  form.binding = ''
  targets.value = []
  form.formats = form.formats.filter((format) =>
    metadata.providers[provider].formats.includes(format)
  )
  parallelToolCalls.value = 'inherit'
  loadTargets()
}
const save = async (closeAfter = false) => {
  saving.value = true
  formError.value = ''
  try {
    const modelMapping = Object.create(null)
    for (const { alias, model } of mappings.value) {
      if (Object.hasOwn(modelMapping, alias.trim())) throw new Error('模型别名不能重复')
      modelMapping[alias.trim()] = model.trim()
    }
    const converterOptions =
      form.provider === 'openai' &&
      form.formats.includes('claude-messages') &&
      parallelToolCalls.value !== 'inherit'
        ? { 'claude-messages': { parallelToolCalls: parallelToolCalls.value === 'allow' } }
        : {}
    const payload = { ...form, modelMapping, converterOptions }
    const response = editing.value
      ? await updateRelayRouteApi(form.code, payload)
      : await createRelayRouteApi(payload)
    if (!isOk(response)) throw new Error(response.msg)
    editing.value = true
    if (closeAfter) editorOpen.value = false
    showToast('调用入口已保存', 'success')
    await load()
  } catch (cause) {
    formError.value = cause.message
  } finally {
    saving.value = false
  }
}
const remove = async () => {
  const route = deleting.value
  deleting.value = null
  try {
    const response = await deleteRelayRouteApi(route.code)
    if (!isOk(response)) throw new Error(response.msg)
    await load()
  } catch (cause) {
    error.value = cause.message
  }
}
onMounted(load)
</script>
