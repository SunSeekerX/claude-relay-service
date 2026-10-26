<template>
  <section class="mb-6 rounded-xl border p-4" style="border-color: var(--divider-color)">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <h3 class="mr-2 text-sm font-semibold t-text">访问测试题库</h3>
      <SegmentedTabs v-model="form.selectionMode" :disabled="!ready || saving" :tabs="modes" />
      <button
        class="btn btn-secondary h-8 px-3 text-sm"
        :disabled="loading || saving || dirty"
        type="button"
        @click="load"
      >
        刷新
      </button>
      <button
        class="btn btn-secondary h-8 px-3 text-sm"
        :disabled="!ready || saving || form.templates.length >= 100"
        type="button"
        @click="add"
      >
        新增题目
      </button>
      <button
        class="btn btn-primary h-8 px-3 text-sm"
        :disabled="!ready || loading || saving || !dirty"
        type="button"
        @click="save"
      >
        {{ saving ? '保存中...' : '保存题库' }}
      </button>
    </div>
    <p class="mb-3 text-sm t-text-secondary">
      启用 {{ enabledTemplates.length }}/{{
        form.templates.length
      }}
      道。打开测试时选题,发送当前显示的问题。Claude 定时测试使用当前题库。
    </p>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span class="text-sm t-text-secondary">固定默认题</span>
      <CustomDropdown
        v-model="form.defaultId"
        class="!w-64 max-w-full"
        :disabled="!ready || saving || form.selectionMode !== 'fixed'"
        :options="defaultOptions"
        placeholder="选择固定默认题"
        searchable
      />
    </div>
    <p v-if="loading" class="mb-3 text-sm t-text-secondary">正在加载题库...</p>
    <p v-if="failed" class="mb-3 text-sm text-red-500">读取题库失败,请刷新后再编辑。</p>
    <div class="grid gap-3 md:grid-cols-[260px_minmax(0,1fr)]">
      <div
        class="max-h-[420px] min-h-[220px] overflow-y-auto rounded-lg border"
        style="border-color: var(--divider-color)"
      >
        <div
          v-for="item in form.templates"
          :key="item.id"
          class="flex items-center gap-2 border-b px-3 py-2"
          :class="item.id === selectedId ? 't-item-active' : ''"
          style="border-color: var(--divider-color)"
        >
          <button
            class="min-w-0 flex-1 truncate bg-transparent text-left text-sm t-text border-none"
            :title="item.name"
            type="button"
            @click="selectedId = item.id"
          >
            {{ item.name || '未命名' }}
          </button>
          <label class="flex shrink-0 items-center gap-1 text-sm t-text-secondary">
            <input
              :checked="item.enabled"
              :disabled="!ready || saving"
              type="checkbox"
              @change="setEnabled(item, $event.target.checked)"
            />启用
          </label>
        </div>
        <p v-if="!form.templates.length" class="p-4 text-sm t-text-secondary">
          暂无题目,可新增或手动输入测试问题。
        </p>
      </div>
      <div v-if="selected" class="space-y-3">
        <label class="block text-sm t-text-secondary"
          >题目名称<input
            v-model="selected.name"
            class="form-input mt-1 block w-72 max-w-full"
            :disabled="!ready || saving"
            maxlength="100"
        /></label>
        <label class="block text-sm t-text-secondary"
          >问题正文<textarea
            v-model="selected.prompt"
            class="form-input mt-1 block w-full"
            :disabled="!ready || saving"
            maxlength="32000"
            rows="6"
          />
        </label>
        <label class="block text-sm t-text-secondary"
          >说明<input
            v-model="selected.hint"
            class="form-input mt-1 block w-full"
            :disabled="!ready || saving"
            maxlength="2000"
        /></label>
        <div class="flex flex-wrap gap-2">
          <button
            class="btn btn-secondary h-8 px-3 text-sm"
            :disabled="!ready || saving || selectedIndex === 0"
            type="button"
            @click="move(-1)"
          >
            上移
          </button>
          <button
            class="btn btn-secondary h-8 px-3 text-sm"
            :disabled="!ready || saving || selectedIndex === form.templates.length - 1"
            type="button"
            @click="move(1)"
          >
            下移
          </button>
          <button
            class="btn btn-secondary h-8 px-3 text-sm"
            :disabled="!ready || saving || !selected.enabled"
            type="button"
            @click="setDefault"
          >
            设为默认
          </button>
          <button
            class="btn btn-danger h-8 px-3 text-sm"
            :disabled="!ready || saving"
            type="button"
            @click="confirmRemove = true"
          >
            删除题目
          </button>
        </div>
      </div>
      <p v-else class="p-4 text-sm t-text-secondary">选择或新增一道题目。</p>
    </div>
    <ConfirmModal
      confirm-text="删除"
      :message="`删除 ${selected?.name ?? '这道题目'}?`"
      :show="confirmRemove"
      title="删除题目"
      type="danger"
      @cancel="confirmRemove = false"
      @confirm="remove"
    />
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'

import CustomDropdown from '@/components/common/custom_dropdown.vue'
import SegmentedTabs from '@/components/common/segmented_tabs.vue'
import ConfirmModal from '@/components/common/confirm_modal.vue'
import { getTestPromptConfigApi, updateTestPromptConfigApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast } from '@/libs/tools'
import { parseTestPromptConfig } from '@/libs/use_test_prompts'

const modes = [
  { key: 'random_simple', label: '打开随机选题' },
  { key: 'fixed', label: '固定默认题' }
]
const form = ref({ selectionMode: 'random_simple', defaultId: '', templates: [] })
const baseline = ref(JSON.stringify(form.value))
const ready = ref(false)
const loading = ref(false)
const failed = ref(false)
const saving = ref(false)
const selectedId = ref('')
const confirmRemove = ref(false)
const selectedIndex = computed(() =>
  form.value.templates.findIndex((item) => item.id === selectedId.value)
)
const selected = computed(() => form.value.templates[selectedIndex.value])
const enabledTemplates = computed(() => form.value.templates.filter((item) => item.enabled))
const defaultOptions = computed(() => [
  { value: '', label: '不自动填充' },
  ...enabledTemplates.value.map((item) => ({ value: item.id, label: item.name }))
])
const dirty = computed(() => JSON.stringify(form.value) !== baseline.value)
const apply = (value) => {
  form.value = parseTestPromptConfig(value)
  baseline.value = JSON.stringify(form.value)
  if (!form.value.templates.some((item) => item.id === selectedId.value))
    selectedId.value = form.value.templates[0]?.id ?? ''
}
const load = async () => {
  if (loading.value) return
  loading.value = true
  ready.value = false
  failed.value = false
  try {
    const response = await getTestPromptConfigApi()
    if (!isOk(response) || !response.data?.config) throw new Error(msgOf(response, '读取题库失败'))
    apply(response.data.config)
    ready.value = true
  } catch (error) {
    failed.value = true
    console.error('[TestPrompts] editor load failed', error)
  } finally {
    loading.value = false
  }
}
const add = () => {
  const item = { id: crypto.randomUUID(), name: '新题目', prompt: '', hint: '', enabled: true }
  form.value.templates.push(item)
  selectedId.value = item.id
}
const setEnabled = (item, enabled) => {
  item.enabled = enabled
  if (!enabled && form.value.defaultId === item.id) form.value.defaultId = ''
}
const setDefault = () => {
  form.value.defaultId = selectedId.value
  form.value.selectionMode = 'fixed'
}
const move = (direction) => {
  const index = selectedIndex.value
  const item = form.value.templates.splice(index, 1)[0]
  form.value.templates.splice(index + direction, 0, item)
}
const remove = () => {
  confirmRemove.value = false
  if (form.value.defaultId === selectedId.value) form.value.defaultId = ''
  form.value.templates.splice(selectedIndex.value, 1)
  selectedId.value = form.value.templates[0]?.id ?? ''
}
const save = async () => {
  if (!ready.value || loading.value || saving.value) return
  if (form.value.templates.some((item) => !item.name.trim() || !item.prompt.trim())) {
    showToast('请填写题目名称和正文', 'error')
    return
  }
  saving.value = true
  try {
    const response = await updateTestPromptConfigApi(JSON.parse(JSON.stringify(form.value)))
    if (!isOk(response) || !response.data?.config) throw new Error(msgOf(response, '保存题库失败'))
    apply(response.data.config)
    showToast('测试题库已保存', 'success')
  } catch (error) {
    showToast(error.message, 'error')
    console.error('[TestPrompts] editor save failed', error)
  } finally {
    saving.value = false
  }
}
onMounted(load)
</script>
