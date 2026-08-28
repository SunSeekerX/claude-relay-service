<template>
  <!-- 账户分组管理：默认弹窗形态（AccountForm 调用）；inline=true 时为账户管理子 tab 的内联面板 -->
  <ModalTransition :teleport="!inline" @after-leave="onClosed">
    <div
      v-if="inline || visible"
      :class="inline ? '' : 'modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4'"
    >
      <div
        :class="
          inline
            ? ''
            : 'modal-content custom-scrollbar mx-auto max-h-[90vh] w-full max-w-4xl overflow-y-auto p-3 sm:p-4'
        "
      >
        <!-- 标题栏：仅弹窗模式显示（内联模式由子 tab 标签表达） -->
        <div v-if="!inline" class="mb-3 flex items-center justify-between">
          <div class="flex items-center gap-2 sm:gap-3">
            <div
              class="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500 to-purple-600 sm:h-10 sm:w-10 sm:rounded-xl"
            >
              <i class="i-lucide-layers text-sm text-white sm:text-base" />
            </div>
            <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100 sm:text-xl">
              账户分组管理
            </h3>
          </div>
          <button
            class="p-1 text-gray-400 transition-colors hover:text-gray-600"
            @click="requestClose"
          >
            <i class="i-lucide-x text-lg sm:text-xl" />
          </button>
        </div>

        <!-- 平台筛选 + 创建分组：同一行 -->
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div class="flex min-w-0 flex-1 flex-wrap gap-2">
            <button
              v-for="tab in platformTabs"
              :key="tab.key"
              :class="[
                'whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-all',
                activeTab === tab.key
                  ? tabActiveClass(tab.key)
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'
              ]"
              type="button"
              @click="activeTab = tab.key"
            >
              {{ tab.label }}
              <span class="ml-1 text-sm opacity-70">({{ platformCounts[tab.key] }})</span>
            </button>
          </div>
          <button class="btn btn-primary h-8 shrink-0 whitespace-nowrap px-3 text-sm" type="button" @click="openCreateForm">
            <i class="i-lucide-plus mr-1" />
            创建新分组
          </button>
        </div>

        <!-- 分组列表 -->
        <div class="space-y-4">
          <div v-if="loading" class="py-5 text-center">
            <div class="loading-spinner-lg mx-auto mb-4" />
            <p class="text-gray-500">加载中...</p>
          </div>

          <div
            v-else-if="filteredGroups.length === 0"
            class="rounded-lg bg-gray-50 py-5 text-center dark:bg-gray-800"
          >
            <i class="i-lucide-layers mb-4 text-4xl text-gray-300 dark:text-gray-600" />
            <p class="text-gray-500 dark:text-gray-400">暂无分组</p>
          </div>

          <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div
              v-for="group in filteredGroups"
              :key="group.id"
              class="rounded-lg border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-800"
            >
              <div class="mb-3 flex items-start justify-between">
                <div class="flex-1">
                  <h4 class="font-semibold text-gray-900 dark:text-gray-100">
                    {{ group.name }}
                  </h4>
                  <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    {{ group.description || '暂无描述' }}
                  </p>
                </div>
                <div class="ml-4 flex items-center gap-2">
                  <span
                    class="rounded-full px-2 py-1 text-sm font-medium"
                    :class="platformBadgeClass(group.platform)"
                  >
                    {{ platformLabelMap[group.platform] || group.platform }}
                  </span>
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
                <span>
                  <i class="i-lucide-users mr-1" />
                  {{ group.memberCount || 0 }} 个成员
                </span>
                <span>
                  <i class="i-lucide-percent mr-1" />
                  倍率 {{ group.rateMultiplier ?? 1 }}
                </span>
                <span v-if="group.rpmLimit > 0">
                  <i class="i-lucide-gauge mr-1" />
                  RPM {{ group.rpmLimit }}
                </span>
                <span v-if="group.isExclusive" class="text-amber-600 dark:text-amber-400">专属</span>
                <span
                  v-if="group.platform === 'claude' && group.claudeCodeOnly"
                  class="text-indigo-600 dark:text-indigo-400"
                  >仅 CC</span
                >
                <span>
                  <i class="i-lucide-clock mr-1" />
                  {{ formatDate(group.createdAt) }}
                </span>
              </div>
              <div
                v-if="group.dailyLimitUsd || group.weeklyLimitUsd || group.monthlyLimitUsd"
                class="mt-1 text-sm text-gray-500 dark:text-gray-400"
              >
                限额
                <template v-if="group.dailyLimitUsd">
                  日 ${{ formatUsage(group.usageCost?.daily) }}/${{ group.dailyLimitUsd }}
                </template>
                <template v-if="group.weeklyLimitUsd">
                  周 ${{ formatUsage(group.usageCost?.weekly) }}/${{ group.weeklyLimitUsd }}
                </template>
                <template v-if="group.monthlyLimitUsd">
                  月 ${{ formatUsage(group.usageCost?.monthly) }}/${{ group.monthlyLimitUsd }}
                </template>
              </div>
              <div
                class="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3 dark:border-gray-700"
              >
                <button
                  class="flex items-center justify-center gap-1 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                  @click="editGroup(group)"
                >
                  <i class="i-lucide-pen-line" />
                  编辑
                </button>
                <button
                  class="flex items-center justify-center gap-1 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-900/40 dark:text-red-300 dark:hover:bg-red-800/50"
                  :disabled="group.memberCount > 0"
                  @click="deleteGroup(group)"
                >
                  <i class="i-lucide-trash-2" />
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </ModalTransition>

  <ModalTransition>
    <!-- 编辑分组模态框 -->
    <div
      v-if="showEditForm"
      class="modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
    >
      <div class="modal-content custom-scrollbar max-h-[92vh] w-full max-w-2xl overflow-y-auto p-2.5 sm:p-3">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-base font-bold text-gray-900 dark:text-gray-100 sm:text-lg">编辑分组</h3>
          <button class="text-gray-400 transition-colors hover:text-gray-600" @click="cancelEdit">
            <i class="i-lucide-x" />
          </button>
        </div>

        <div class="space-y-4">
          <div>
            <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >分组名称 *</label
            >
            <input
              v-model="editForm.name"
              class="form-input w-full"
              placeholder="输入分组名称"
              type="text"
            />
          </div>

          <div>
            <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >平台类型</label
            >
            <div
              class="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600 dark:bg-gray-700 dark:text-gray-300"
            >
              {{ platformLabelMap[editForm.platform] || editForm.platform }}
              <span class="ml-2 text-sm text-gray-500">(不可修改)</span>
            </div>
          </div>

          <div>
            <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >描述 (可选)</label
            >
            <textarea
              v-model="editForm.description"
              class="form-input w-full resize-none"
              placeholder="分组描述..."
              rows="2"
            />
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >计费倍率</label
              >
              <input
                v-model.number="editForm.rateMultiplier"
                class="form-input w-full"
                min="0"
                step="0.01"
                type="number"
              />
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >RPM 上限（0=不限）</label
              >
              <input
                v-model.number="editForm.rpmLimit"
                class="form-input w-full"
                min="0"
                step="1"
                type="number"
              />
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >日限额 USD（空=不限）</label
              >
              <input
                v-model="editForm.dailyLimitUsd"
                class="form-input w-full"
                min="0"
                step="0.01"
                type="number"
              />
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >周限额 USD</label
              >
              <input
                v-model="editForm.weeklyLimitUsd"
                class="form-input w-full"
                min="0"
                step="0.01"
                type="number"
              />
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >月限额 USD</label
              >
              <input
                v-model="editForm.monthlyLimitUsd"
                class="form-input w-full"
                min="0"
                step="0.01"
                type="number"
              />
            </div>
          </div>

          <div class="flex flex-wrap gap-4">
            <label class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input v-model="editForm.isExclusive" class="rounded" type="checkbox" />
              专属分组（仅绑定可用）
            </label>
            <label
              v-if="editForm.platform === 'claude'"
              class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
            >
              <input v-model="editForm.claudeCodeOnly" class="rounded" type="checkbox" />
              仅 Claude Code 客户端
            </label>
          </div>

          <div>
            <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >模型白名单（可选，每行或逗号分隔；空=不限）</label
            >
            <textarea
              v-model="editForm.modelWhitelistText"
              class="form-input w-full resize-none font-mono"
              placeholder="claude-opus-4&#10;gpt-5"
              rows="3"
            />
          </div>

          <div class="flex shrink-0 items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
            <button
              class="btn btn-primary inline-flex h-10 flex-1 items-center justify-center px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              :disabled="!editForm.name || updating"
              @click="updateGroup"
            >
              <div v-if="updating" class="loading-spinner mr-2" />
              {{ updating ? '更新中...' : '更新' }}
            </button>
            <button
              class="inline-flex h-10 flex-1 items-center justify-center rounded-lg bg-gray-100 px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              type="button"
              @click="cancelEdit"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  </ModalTransition>

  <ModalTransition>
    <!-- 创建分组模态框 -->
    <div
      v-if="showCreateForm"
      class="modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
    >
      <div class="modal-content custom-scrollbar max-h-[92vh] w-full max-w-2xl overflow-y-auto p-2.5 sm:p-3">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-base font-bold text-gray-900 dark:text-gray-100 sm:text-lg">创建新分组</h3>
          <button
            class="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
            @click="cancelCreate"
          >
            <i class="i-lucide-x" />
          </button>
        </div>

        <div class="space-y-4">
          <div>
            <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >分组名称 *</label
            >
            <input
              v-model="createForm.name"
              class="form-input w-full"
              placeholder="输入分组名称"
              type="text"
            />
          </div>

          <div>
            <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >平台类型 *</label
            >
            <CuteOptionCards
              v-model="createForm.platform"
              :columns="3"
              :options="groupPlatformOptions"
              size="sm"
            />
          </div>

          <div>
            <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >描述 (可选)</label
            >
            <textarea
              v-model="createForm.description"
              class="form-input w-full resize-none"
              placeholder="分组描述..."
              rows="2"
            />
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >计费倍率</label
              >
              <input
                v-model.number="createForm.rateMultiplier"
                class="form-input w-full"
                min="0"
                step="0.01"
                type="number"
              />
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >RPM 上限（0=不限）</label
              >
              <input
                v-model.number="createForm.rpmLimit"
                class="form-input w-full"
                min="0"
                step="1"
                type="number"
              />
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >日限额 USD（空=不限）</label
              >
              <input
                v-model="createForm.dailyLimitUsd"
                class="form-input w-full"
                min="0"
                step="0.01"
                type="number"
              />
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >周限额 USD</label
              >
              <input
                v-model="createForm.weeklyLimitUsd"
                class="form-input w-full"
                min="0"
                step="0.01"
                type="number"
              />
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >月限额 USD</label
              >
              <input
                v-model="createForm.monthlyLimitUsd"
                class="form-input w-full"
                min="0"
                step="0.01"
                type="number"
              />
            </div>
          </div>

          <div class="flex flex-wrap gap-4">
            <label class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input v-model="createForm.isExclusive" class="rounded" type="checkbox" />
              专属分组（仅绑定可用）
            </label>
            <label
              v-if="createForm.platform === 'claude'"
              class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
            >
              <input v-model="createForm.claudeCodeOnly" class="rounded" type="checkbox" />
              仅 Claude Code 客户端
            </label>
          </div>

          <div>
            <label class="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >模型白名单（可选，每行或逗号分隔；空=不限）</label
            >
            <textarea
              v-model="createForm.modelWhitelistText"
              class="form-input w-full resize-none font-mono"
              placeholder="claude-opus-4&#10;gpt-5"
              rows="3"
            />
          </div>

          <div class="flex shrink-0 items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
            <button
              class="btn btn-primary inline-flex h-10 flex-1 items-center justify-center px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              :disabled="!createForm.name || !createForm.platform || creating"
              @click="createGroup"
            >
              <div v-if="creating" class="loading-spinner mr-2" />
              {{ creating ? '创建中...' : '创建' }}
            </button>
            <button
              class="inline-flex h-10 flex-1 items-center justify-center rounded-lg bg-gray-100 px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              type="button"
              @click="cancelCreate"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  </ModalTransition>

  <!-- 删除确认对话框 -->
  <ConfirmModal
    cancel-text="取消"
    confirm-text="确认删除"
    :message="`确定要删除分组 &quot;${deletingGroup?.name}&quot; 吗？此操作不可撤销。`"
    :show="showDeleteConfirm"
    title="确认删除"
    type="danger"
    @cancel="cancelDelete"
    @confirm="confirmDelete"
  />
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

import ModalTransition from '@/components/common/modal_transition.vue'
import CuteOptionCards from '@/components/common/cute_option_cards.vue'
import { showToast, formatDate } from '@/libs/tools'
import { isOk, msgOf } from '@/libs/http_envelope'

import * as httpApis from '@/libs/http_apis'
import ConfirmModal from '@/components/common/confirm_modal.vue'

defineProps({
  // 默认弹窗形态；inline=true 时渲染为账户管理子 tab 的内联面板
  inline: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close', 'refresh'])

// 弹窗模式退出动画：visible 控制遮罩 v-if；关闭先播退出动画，after-leave 再 emit('close') 由父级卸载
// 内联模式 v-if 恒为真（inline || visible），不受影响
const visible = ref(false)
const requestClose = () => {
  visible.value = false
}
const onClosed = () => emit('close')

const loading = ref(false)
const groups = ref([])

// Tab 切换
const activeTab = ref('all')
const platformTabs = [
  { key: 'all', label: '全部', color: 'gray' },
  { key: 'claude', label: 'Claude', color: 'purple' },
  { key: 'openai', label: 'OpenAI', color: 'emerald' },
  { key: 'gemini', label: 'Gemini', color: 'blue' },
  { key: 'antigravity', label: 'Antigravity', color: 'indigo' },
  { key: 'droid', label: 'Droid', color: 'cyan' },
  { key: 'grok', label: 'Grok', color: 'violet' }
]

const platformLabelMap = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  droid: 'Droid',
  grok: 'Grok'
}

const platformBadgeClass = (platform) => {
  if (platform === 'claude') {
    return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
  }
  if (platform === 'openai') {
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
  }
  if (platform === 'gemini') {
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  }
  if (platform === 'antigravity') {
    return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
  }
  if (platform === 'droid') {
    return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300'
  }
  if (platform === 'grok') {
    return 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
  }
  return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
}

const tabActiveClass = (key) => {
  if (key === 'claude') {
    return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
  }
  if (key === 'openai') {
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
  }
  if (key === 'gemini') {
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  }
  if (key === 'antigravity') {
    return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
  }
  if (key === 'droid') {
    return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300'
  }
  if (key === 'grok') {
    return 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
  }
  return 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
}

// 各平台分组数量
const platformCounts = computed(() => {
  const counts = { all: groups.value.length }
  platformTabs.slice(1).forEach((tab) => {
    counts[tab.key] = groups.value.filter((group) => group.platform === tab.key).length
  })
  return counts
})

// 过滤后的分组列表
const filteredGroups = computed(() => {
  if (activeTab.value === 'all') return groups.value
  return groups.value.filter((group) => group.platform === activeTab.value)
})

const emptyGroupForm = () => ({
  name: '',
  platform: 'claude',
  description: '',
  rateMultiplier: 1,
  isExclusive: false,
  claudeCodeOnly: false,
  rpmLimit: 0,
  dailyLimitUsd: '',
  weeklyLimitUsd: '',
  monthlyLimitUsd: '',
  modelWhitelistText: ''
})

// 删除确认
const showDeleteConfirm = ref(false)
const deletingGroup = ref(null)

// 创建表单
const showCreateForm = ref(false)
const creating = ref(false)
const createForm = ref(emptyGroupForm())

const groupPlatformOptions = [
  { value: 'claude', label: 'Claude', icon: 'i-lucide-brain' },
  { value: 'openai', label: 'OpenAI', icon: 'i-lucide-bot' },
  { value: 'gemini', label: 'Gemini', icon: 'i-lucide-gem' },
  { value: 'antigravity', label: 'Antigravity', icon: 'i-lucide-orbit' },
  { value: 'droid', label: 'Droid', icon: 'i-lucide-bot' },
  { value: 'grok', label: 'Grok', icon: 'i-lucide-zap' }
]

// 编辑表单
const showEditForm = ref(false)
const updating = ref(false)
const editingGroup = ref(null)
const editForm = ref(emptyGroupForm())

const formatUsage = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '0'
  if (number < 0.01) return number.toFixed(4)
  return number.toFixed(2)
}

const buildGroupPayload = (form) => ({
  name: form.name,
  platform: form.platform,
  description: form.description,
  rateMultiplier: form.rateMultiplier,
  isExclusive: form.isExclusive,
  claudeCodeOnly: form.claudeCodeOnly,
  rpmLimit: form.rpmLimit,
  dailyLimitUsd: form.dailyLimitUsd === '' ? 0 : form.dailyLimitUsd,
  weeklyLimitUsd: form.weeklyLimitUsd === '' ? 0 : form.weeklyLimitUsd,
  monthlyLimitUsd: form.monthlyLimitUsd === '' ? 0 : form.monthlyLimitUsd,
  modelWhitelist: form.modelWhitelistText
})

const fillFormFromGroup = (group) => ({
  name: group.name || '',
  platform: group.platform || '',
  description: group.description || '',
  rateMultiplier: group.rateMultiplier ?? 1,
  isExclusive: !!group.isExclusive,
  claudeCodeOnly: !!group.claudeCodeOnly,
  rpmLimit: group.rpmLimit || 0,
  dailyLimitUsd: group.dailyLimitUsd ?? '',
  weeklyLimitUsd: group.weeklyLimitUsd ?? '',
  monthlyLimitUsd: group.monthlyLimitUsd ?? '',
  modelWhitelistText: Array.isArray(group.modelWhitelist)
    ? group.modelWhitelist.join('\n')
    : ''
})

// 格式化日期

// 加载分组列表
const loadGroups = async () => {
  loading.value = true
  const response = await httpApis.getAccountGroupsApi()
  if (isOk(response)) {
    groups.value = response.data || []
  } else {
    showToast(msgOf(response, '加载分组列表失败'), 'error')
  }
  loading.value = false
}

// 创建分组
const createGroup = async () => {
  if (!createForm.value.name || !createForm.value.platform) {
    showToast('请填写必填项', 'error')
    return
  }

  creating.value = true
  const response = await httpApis.createAccountGroupApi(buildGroupPayload(createForm.value))
  creating.value = false
  if (!isOk(response)) {
    showToast(msgOf(response, '创建分组失败'), 'error')
    return
  }

  showToast('分组创建成功', 'success')
  cancelCreate()
  await loadGroups()
  emit('refresh')
}

// 打开创建表单（根据当前 Tab 预选平台）
const openCreateForm = () => {
  createForm.value = emptyGroupForm()
  createForm.value.platform = activeTab.value !== 'all' ? activeTab.value : 'claude'
  showCreateForm.value = true
}

// 取消创建
const cancelCreate = () => {
  showCreateForm.value = false
  createForm.value = emptyGroupForm()
}

// 编辑分组
const editGroup = (group) => {
  editingGroup.value = group
  editForm.value = fillFormFromGroup(group)
  showEditForm.value = true
}

// 更新分组
const updateGroup = async () => {
  if (!editForm.value.name) {
    showToast('请填写分组名称', 'error')
    return
  }

  updating.value = true
  const payload = buildGroupPayload(editForm.value)
  delete payload.platform
  const response = await httpApis.updateAccountGroupApi(editingGroup.value.id, payload)
  updating.value = false
  if (!isOk(response)) {
    showToast(msgOf(response, '更新分组失败'), 'error')
    return
  }

  showToast('分组更新成功', 'success')
  cancelEdit()
  await loadGroups()
  emit('refresh')
}

// 取消编辑
const cancelEdit = () => {
  showEditForm.value = false
  editingGroup.value = null
  editForm.value = emptyGroupForm()
}

// 删除分组 - 打开确认对话框
const deleteGroup = (group) => {
  if (group.memberCount > 0) {
    showToast('分组内还有成员，无法删除', 'error')
    return
  }
  deletingGroup.value = group
  showDeleteConfirm.value = true
}

// 确认删除
const confirmDelete = async () => {
  if (!deletingGroup.value) return
  const response = await httpApis.deleteAccountGroupApi(deletingGroup.value.id)
  if (!isOk(response)) {
    showToast(msgOf(response, '删除分组失败'), 'error')
    return
  }
  showToast('分组删除成功', 'success')
  cancelDelete()
  await loadGroups()
  emit('refresh')
}

// 取消删除
const cancelDelete = () => {
  showDeleteConfirm.value = false
  deletingGroup.value = null
}

// 组件挂载时加载数据
onMounted(() => {
  visible.value = true
  loadGroups()
})
</script>
