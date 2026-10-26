<template>
  <section class="tokenizer-panel min-w-0 space-y-3 text-sm">
    <header class="tokenizer-heading">
      <h2>词表管理</h2>
      <div class="tokenizer-header-actions">
        <span class="text-gray-500">词表计数</span
        ><AppSwitch
          v-model="settings.enabled"
          aria-label="启用词表计数"
          :disabled="!settingsLoaded || saving"
          size="sm"
        /><span v-if="dirty" class="text-amber-600 dark:text-amber-400">未保存</span
        ><button
          class="btn btn-primary"
          :disabled="saving || !settingsLoaded || !dirty"
          @click="saveSettings"
        >
          {{ saving ? '保存中…' : '保存设置' }}</button
        ><button class="btn btn-secondary" :disabled="loading" @click="refreshInventory">
          <i class="i-lucide-refresh-cw" />刷新
        </button>
      </div>
    </header>
    <p v-if="error" class="text-red-600 dark:text-red-400" role="alert">{{ error }}</p>
    <SegmentedTabs v-model="tab" :tabs="tabs" variant="underline" />
    <div
      v-if="latestTask"
      aria-live="polite"
      class="tokenizer-task-strip"
      :class="`task-${latestTask.state}`"
    >
      <div>
        <strong>{{ taskStates[latestTask.state] ?? latestTask.state }}</strong
        ><span>{{ operationNames[latestTask.operation] }}</span
        ><span v-if="latestTask.filesTotal"
          >文件 {{ latestTask.filesCompleted ?? 0 }} / {{ latestTask.filesTotal }}</span
        ><span v-else>{{ latestTask.completed }} / {{ latestTask.total }}</span
        ><span v-if="latestTask.activeDownloads">{{ latestTask.activeDownloads }} 个下载中</span>
      </div>
      <div class="tokenizer-task-actions">
        <button
          v-if="taskBusy"
          class="text-red-600 dark:text-red-400"
          @click="cancelTask(latestTask.id)"
        >
          取消</button
        ><button class="text-blue-600 dark:text-blue-400" @click="tab = 'tasks'">查看任务</button>
      </div>
      <progress
        v-if="taskBusy"
        :max="latestTask.filesTotal || latestTask.total || 1"
        :value="latestTask.filesCompleted ?? latestTask.completed"
      />
      <p
        v-if="['failed', 'interrupted', 'cancelled'].includes(latestTask.state)"
        class="w-full break-words"
      >
        {{ latestTask.message }}
      </p>
    </div>
    <template v-if="tab === 'resources'">
      <div class="tokenizer-toolbar">
        <input
          v-model="keyword"
          aria-label="搜索词表"
          class="form-input tokenizer-search"
          placeholder="搜索词表、系列或模型"
          type="search"
        />
        <CustomDropdown
          v-model="family"
          class="tokenizer-family"
          :options="[
            { value: '', label: '全部系列' },
            ...families.map((value) => ({ value, label: value }))
          ]"
        />
        <span class="text-gray-500">{{ visibleResources.length }} 项</span>
        <div class="tokenizer-batch">
          <span>已选 {{ selected.length }}</span
          ><CustomDropdown
            v-model="selectedOperation"
            class="tokenizer-operation"
            :options="operations"
          /><button
            class="btn btn-secondary"
            :disabled="!selected.length || taskStarting || taskBusy"
            @click="startTask(selectedOperation)"
          >
            执行
          </button>
        </div>
      </div>
      <div class="tokenizer-table-wrap">
        <table class="tokenizer-table">
          <thead>
            <tr>
              <th class="tokenizer-check">
                <input
                  aria-label="选择当前筛选的全部词表"
                  :checked="
                    visibleResources.length > 0 &&
                    visibleResources.every((row) => selected.includes(row.id))
                  "
                  type="checkbox"
                  @change="toggleAll($event.target.checked)"
                />
              </th>
              <th>
                <button @click="resourceAscending = !resourceAscending">
                  词表 {{ resourceAscending ? '↑' : '↓' }}
                </button>
              </th>
              <th>版本</th>
              <th>状态</th>
              <th>启用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in visibleResources" :key="row.id">
              <td class="tokenizer-check">
                <input
                  v-model="selected"
                  :aria-label="`选择 ${row.id}`"
                  type="checkbox"
                  :value="row.id"
                />
              </td>
              <td>
                <button class="tokenizer-resource-name" title="查看词表详情" @click="detail = row">
                  {{ row.family }}<span>{{ row.id }}</span>
                </button>
              </td>
              <td>
                <button
                  v-if="row.currentRevision"
                  class="font-mono"
                  :title="`复制完整版本 ${row.currentRevision}`"
                  @click="copyText(row.currentRevision)"
                >
                  {{ row.currentRevision.slice(0, 9) }}</button
                ><span v-else class="text-gray-500">—</span
                ><span
                  v-if="latestRevision(row.id) && latestRevision(row.id) !== row.currentRevision"
                  class="tokenizer-version-note"
                  >有新版本</span
                >
              </td>
              <td>
                <span class="tokenizer-state" :class="`resource-${row.status}`">{{
                  resourceStatuses[row.status]
                }}</span
                ><span v-if="row.appliedRevision" class="tokenizer-version-note">{{
                  row.appliedRevision === row.currentRevision ? '已应用' : '待应用新版'
                }}</span
                ><span
                  v-else-if="row.engine === 'local' && row.status === 'available'"
                  class="tokenizer-version-note"
                  >待应用</span
                >
              </td>
              <td>
                <AppSwitch
                  v-if="row.engine === 'local'"
                  :aria-label="`启用 ${row.id}`"
                  :disabled="!settingsLoaded || saving"
                  :model-value="resourceEnabled(row)"
                  size="sm"
                  @update:model-value="toggleResource(row, $event)"
                /><span v-else class="text-gray-500">{{
                  row.format === 'xai-tok-json' ? '暂不支持' : '参考'
                }}</span>
              </td>
              <td>
                <div class="tokenizer-row-actions">
                  <button
                    class="text-blue-600 dark:text-blue-400"
                    :disabled="taskStarting || taskBusy"
                    @click="startTask('download', [row.id])"
                  >
                    {{ row.status === 'available' ? '修复' : '下载' }}</button
                  ><button
                    v-if="row.engine === 'local'"
                    class="text-blue-600 dark:text-blue-400"
                    :disabled="taskStarting || taskBusy || row.status !== 'available'"
                    @click="startTask('apply', [row.id])"
                  >
                    应用</button
                  ><button class="text-gray-600 dark:text-gray-300" @click="detail = row">
                    详情
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!visibleResources.length">
              <td class="tokenizer-empty" colspan="6">
                {{ loading ? '加载中…' : '没有匹配的词表' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="tokenizer-hint">最多 4 个文件并行下载；下载后点击“应用”生效。</p>
    </template>
    <template v-else-if="tab === 'embedded'">
      <div class="tokenizer-table-wrap">
        <table class="tokenizer-table">
          <thead>
            <tr>
              <th>内置词表</th>
              <th>版本</th>
              <th>大小</th>
              <th>启用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in catalog.embedded" :key="row.id">
              <td>
                <span class="font-medium">{{ row.name }}</span
                ><span class="tokenizer-version-note">{{
                  precisions[row.precision] ?? row.precision
                }}</span>
              </td>
              <td>{{ row.version }}</td>
              <td>{{ formatBytes(row.sizeBytes) }}</td>
              <td>
                <AppSwitch
                  :aria-label="`启用 ${row.name}`"
                  :disabled="!settingsLoaded || saving"
                  :model-value="!settings.disabledTokenizers.includes(row.tokenizerId)"
                  size="sm"
                  @update:model-value="toggleTokenizer(row.tokenizerId, $event)"
                />
              </td>
              <td>
                <button class="text-blue-600 dark:text-blue-400" @click="detail = row">详情</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <template v-else-if="tab === 'rules'">
      <p class="text-gray-500">入口指定优先；全局规则按映射依据和优先级匹配。</p>
      <button class="btn btn-secondary px-3 py-2" @click="addRule">添加规则</button>
      <div
        v-for="(rule, index) in settings.rules"
        :key="rule.id"
        class="rounded-xl border border-gray-200 p-3 dark:border-gray-700"
      >
        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <label
            >适用型号<textarea
              v-model="rule.modelsText"
              class="form-input mt-1 w-full"
              placeholder="每行一个完整型号或末尾 * 前缀"
              rows="2"
            />
          </label>
          <div>
            <label class="mb-1 block">使用词表</label
            ><CustomDropdown v-model="rule.tokenizer" :options="catalog.tokenizers" />
          </div>
          <div>
            <label class="mb-1 block">映射依据</label
            ><CustomDropdown
              v-model="rule.match"
              :options="[
                { value: 'approximate', label: '近似参考' },
                { value: 'verified', label: '已核实映射（管理员确认）' }
              ]"
            />
          </div>
          <label
            >优先级<input
              v-model.number="rule.priority"
              class="form-input mt-1 w-32"
              step="1"
              type="number"
          /></label>
        </div>
        <div class="mt-3 flex items-center justify-between">
          <label class="flex items-center gap-2"
            ><input v-model="rule.enabled" class="h-4 w-4" type="checkbox" />启用</label
          ><button class="text-red-600 dark:text-red-400" @click="settings.rules.splice(index, 1)">
            删除规则
          </button>
        </div>
      </div>
      <p v-if="settings.rules.length === 0" class="text-gray-500">暂无规则，使用自动匹配。</p>
    </template>
    <template v-else-if="tab === 'diagnostics'">
      <p class="text-gray-500">本地估算，不产生模型费用。</p>
      <div class="grid gap-3 sm:grid-cols-2">
        <label
          >实际模型<input
            v-model="diagnostic.model"
            class="form-input mt-1 w-full"
            list="tokenizer-known-models"
            placeholder="填写实际模型名" /><datalist id="tokenizer-known-models">
            <option v-for="model in catalog.models" :key="model" :value="model" /></datalist
        ></label>
        <div>
          <label class="mb-1 block">本次词表</label
          ><CustomDropdown
            v-model="diagnostic.tokenizer"
            :options="[{ value: '', label: '按全局规则自动选择' }, ...catalog.tokenizers]"
          />
        </div>
      </div>
      <textarea
        v-model="diagnostic.text"
        class="form-input w-full"
        placeholder="输入要计数的可见文本，最多 2 MiB"
        rows="5"
      /><button
        class="btn btn-primary px-3 py-2"
        :disabled="counting || !diagnostic.model"
        @click="countText"
      >
        {{ counting ? '计数中...' : '运行计数' }}
      </button>
      <dl
        v-if="countResult"
        class="grid gap-2 rounded-xl bg-gray-50 p-3 sm:grid-cols-2 dark:bg-gray-800"
      >
        <div>
          <dt class="text-gray-500">内容 Token</dt>
          <dd class="font-semibold">{{ countResult.contentTokens }}</dd>
        </div>
        <div>
          <dt class="text-gray-500">来源 / 精度</dt>
          <dd>
            {{ countResult.source }} ·
            {{ precisions[countResult.precision] ?? countResult.precision }}
          </dd>
        </div>
        <div>
          <dt class="text-gray-500">使用词表</dt>
          <dd>{{ countResult.selection?.tokenizer ?? '未匹配，使用粗估' }}</dd>
        </div>
        <div>
          <dt class="text-gray-500">耗时</dt>
          <dd>{{ countResult.costMs }} ms</dd>
        </div>
        <div class="sm:col-span-2">
          <dt class="text-gray-500">引擎版本 / 词表 SHA256</dt>
          <dd class="break-all font-mono">
            {{ countResult.revision ?? '无' }} / {{ countResult.vocabSha256 ?? '无' }}
          </dd>
        </div>
        <div v-if="countResult.fallbackReason" class="sm:col-span-2">
          <dt class="text-gray-500">回退原因</dt>
          <dd>{{ countResult.fallbackReason }}</dd>
        </div>
      </dl>
    </template>
    <template v-else-if="tab === 'tasks'">
      <button class="btn btn-secondary px-3 py-2" @click="loadTasks">刷新任务</button>
      <div
        v-for="task in tasks"
        :key="task.id"
        class="rounded-xl border border-gray-200 p-3 dark:border-gray-700"
      >
        <div class="flex flex-wrap justify-between gap-2">
          <span class="font-medium"
            >{{ operationNames[task.operation] }} · {{ taskStates[task.state] ?? task.state }}</span
          ><span>{{ task.completed }} / {{ task.total }}</span>
        </div>
        <p v-if="task.filesTotal" class="mt-1 text-gray-500">
          文件 {{ task.filesCompleted ?? 0 }} / {{ task.filesTotal
          }}<span v-if="task.activeDownloads">，{{ task.activeDownloads }} 个下载中</span>
        </p>
        <p class="mt-2">{{ task.ids.join('、') }}</p>
        <p class="mt-1 text-gray-500">{{ task.message }}</p>
        <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span class="text-gray-500">{{ formatLocalDateTime(task.createdAt) }}</span
          ><button
            v-if="['queued', 'running'].includes(task.state)"
            class="text-red-600 dark:text-red-400"
            @click="cancelTask(task.id)"
          >
            取消任务</button
          ><button
            v-else-if="['cancelled', 'failed', 'interrupted'].includes(task.state)"
            class="text-blue-600 dark:text-blue-400"
            @click="startTask(task.operation, task.ids)"
          >
            重新执行所选任务
          </button>
        </div>
      </div>
      <p v-if="tasks.length === 0" class="text-gray-500">暂无词表任务。</p>
    </template>
    <AppDialog
      :model-value="Boolean(detail)"
      size="lg"
      title="词表型号与文件"
      @update:model-value="detail = null"
      ><template v-if="detail"
        ><p class="font-medium">{{ detail.name }}</p>
        <a
          v-if="detail.sourceUrl"
          class="mt-2 inline-block text-blue-600 dark:text-blue-400"
          :href="detail.sourceUrl"
          rel="noreferrer"
          target="_blank"
          >查看来源</a
        >
        <p class="mt-2 text-gray-500">
          {{ detail.family }} · {{ detail.format }} ·
          {{ detail.currentRevision || detail.version || '尚未下载' }}
        </p>
        <div v-if="detail.currentRevision !== undefined" class="mt-3 flex flex-wrap gap-2">
          <button
            class="btn btn-secondary"
            :disabled="taskStarting || taskBusy"
            @click="startTask('update', [detail.id])"
          >
            更新此词表</button
          ><button
            class="btn btn-secondary"
            :disabled="taskStarting || taskBusy"
            @click="startTask('verify', [detail.id])"
          >
            本地校验
          </button>
        </div>
        <div v-for="coverage in detail.modelCoverage ?? []" :key="coverage.family" class="mt-3">
          <p>{{ coverage.family }} · {{ coverage.versionRule }}</p>
          <p class="mt-1 break-words text-gray-500">{{ coverage.models.join('、') }}</p>
          <p class="mt-1 text-gray-500">{{ coverage.notes }}</p>
        </div>
        <button
          v-if="detail.sha256"
          class="mt-3 break-all text-left font-mono text-blue-600 dark:text-blue-400"
          title="复制 SHA256"
          @click="copyText(detail.sha256)"
        >
          SHA256: {{ detail.sha256 }}
        </button>
        <button
          v-if="detail.countVocabularySha256"
          class="mt-2 break-all text-left font-mono text-blue-600 dark:text-blue-400"
          @click="copyText(detail.countVocabularySha256)"
        >
          计数 SHA256: {{ detail.countVocabularySha256 }}
        </button>
        <p class="mt-2 text-gray-500">{{ detail.notes }}</p>
        <p class="mt-2">
          型号：{{ detail.models?.join('、') || '来源或运行库参考，无独立模型映射' }}
        </p>
        <div
          v-for="file in detail.files"
          :key="file.name"
          class="mt-3 rounded-lg bg-gray-50 p-2 dark:bg-gray-800"
        >
          <p>{{ file.name }} · {{ resourceStatuses[file.status] }}</p>
          <button
            class="mt-1 break-all text-left font-mono text-blue-600 dark:text-blue-400"
            @click="copyText(file.sha256 ?? file.expectedSha256)"
          >
            SHA256: {{ file.sha256 ?? file.expectedSha256 }}
          </button>
          <p v-if="file.message" class="text-gray-500">{{ file.message }}</p>
        </div></template
      ></AppDialog
    >
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import SegmentedTabs from '@/components/common/segmented_tabs.vue'
import CustomDropdown from '@/components/common/custom_dropdown.vue'
import AppDialog from '@/components/common/app_dialog.vue'
import AppSwitch from '@/components/common/app_switch.vue'
import {
  getTokenizerCatalogApi,
  getTokenizerSettingsApi,
  saveTokenizerSettingsApi,
  getTokenizerTasksApi,
  startTokenizerTaskApi,
  cancelTokenizerTaskApi,
  countTokenizerTextApi
} from '@/libs/http_apis'
import { isOk } from '@/libs/http_envelope'
import { copyText, showToast } from '@/libs/tools'
import { formatLocalDateTime } from '@/libs/time'

const props = defineProps({ active: { type: Boolean, default: true } })
const tab = ref('resources')
const tabs = [
  { key: 'resources', label: '词表资源' },
  { key: 'embedded', label: '内置词表' },
  { key: 'rules', label: '模型规则' },
  { key: 'diagnostics', label: '计数诊断' },
  { key: 'tasks', label: '任务记录' }
]
const operations = [
  { value: 'check-updates', label: '检查来源更新' },
  { value: 'download', label: '下载 / 修复所选' },
  { value: 'update', label: '更新所选' },
  { value: 'apply', label: '应用所选词表' },
  { value: 'verify', label: '本地校验所选' }
]
const selectedOperation = ref('download')
const operationNames = Object.fromEntries(
  operations.map((operation) => [operation.value, operation.label])
)
const resourceStatuses = {
  available: '已下载',
  missing: '待下载',
  failed: '校验失败'
}
const taskStates = {
  queued: '等待执行',
  running: '执行中',
  complete: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '执行中断，未确认完成'
}
const precisions = {
  'official-text': '官方文本词表',
  'official-sdk-text': '官方 SDK 文本映射',
  reconstructed: '逆向重建词表',
  approximate: '近似估算'
}
const catalog = reactive({ resources: [], embedded: [], tokenizers: [], models: [] })
const settings = reactive({ rules: [], enabled: true, disabledTokenizers: [] })
const settingsLoaded = ref(false)
const originalSettings = ref('')
const dirty = computed(
  () => settingsLoaded.value && JSON.stringify(settings) !== originalSettings.value
)
const keyword = ref('')
const family = ref('')
const resourceAscending = ref(true)
const selected = ref([])
const loading = ref(false)
const saving = ref(false)
const taskStarting = ref(false)
const error = ref('')
const detail = ref(null)
const tasks = ref([])
const latestTask = computed(
  () => tasks.value.find((task) => ['queued', 'running'].includes(task.state)) ?? tasks.value[0]
)
const taskBusy = computed(() =>
  tasks.value.some((task) => ['queued', 'running'].includes(task.state))
)
const diagnostic = reactive({ text: 'hello world', model: '', tokenizer: '' })
const countResult = ref(null)
const counting = ref(false)
let timer = null
let disposed = false
let lastCompletedSignature = ''
const families = computed(() =>
  [...new Set(catalog.resources.map((resource) => resource.family))].sort()
)
const visibleResources = computed(() =>
  catalog.resources
    .filter(
      (resource) =>
        (!family.value || resource.family === family.value) &&
        `${resource.id} ${resource.name} ${resource.models?.join(' ')}`
          .toLowerCase()
          .includes(keyword.value.toLowerCase())
    )
    .sort((left, right) => (resourceAscending.value ? 1 : -1) * left.id.localeCompare(right.id))
)
const formatBytes = (value) =>
  value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${Math.ceil(value / 1024)} KiB`
const latestRevision = (id) =>
  tasks.value.flatMap((task) => task.result?.updates ?? []).find((update) => update.id === id)
    ?.latestRevision ?? ''
const requireOk = (response) => {
  if (!isOk(response)) throw new Error(response.msg)
  return response.data
}
const refreshInventory = async () => {
  loading.value = true
  error.value = ''
  try {
    Object.assign(catalog, requireOk(await getTokenizerCatalogApi()))
    selected.value = selected.value.filter((id) =>
      catalog.resources.some((resource) => resource.id === id)
    )
  } catch (cause) {
    error.value = cause.message
  } finally {
    loading.value = false
  }
}
const schedulePoll = () => {
  clearTimeout(timer)
  if (
    !disposed &&
    props.active &&
    tasks.value.some((task) => ['queued', 'running'].includes(task.state))
  )
    timer = setTimeout(loadTasks, 2000)
}
const loadTasks = async () => {
  try {
    tasks.value = requireOk(await getTokenizerTasksApi())
    const completedSignature = tasks.value
      .filter((task) => task.state === 'complete')
      .map((task) => task.id)
      .join(',')
    if (completedSignature !== lastCompletedSignature) {
      lastCompletedSignature = completedSignature
      await refreshInventory()
    }
  } catch (cause) {
    error.value = cause.message
  } finally {
    schedulePoll()
  }
}
const startTask = async (operation, ids = selected.value) => {
  taskStarting.value = true
  error.value = ''
  try {
    requireOk(await startTokenizerTaskApi({ operation, ids: [...ids] }))
    detail.value = null
    await loadTasks()
  } catch (cause) {
    error.value = cause.message
  } finally {
    taskStarting.value = false
  }
}
const cancelTask = async (id) => {
  try {
    requireOk(await cancelTokenizerTaskApi(id))
    await loadTasks()
  } catch (cause) {
    error.value = cause.message
  }
}
const toggleAll = (checked) => {
  const ids = visibleResources.value.map((resource) => resource.id)
  selected.value = checked
    ? [...new Set([...selected.value, ...ids])]
    : selected.value.filter((id) => !ids.includes(id))
}
const addRule = () =>
  settings.rules.push({
    id: crypto.randomUUID(),
    models: [],
    modelsText: '',
    tokenizer: 'openai_o200k_base',
    match: 'approximate',
    priority: 0,
    enabled: true
  })
const applySettings = (value) => {
  Object.assign(settings, value)
  settings.rules = value.rules.map((rule) => ({ ...rule, modelsText: rule.models.join('\n') }))
  originalSettings.value = JSON.stringify(settings)
}
const resourceTokenizerIds = (row) =>
  ({
    claude_ctok_data: ['claude_ctok'],
    openai_bpe: ['openai_o200k_base', 'openai_cl100k_base']
  })[row.id] ?? [row.id]
const resourceEnabled = (row) =>
  resourceTokenizerIds(row).every((id) => !settings.disabledTokenizers.includes(id))
const toggleTokenizer = (id, enabled) => {
  settings.disabledTokenizers = enabled
    ? settings.disabledTokenizers.filter((value) => value !== id)
    : [...new Set([...settings.disabledTokenizers, id])]
}
const toggleResource = (row, enabled) =>
  resourceTokenizerIds(row).forEach((id) => toggleTokenizer(id, enabled))
const saveSettings = async () => {
  saving.value = true
  error.value = ''
  try {
    const payload = {
      ...settings,
      rules: settings.rules.map((rule) => ({
        ...rule,
        models: rule.modelsText
          .split(/\r?\n/)
          .map((model) => model.trim())
          .filter(Boolean)
      }))
    }
    applySettings(requireOk(await saveTokenizerSettingsApi(payload)))
    showToast('词表设置已保存', 'success')
  } catch (cause) {
    error.value = cause.message
  } finally {
    saving.value = false
  }
}
const countText = async () => {
  counting.value = true
  error.value = ''
  try {
    countResult.value = requireOk(await countTokenizerTextApi(diagnostic))
  } catch (cause) {
    error.value = cause.message
  } finally {
    counting.value = false
  }
}
watch(
  () => props.active,
  (active) => {
    if (active) loadTasks()
    else clearTimeout(timer)
  }
)
onMounted(async () => {
  await Promise.all([
    refreshInventory(),
    loadTasks(),
    (async () => {
      try {
        applySettings(requireOk(await getTokenizerSettingsApi()))
        settingsLoaded.value = true
      } catch (cause) {
        error.value = cause.message
      }
    })()
  ])
})
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
})
</script>

<style scoped>
.tokenizer-panel {
  max-width: 100%;
}
.tokenizer-heading,
.tokenizer-header-actions,
.tokenizer-toolbar,
.tokenizer-batch,
.tokenizer-row-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.tokenizer-heading {
  justify-content: space-between;
}
.tokenizer-heading h2 {
  font-size: 18px;
  font-weight: 600;
}
.tokenizer-header-actions .btn,
.tokenizer-batch .btn {
  min-height: 32px;
  height: 32px;
  padding: 0 10px;
}
.tokenizer-toolbar {
  gap: 8px;
}
.tokenizer-search {
  width: 230px;
  max-width: 100%;
}
.tokenizer-family {
  width: 150px;
}
.tokenizer-batch {
  margin-left: auto;
}
.tokenizer-operation {
  width: 170px;
}
.tokenizer-table-wrap {
  max-height: 58vh;
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}
.tokenizer-table {
  width: 100%;
  min-width: 700px;
  text-align: left;
  font-size: 14px;
}
.tokenizer-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-muted);
}
.tokenizer-table :is(th, td) {
  padding: 7px 10px;
  vertical-align: middle;
}
.tokenizer-table td {
  border-top: 1px solid var(--divider-color, var(--border-color));
}
.tokenizer-table .tokenizer-check {
  width: 36px;
  padding-right: 4px;
}
.tokenizer-check input {
  width: 16px;
  height: 16px;
  vertical-align: middle;
}
.tokenizer-resource-name {
  text-align: left;
  font-weight: 600;
  white-space: normal;
}
.tokenizer-resource-name span,
.tokenizer-version-note {
  display: block;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 400;
  margin-top: 2px;
}
.tokenizer-resource-name span {
  font-family: var(--font-code, monospace);
}
.tokenizer-state {
  display: inline-block;
}
.resource-available {
  color: var(--success-color, #047857);
}
.resource-failed {
  color: var(--danger-color, #dc2626);
}
.resource-missing {
  color: var(--text-secondary);
}
.tokenizer-row-actions {
  flex-wrap: nowrap;
  gap: 12px;
  white-space: nowrap;
}
.tokenizer-table button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.tokenizer-table .tokenizer-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
}
.tokenizer-task-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 16px;
  background: var(--surface-muted);
  border-radius: 8px;
  padding: 9px 12px;
}
.tokenizer-task-strip > div:first-child {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.tokenizer-task-strip strong {
  font-weight: 600;
}
.tokenizer-task-strip span {
  color: var(--text-secondary);
}
.tokenizer-task-actions {
  display: flex;
  gap: 12px;
}
.tokenizer-task-strip progress {
  width: 100%;
  height: 4px;
  accent-color: var(--primary-color);
}
.task-failed strong,
.task-interrupted strong {
  color: var(--danger-color, #dc2626);
}
.task-complete strong {
  color: var(--success-color, #047857);
}
.tokenizer-hint {
  color: var(--text-secondary);
  font-size: 14px;
}
@media (max-width: 640px) {
  .tokenizer-heading {
    align-items: start;
  }
  .tokenizer-header-actions {
    gap: 6px;
  }
  .tokenizer-search {
    flex: 1;
    width: 160px;
  }
  .tokenizer-family {
    width: 135px;
  }
  .tokenizer-batch {
    width: 100%;
    margin-left: 0;
  }
  .tokenizer-operation {
    flex: 1;
    min-width: 130px;
  }
}
</style>
