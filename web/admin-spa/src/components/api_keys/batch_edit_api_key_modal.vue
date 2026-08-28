<template>
  <ModalTransition @after-leave="onClosed">
    <div
      v-if="visible"
      class="modal fixed inset-0 z-50 flex items-center justify-center p-3"
    >
      <div
        class="modal-content mx-auto flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden p-2.5 sm:p-3"
      >
        <div class="mb-3 flex items-center justify-between">
          <div class="flex items-center gap-2 sm:gap-3">
            <div
              class="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 sm:h-10 sm:w-10 sm:rounded-xl"
            >
              <i class="i-lucide-pen-line text-sm text-white sm:text-base" />
            </div>
            <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100 sm:text-xl">
              批量编辑 API Keys ({{ selectedCount }} 个)
            </h3>
          </div>
          <button
            class="p-1 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
            @click="requestClose"
          >
            <i class="i-lucide-x text-lg sm:text-xl" />
          </button>
        </div>

        <form
          class="flex min-h-0 flex-1 flex-col overflow-hidden"
          @submit.prevent="batchUpdateApiKeys"
        >
          <div class="modal-scroll-content custom-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto sm:space-y-3">
          <!-- 说明文本 -->
          <div class="rounded-lg bg-blue-50 p-4 dark:bg-blue-900/20">
            <div class="flex items-start gap-3">
              <i class="i-lucide-info mt-1 text-blue-500" />
              <div>
                <p class="text-sm font-medium text-blue-800 dark:text-blue-300">批量编辑说明</p>
                <p class="mt-1 text-sm text-blue-700 dark:text-blue-400">
                  以下设置将应用到所选的 {{ selectedCount }} 个 API
                  Key。只有填写或修改的字段才会被更新，空白字段将保持原值不变。
                </p>
              </div>
            </div>
          </div>

          <!-- 标签编辑 -->
          <div>
            <label
              class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300 sm:mb-3 sm:text-sm"
            >
              标签 (批量操作)
            </label>
            <div class="space-y-3">
              <!-- 标签操作模式选择 -->
              <CuteOptionCards
                v-model="tagOperation"
                :columns="2"
                :options="tagOperationOptions"
                size="sm"
              />

              <!-- 标签编辑区域 -->
              <div v-if="tagOperation !== 'none'" class="space-y-3">
                <!-- 已选择的标签 -->
                <div v-if="form.tags.length > 0">
                  <div class="mb-2 text-sm font-medium text-gray-600 dark:text-gray-400">
                    {{
                      tagOperation === 'replace'
                        ? '新标签列表:'
                        : tagOperation === 'add'
                          ? '要添加的标签:'
                          : '要移除的标签:'
                    }}
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <span
                      v-for="(tag, index) in form.tags"
                      :key="'selected-' + index"
                      class="inline-flex items-center gap-1 rounded-full bg-blue-100 px-3 py-1 text-sm text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                    >
                      {{ tag }}
                      <button
                        class="ml-1 hover:text-blue-900"
                        type="button"
                        @click="removeTag(index)"
                      >
                        <i class="i-lucide-x text-sm" />
                      </button>
                    </span>
                  </div>
                </div>

                <!-- 可选择的已有标签 -->
                <div v-if="unselectedTags.length > 0">
                  <div class="mb-2 text-sm font-medium text-gray-600 dark:text-gray-400">
                    点击选择已有标签:
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button
                      v-for="tag in unselectedTags"
                      :key="'available-' + tag"
                      class="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-700 transition-colors hover:bg-blue-100 hover:text-blue-700 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-blue-900/30 dark:hover:text-blue-300"
                      type="button"
                      @click="selectTag(tag)"
                    >
                      <i class="i-lucide-tag text-sm text-gray-500 dark:text-gray-400" />
                      {{ tag }}
                    </button>
                  </div>
                </div>

                <!-- 创建新标签 -->
                <div>
                  <div class="mb-2 text-sm font-medium text-gray-600 dark:text-gray-400">
                    创建新标签:
                  </div>
                  <div class="flex gap-2">
                    <input
                      v-model="newTag"
                      class="form-input flex-1 border-transparent dark:border-transparent dark:bg-gray-800 dark:text-gray-200"
                      placeholder="输入新标签名称"
                      type="text"
                      @keypress.enter.prevent="addTag"
                    />
                    <button
                      class="rounded-lg bg-green-500 px-4 py-2 text-white transition-colors hover:bg-green-600 dark:bg-green-600 dark:hover:bg-green-700"
                      type="button"
                      @click="addTag"
                    >
                      <i class="i-lucide-plus" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 速率限制设置 -->
          <div
            class="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-700 dark:bg-blue-900/20"
          >
            <div class="mb-2 flex items-center gap-2">
              <div
                class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-blue-500"
              >
                <i class="i-lucide-gauge text-sm text-white" />
              </div>
              <h4 class="text-sm font-semibold text-gray-800 dark:text-gray-200">速率限制设置</h4>
            </div>

            <div class="space-y-2">
              <div class="grid grid-cols-1 gap-2 lg:grid-cols-3">
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    时间窗口 (分钟)
                  </label>
                  <input
                    v-model="form.rateLimitWindow"
                    class="form-input w-full border-transparent text-sm dark:border-transparent dark:bg-gray-800 dark:text-gray-200"
                    min="1"
                    placeholder="不修改"
                    type="number"
                  />
                </div>

                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                    >请求次数限制</label
                  >
                  <input
                    v-model="form.rateLimitRequests"
                    class="form-input w-full border-transparent text-sm dark:border-transparent dark:bg-gray-800 dark:text-gray-200"
                    min="1"
                    placeholder="不修改"
                    type="number"
                  />
                </div>

                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                    >费用限制 (美元)</label
                  >
                  <input
                    v-model="form.rateLimitCost"
                    class="form-input w-full border-transparent text-sm dark:border-transparent dark:bg-gray-800 dark:text-gray-200"
                    min="0"
                    placeholder="不修改"
                    step="0.01"
                    type="number"
                  />
                </div>
              </div>
            </div>
          </div>

          <!-- 每日费用限制 -->
          <div>
            <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300">
              每日费用限制 (美元)
            </label>
            <input
              v-model="form.dailyCostLimit"
              class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-800 dark:text-gray-200"
              min="0"
              placeholder="不修改 (0 表示无限制)"
              step="0.01"
              type="number"
            />
          </div>

          <div>
            <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300">
              总费用限制 (美元)
            </label>
            <input
              v-model="form.totalCostLimit"
              class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-800 dark:text-gray-200"
              min="0"
              placeholder="不修改 (0 表示无限制)"
              step="0.01"
              type="number"
            />
          </div>

          <!-- Claude 模型周费用限制 -->
          <div>
            <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300">
              Claude 模型周费用限制 (美元)
            </label>
            <input
              v-model="form.weeklyOpusCostLimit"
              class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-800 dark:text-gray-200"
              min="0"
              placeholder="不修改 (0 表示无限制)"
              step="0.01"
              type="number"
            />
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              设置 Claude 模型的周费用限制，仅对 Claude 模型请求生效
            </p>
            <div
              v-if="form.weeklyOpusCostLimit && Number(form.weeklyOpusCostLimit) > 0"
              class="mt-2 flex gap-3"
            >
              <div class="flex-1">
                <label class="mb-1 block text-sm font-medium text-gray-600 dark:text-gray-400"
                  >重置日</label
                >
                <CustomDropdown
                  v-model="form.weeklyResetDay"
                  accent="blue"
                  :options="weeklyResetDayOptions"
                  placeholder="不修改"
                />
              </div>
              <div class="flex-1">
                <label class="mb-1 block text-sm font-medium text-gray-600 dark:text-gray-400"
                  >重置时间 (UTC+8)</label
                >
                <CustomDropdown
                  v-model="form.weeklyResetHour"
                  accent="blue"
                  :options="weeklyResetHourOptions"
                  placeholder="不修改"
                />
              </div>
            </div>
          </div>

          <!-- 并发限制 -->
          <div>
            <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >并发限制</label
            >
            <input
              v-model="form.concurrencyLimit"
              class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-800 dark:text-gray-200"
              min="0"
              placeholder="不修改 (0 表示无限制)"
              type="number"
            />
          </div>

          <!-- 激活状态 -->
          <div>
            <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >激活状态</label
            >
            <CuteOptionCards
              v-model="form.isActive"
              :columns="3"
              :options="isActiveOptions"
              size="sm"
            />
          </div>

          <!-- 服务权限 -->
          <div>
            <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >服务权限</label
            >
            <CuteOptionCards
              v-model="form.permissions"
              :columns="3"
              :options="permissionOptions"
              size="sm"
            />
          </div>

          <!-- 专属账号绑定 -->
          <div>
            <div class="mb-3 flex items-center justify-between">
              <label class="text-sm font-semibold text-gray-700 dark:text-gray-300"
                >专属账号绑定</label
              >
              <button
                class="flex items-center gap-1 text-sm text-blue-600 transition-colors hover:text-blue-800 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-400 dark:hover:text-blue-300"
                :disabled="accountsLoading"
                title="刷新账号列表"
                type="button"
                @click="refreshAccounts"
              >
                <i
                  :class="[
                    accountsLoading ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw',
                    'text-sm'
                  ]"
                />
                <span>{{ accountsLoading ? '刷新中...' : '刷新账号' }}</span>
              </button>
            </div>
            <div class="grid grid-cols-1 gap-3">
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-600 dark:text-gray-400"
                  >Claude 专属账号</label
                >
                <AccountSelector
                  v-model="claudeAccountSelectorValue"
                  :accounts="localAccounts.claude"
                  default-option-text="请选择Claude账号"
                  :disabled="!isServiceSelectable('claude')"
                  :groups="localAccounts.claudeGroups"
                  placeholder="请选择Claude账号"
                  platform="claude"
                  :special-options="accountSpecialOptions"
                />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-600 dark:text-gray-400"
                  >Gemini 专属账号</label
                >
                <AccountSelector
                  v-model="geminiAccountSelectorValue"
                  :accounts="localAccounts.gemini"
                  default-option-text="请选择Gemini账号"
                  :disabled="!isServiceSelectable('gemini')"
                  :groups="localAccounts.geminiGroups"
                  placeholder="请选择Gemini账号"
                  platform="gemini"
                  :special-options="accountSpecialOptions"
                />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-600 dark:text-gray-400"
                  >OpenAI 专属账号</label
                >
                <AccountSelector
                  v-model="openaiAccountSelectorValue"
                  :accounts="localAccounts.openai"
                  default-option-text="请选择OpenAI账号"
                  :disabled="!isServiceSelectable('openai')"
                  :groups="localAccounts.openaiGroups"
                  placeholder="请选择OpenAI账号"
                  platform="openai"
                  :special-options="accountSpecialOptions"
                />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-600 dark:text-gray-400"
                  >Bedrock 专属账号</label
                >
                <AccountSelector
                  v-model="bedrockAccountSelectorValue"
                  :accounts="localAccounts.bedrock"
                  default-option-text="请选择Bedrock账号"
                  :disabled="!isServiceSelectable('openai')"
                  :groups="[]"
                  placeholder="请选择Bedrock账号"
                  platform="bedrock"
                  :special-options="accountSpecialOptions"
                />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-600 dark:text-gray-400"
                  >Droid 专属账号</label
                >
                <AccountSelector
                  v-model="droidAccountSelectorValue"
                  :accounts="localAccounts.droid"
                  default-option-text="请选择Droid账号"
                  :disabled="!isServiceSelectable('droid')"
                  :groups="localAccounts.droidGroups"
                  placeholder="请选择Droid账号"
                  platform="droid"
                  :special-options="accountSpecialOptions"
                />
              </div>
            </div>
          </div>

          <div
            class="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200"
          >
            <p class="font-medium">跨协议桥接提示</p>
            <p class="mt-1">
              批量绑定 OpenAI/Grok 专属账号后，Claude
              <code class="font-mono">/v1/messages</code>
              可按 model 跨协议；未绑定则只走 Claude 池。
            </p>
          </div>
          </div>

          <div
            class="flex shrink-0 items-center gap-2 border-t border-gray-200 pt-2 dark:border-gray-700"
          >
            <button
              class="inline-flex h-10 flex-1 items-center justify-center rounded-lg bg-gray-100 px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              type="button"
              @click="requestClose"
            >
              取消
            </button>
            <button
              class="btn btn-primary inline-flex h-10 flex-1 items-center justify-center px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="loading"
              type="submit"
            >
              <div v-if="loading" class="loading-spinner mr-2" />
              <i v-else class="i-lucide-save mr-2" />
              {{ loading ? '保存中...' : '批量保存' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </ModalTransition>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

import ModalTransition from '@/components/common/modal_transition.vue'
import CuteOptionCards from '@/components/common/cute_option_cards.vue'
import { showToast } from '@/libs/tools'
import { isOk, msgOf } from '@/libs/http_envelope'
import { useApiKeysStore } from '@/stores/api_keys'
import * as httpApis from '@/libs/http_apis'
import AccountSelector from '@/components/common/account_selector.vue'

const props = defineProps({
  selectedKeys: {
    type: Array,
    required: true
  },
  accounts: {
    type: Object,
    default: () => ({
      claude: [],
      gemini: [],
      openai: [],
      openaiResponses: [],
      bedrock: [],
      droid: [],
      claudeGroups: [],
      geminiGroups: [],
      openaiGroups: [],
      droidGroups: []
    })
  }
})

const emit = defineEmits(['close', 'success'])

// 弹窗进入/退出动画：挂载后置 visible 触发进入，关闭时先播退出动画再通知父级卸载
const visible = ref(false)
onMounted(() => {
  visible.value = true
})
const requestClose = () => {
  visible.value = false
}
const onClosed = () => emit('close')

const apiKeysStore = useApiKeysStore()
const loading = ref(false)
const accountsLoading = ref(false)
const localAccounts = ref({
  claude: [],
  gemini: [],
  openai: [],
  bedrock: [],
  droid: [],
  claudeGroups: [],
  geminiGroups: [],
  openaiGroups: [],
  droidGroups: []
})

// 标签相关
const newTag = ref('')
const availableTags = ref([])
const tagOperation = ref('none') // 'replace', 'add', 'remove', 'none'

const tagOperationOptions = [
  { value: 'replace', label: '替换标签', description: '用新标签覆盖原有标签', icon: 'i-lucide-refresh-cw' },
  { value: 'add', label: '添加标签', description: '在原有标签上追加', icon: 'i-lucide-plus' },
  { value: 'remove', label: '移除标签', description: '删除指定标签', icon: 'i-lucide-minus' },
  { value: 'none', label: '不修改标签', description: '保持原样', icon: 'i-lucide-ban' }
]

const isActiveOptions = [
  { value: true, label: '激活', description: '批量设为可用', icon: 'i-lucide-check' },
  { value: false, label: '禁用', description: '批量设为停用', icon: 'i-lucide-pause' },
  { value: null, label: '不修改', description: '保持各 Key 原状态', icon: 'i-lucide-minus' }
]

const permissionOptions = [
  { value: '', label: '不修改', icon: 'i-lucide-minus' },
  { value: 'all', label: '全部服务', icon: 'i-lucide-globe' },
  { value: 'claude', label: '仅 Claude', icon: 'i-lucide-brain' },
  { value: 'gemini', label: '仅 Gemini', icon: 'i-lucide-gem' },
  { value: 'openai', label: '仅 OpenAI', icon: 'i-lucide-bot' },
  { value: 'droid', label: '仅 Droid', icon: 'i-logos-android-icon' }
]

const selectedCount = computed(() => props.selectedKeys.length)

const weeklyResetDayOptions = [
  { value: '', label: '不修改' },
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' }
]

const weeklyResetHourOptions = [
  { value: '', label: '不修改' },
  ...Array.from({ length: 24 }, (_, hour) => ({
    value: hour,
    label: `${String(hour).padStart(2, '0')}:00`
  }))
]

// 计算未选择的标签
const unselectedTags = computed(() => {
  return availableTags.value.filter((tag) => !form.tags.includes(tag))
})

// 表单数据
const form = reactive({
  rateLimitCost: '', // 费用限制替代token限制
  rateLimitWindow: '',
  rateLimitRequests: '',
  concurrencyLimit: '',
  dailyCostLimit: '',
  totalCostLimit: '',
  weeklyOpusCostLimit: '', // 新增Claude周费用限制
  weeklyResetDay: '',
  weeklyResetHour: '',
  permissions: '', // 空字符串表示不修改
  claudeAccountId: '',
  geminiAccountId: '',
  openaiAccountId: '',
  bedrockAccountId: '',
  droidAccountId: '',
  tags: [],
  isActive: null // null表示不修改
})

const UNCHANGED_OPTION_VALUE = '__KEEP_ORIGINAL__'

const accountSpecialOptions = [
  { value: UNCHANGED_OPTION_VALUE, label: '不修改' },
  { value: 'SHARED_POOL', label: '使用共享账号池' }
]

const createAccountSelectorModel = (field) =>
  computed({
    get: () => (form[field] === '' ? UNCHANGED_OPTION_VALUE : form[field]),
    set: (value) => {
      if (!value || value === UNCHANGED_OPTION_VALUE) {
        form[field] = ''
      } else {
        form[field] = value
      }
    }
  })

const claudeAccountSelectorValue = createAccountSelectorModel('claudeAccountId')
const geminiAccountSelectorValue = createAccountSelectorModel('geminiAccountId')
const openaiAccountSelectorValue = createAccountSelectorModel('openaiAccountId')
const bedrockAccountSelectorValue = createAccountSelectorModel('bedrockAccountId')
const droidAccountSelectorValue = createAccountSelectorModel('droidAccountId')

const isServiceSelectable = (service) => {
  if (!form.permissions) return true
  if (form.permissions === 'all') return true
  if (Array.isArray(form.permissions) && form.permissions.length === 0) return true
  if (Array.isArray(form.permissions)) return form.permissions.includes(service)
  return form.permissions === service
}

// 标签管理方法
const addTag = () => {
  if (newTag.value && newTag.value.trim()) {
    const tag = newTag.value.trim()
    if (!form.tags.includes(tag)) {
      form.tags.push(tag)
    }
    newTag.value = ''
  }
}

const selectTag = (tag) => {
  if (!form.tags.includes(tag)) {
    form.tags.push(tag)
  }
}

const removeTag = (index) => {
  form.tags.splice(index, 1)
}

// 刷新账号列表
const refreshAccounts = async () => {
  accountsLoading.value = true
  try {
    const [
      claudeData,
      claudeConsoleData,
      geminiData,
      geminiApiData,
      openaiData,
      openaiResponsesData,
      bedrockData,
      droidData,
      groupsData
    ] = await Promise.all([
      httpApis.getClaudeAccountsApi(),
      httpApis.getClaudeConsoleAccountsApi(),
      httpApis.getGeminiAccountsApi(),
      httpApis.getGeminiApiAccountsApi(), // 获取 Gemini-API 账号
      httpApis.getOpenAIAccountsApi(),
      httpApis.getOpenAIResponsesAccountsApi(),
      httpApis.getBedrockAccountsApi(),
      httpApis.getDroidAccountsApi(),
      httpApis.getAccountGroupsApi()
    ])

    // 合并Claude OAuth账户和Claude Console账户
    const claudeAccounts = []

    if (isOk(claudeData)) {
      claudeData.data?.forEach((account) => {
        claudeAccounts.push({
          ...account,
          platform: 'claude-oauth',
          isDedicated: account.accountType === 'dedicated'
        })
      })
    }

    if (isOk(claudeConsoleData)) {
      claudeConsoleData.data?.forEach((account) => {
        claudeAccounts.push({
          ...account,
          platform: 'claude-console',
          isDedicated: account.accountType === 'dedicated'
        })
      })
    }

    localAccounts.value.claude = claudeAccounts

    // 合并 Gemini OAuth 和 Gemini API 账号
    const geminiAccounts = []

    if (isOk(geminiData)) {
      ;(geminiData.data || []).forEach((account) => {
        geminiAccounts.push({
          ...account,
          platform: 'gemini',
          isDedicated: account.accountType === 'dedicated'
        })
      })
    }

    if (isOk(geminiApiData)) {
      ;(geminiApiData.data || []).forEach((account) => {
        geminiAccounts.push({
          ...account,
          platform: 'gemini-api',
          isDedicated: account.accountType === 'dedicated'
        })
      })
    }

    localAccounts.value.gemini = geminiAccounts

    const openaiAccounts = []

    if (isOk(openaiData)) {
      ;(openaiData.data || []).forEach((account) => {
        openaiAccounts.push({
          ...account,
          platform: 'openai',
          isDedicated: account.accountType === 'dedicated'
        })
      })
    }

    if (isOk(openaiResponsesData)) {
      ;(openaiResponsesData.data || []).forEach((account) => {
        openaiAccounts.push({
          ...account,
          platform: 'openai-responses',
          isDedicated: account.accountType === 'dedicated'
        })
      })
    }

    localAccounts.value.openai = openaiAccounts

    if (isOk(bedrockData)) {
      localAccounts.value.bedrock = (bedrockData.data || []).map((account) => ({
        ...account,
        isDedicated: account.accountType === 'dedicated'
      }))
    }

    if (isOk(droidData)) {
      localAccounts.value.droid = (droidData.data || []).map((account) => ({
        ...account,
        platform: 'droid',
        isDedicated: account.accountType === 'dedicated'
      }))
    }

    // 处理分组数据
    if (isOk(groupsData)) {
      const allGroups = groupsData.data || []
      localAccounts.value.claudeGroups = allGroups.filter((g) => g.platform === 'claude')
      localAccounts.value.geminiGroups = allGroups.filter(
        (g) => g.platform === 'gemini' || g.platform === 'antigravity',
      )
      localAccounts.value.openaiGroups = allGroups.filter((g) => g.platform === 'openai')
      localAccounts.value.droidGroups = allGroups.filter((g) => g.platform === 'droid')
    }

    showToast('账号列表已刷新', 'success')
  } catch (error) {
    showToast('刷新账号列表失败', 'error')
  } finally {
    accountsLoading.value = false
  }
}

// 批量更新API Keys
const batchUpdateApiKeys = async () => {
  loading.value = true

  try {
    // 准备提交的数据
    const updates = {}

    // 只有非空值才添加到更新对象中
    if (form.rateLimitCost !== '' && form.rateLimitCost !== null) {
      updates.rateLimitCost = parseFloat(form.rateLimitCost)
    }
    if (form.rateLimitWindow !== '' && form.rateLimitWindow !== null) {
      updates.rateLimitWindow = parseInt(form.rateLimitWindow)
    }
    if (form.rateLimitRequests !== '' && form.rateLimitRequests !== null) {
      updates.rateLimitRequests = parseInt(form.rateLimitRequests)
    }
    if (form.concurrencyLimit !== '' && form.concurrencyLimit !== null) {
      updates.concurrencyLimit = parseInt(form.concurrencyLimit)
    }
    if (form.dailyCostLimit !== '' && form.dailyCostLimit !== null) {
      updates.dailyCostLimit = parseFloat(form.dailyCostLimit)
    }
    if (form.totalCostLimit !== '' && form.totalCostLimit !== null) {
      updates.totalCostLimit = parseFloat(form.totalCostLimit)
    }
    if (form.weeklyOpusCostLimit !== '' && form.weeklyOpusCostLimit !== null) {
      updates.weeklyOpusCostLimit = parseFloat(form.weeklyOpusCostLimit)
    }
    if (form.weeklyResetDay !== '' && form.weeklyResetDay !== null) {
      updates.weeklyResetDay = Number(form.weeklyResetDay)
    }
    if (form.weeklyResetHour !== '' && form.weeklyResetHour !== null) {
      updates.weeklyResetHour = Number(form.weeklyResetHour)
    }

    // 权限设置
    if (form.permissions !== '') {
      updates.permissions = form.permissions
    }

    // 账户绑定
    if (form.claudeAccountId !== '') {
      if (form.claudeAccountId === 'SHARED_POOL') {
        updates.claudeAccountId = null
        updates.claudeConsoleAccountId = null
      } else if (form.claudeAccountId.startsWith('console:')) {
        updates.claudeConsoleAccountId = form.claudeAccountId.substring(8)
        updates.claudeAccountId = null
      } else if (!form.claudeAccountId.startsWith('group:')) {
        updates.claudeAccountId = form.claudeAccountId
        updates.claudeConsoleAccountId = null
      } else {
        updates.claudeAccountId = form.claudeAccountId
        updates.claudeConsoleAccountId = null
      }
    }

    if (form.geminiAccountId !== '') {
      if (form.geminiAccountId === 'SHARED_POOL') {
        updates.geminiAccountId = null
      } else {
        updates.geminiAccountId = form.geminiAccountId
      }
    }

    if (form.openaiAccountId !== '') {
      if (form.openaiAccountId === 'SHARED_POOL') {
        updates.openaiAccountId = null
      } else {
        updates.openaiAccountId = form.openaiAccountId
      }
    }

    if (form.bedrockAccountId !== '') {
      if (form.bedrockAccountId === 'SHARED_POOL') {
        updates.bedrockAccountId = null
      } else {
        updates.bedrockAccountId = form.bedrockAccountId
      }
    }

    if (form.droidAccountId !== '') {
      if (form.droidAccountId === 'SHARED_POOL') {
        updates.droidAccountId = null
      } else {
        updates.droidAccountId = form.droidAccountId
      }
    }

    // 激活状态
    if (form.isActive !== null) {
      updates.isActive = form.isActive
    }

    // 标签处理
    if (tagOperation.value !== 'none') {
      updates.tags = form.tags
      updates.tagOperation = tagOperation.value
    }

    const result = await httpApis.batchUpdateApiKeysApi({
      keyIds: props.selectedKeys,
      updates
    })

    if (isOk(result)) {
      const { successCount, failedCount, errors } = result.data

      if (successCount > 0) {
        showToast(`成功批量编辑 ${successCount} 个 API Keys`, 'success')

        if (failedCount > 0) {
          const errorMessages = errors.map((e) => `${e.keyId}: ${e.error}`).join('\n')
          showToast(`${failedCount} 个编辑失败:\n${errorMessages}`, 'warning')
        }
      } else {
        showToast('所有 API Keys 编辑失败', 'error')
      }

      emit('success')
      requestClose()
    } else {
      showToast(msgOf(result, '批量编辑失败'), 'error')
    }
  } catch (error) {
    showToast('批量编辑失败', 'error')
    console.error('批量编辑 API Keys 失败:', error)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  // 加载已存在的标签
  availableTags.value = await apiKeysStore.fetchTags()

  // 初始化账号数据
  if (props.accounts) {
    // props.accounts.gemini 已经包含了 OAuth 和 API 两种类型的账号（父组件已合并）
    // 保留原有的 platform 属性，不要覆盖
    const geminiAccounts = (props.accounts.gemini || []).map((account) => ({
      ...account,
      platform: account.platform || 'gemini' // 保留原有 platform，只在没有时设默认值
    }))

    // props.accounts.openai 只包含 openai 类型，openaiResponses 需要单独处理
    const openaiAccounts = []
    if (props.accounts.openai) {
      props.accounts.openai.forEach((account) => {
        openaiAccounts.push({
          ...account,
          platform: account.platform || 'openai'
        })
      })
    }
    if (props.accounts.openaiResponses) {
      props.accounts.openaiResponses.forEach((account) => {
        openaiAccounts.push({
          ...account,
          platform: account.platform || 'openai-responses'
        })
      })
    }

    localAccounts.value = {
      claude: props.accounts.claude || [],
      gemini: geminiAccounts,
      openai: openaiAccounts,
      bedrock: props.accounts.bedrock || [],
      droid: (props.accounts.droid || []).map((account) => ({
        ...account,
        platform: account.platform || 'droid'
      })),
      claudeGroups: props.accounts.claudeGroups || [],
      geminiGroups: props.accounts.geminiGroups || [],
      openaiGroups: props.accounts.openaiGroups || [],
      droidGroups: props.accounts.droidGroups || []
    }
  }
})
</script>
