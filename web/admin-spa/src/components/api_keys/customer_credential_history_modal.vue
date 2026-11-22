<script setup>
import { ref, watch } from 'vue'

import VirtualTable from '@/components/common/virtual_table.vue'
import VirtualTableRows from '@/components/common/virtual_table_rows.vue'
import ModalTransition from '@/components/common/modal_transition.vue'
import { getUserKeyCredentialHistoryApi, getSelfKeyCredentialHistoryApi } from '@/libs/http_apis.js'
import { isOk } from '@/libs/http_envelope.js'
import { formatBeijingDateTime } from '@/libs/time.js'

const props = defineProps({ mode: { type: String, default: 'key' }, apiKey: { type: String, default: '' } })
const visible = ref(false), rows = ref([]), total = ref(0), page = ref(1), loading = ref(false), error = ref(''), sortOrder = ref('desc'), keyName = ref('')
let keyId = '', sequence = 0
const actors = { user: '账号操作', key: '持 Key 操作', admin: '管理员', system: '系统' }
const actions = { rotate: '更换', create: '创建', delete: '删除', purge: '删除' }
const close = () => { sequence++; visible.value = false; rows.value = []; total.value = 0; loading.value = false; error.value = '' }
const load = async () => {
  const run = ++sequence
  loading.value = true; rows.value = []; error.value = ''
  try {
    const params = { page: page.value, pageSize: 20, sortOrder: sortOrder.value }
    const response = props.mode === 'user' ? await getUserKeyCredentialHistoryApi(keyId, params) : await getSelfKeyCredentialHistoryApi(props.apiKey, params)
    if (run !== sequence) return
    if (!isOk(response)) throw Error('换 Key 记录加载失败,请重试')
    rows.value = response.data.rows; total.value = response.data.total
  } catch (failure) {
    console.error('[key history]', failure)
    if (run === sequence) { error.value = '换 Key 记录加载失败,请重试'; total.value = 0 }
  } finally { if (run === sequence) loading.value = false }
}
const open = (row) => { keyId = row?.id ?? ''; keyName.value = row?.name ?? ''; page.value = 1; sortOrder.value = 'desc'; total.value = 0; visible.value = true; return load() }
const toggleSort = () => { sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc'; page.value = 1; return load() }
const changePage = (delta) => { page.value += delta; return load() }
watch(() => props.apiKey, close)
defineExpose({ open, close })
</script>

<template>
  <ModalTransition>
    <div v-if="visible" class="modal fixed inset-0 z-50 flex items-center justify-center p-3">
      <div class="modal-content flex h-[min(640px,90%)] max-h-full w-full max-w-4xl flex-col p-4 dark:bg-gray-800">
        <h3 class="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">{{ keyName ? `${keyName} - 换 Key 记录` : '换 Key 记录' }}</h3>
        <div class="mb-3 flex shrink-0 flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <span>历史凭据仅显示末 4 位;未保存尾号的旧记录显示“未记录”。</span>
          <button class="btn btn-secondary" :disabled="loading" type="button" @click="toggleSort">{{ sortOrder === 'desc' ? '时间降序' : '时间升序' }}</button>
          <button class="btn btn-secondary" :disabled="loading" type="button" @click="load">刷新</button>
        </div>
        <div class="flex flex-wrap items-center gap-1 text-sm text-gray-700 dark:text-gray-200"><span>共 {{ total }} 条</span><button class="btn btn-secondary" :disabled="page <= 1 || loading" type="button" @click="changePage(-1)">上一页</button><span>{{ page }}</span><button class="btn btn-secondary" :disabled="page * 20 >= total || loading" type="button" @click="changePage(1)">下一页</button></div>
<VirtualTable class="min-h-0 flex-1 overflow-auto rounded border border-gray-200 dark:border-gray-700" :row-key="row => row.id" :rows="rows">
<table class="w-full text-left text-sm text-gray-700 dark:text-gray-200"><thead class="sticky top-0 bg-gray-100 dark:bg-gray-900"><tr><th class="whitespace-nowrap p-2">时间（北京时间）</th><th class="whitespace-nowrap p-2">操作来源</th><th class="whitespace-nowrap p-2">操作</th><th class="whitespace-nowrap p-2">更换前</th><th class="whitespace-nowrap p-2">更换后</th></tr></thead>
            <VirtualTableRows v-slot="{ row: row }"><tr  :key="row.id" class="border-t border-gray-200 dark:border-gray-700"><td class="whitespace-nowrap p-2">{{ formatBeijingDateTime(row.eventTime) }}</td><td class="whitespace-nowrap p-2">{{ actors[row.actorKind] ?? '未记录' }}</td><td class="whitespace-nowrap p-2">{{ actions[row.action] ?? '未记录' }}</td><td class="whitespace-nowrap p-2 font-mono">{{ row.oldKeyMasked || '未记录' }}</td><td class="whitespace-nowrap p-2 font-mono">{{ row.newKeyMasked || '未记录' }}</td></tr></VirtualTableRows><tbody v-if="loading || error || !rows.length"><tr ><td class="p-6 text-center" :class="error ? 'text-red-600' : ''" colspan="5">{{ loading ? '正在加载...' : error || '暂无换 Key 记录' }}</td></tr></tbody>
          </table>
</VirtualTable>
        <div class="mt-3 flex shrink-0 flex-wrap items-center justify-between gap-2"><button class="btn btn-secondary" type="button" @click="close">关闭</button></div>
      </div>
    </div>
  </ModalTransition>
</template>
