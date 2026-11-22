<template>
  <ModalTransition>
    <div v-if="visible" class="modal fixed inset-0 z-50 flex items-center justify-center p-3">
      <div class="modal-content flex h-[min(760px,90%)] max-h-full w-full max-w-6xl flex-col p-4 dark:bg-gray-800">
        <h3 class="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">Key 轨迹</h3>
        <div class="mb-2 flex flex-wrap items-center gap-1"><input v-model="apiKey" class="form-input w-96 max-w-full" placeholder="输入完整的新 Key 或旧 Key" @keyup.enter="search" /><button class="btn btn-primary" :disabled="loading" @click="search">查询</button><button class="btn btn-secondary" @click="showAll">全部记录</button><button class="btn btn-secondary" @click="toggleSort">{{ sortOrder === 'desc' ? '时间降序' : '时间升序' }}</button></div>
        <div class="mb-2 min-h-16 text-sm text-gray-700 dark:text-gray-200">
          <p v-if="error" class="text-red-600">{{ error }}</p>
          <template v-else-if="target"><div class="flex flex-wrap items-center gap-2"><span class="cursor-pointer" @click="copy(target.keyName)">{{ target.keyName }}</span><span>{{ target.ownerName || (target.ownerId ? '原用户 ' + target.ownerId : '独立 Key') }}</span><span>{{ target.deleted ? '已删除' : '当前存在' }}</span><button v-if="!target.deleted" class="btn btn-secondary" @click="rotation.open({ id: target.keyId })">换发新 Key</button></div><div class="text-gray-500">Key ID: <span class="cursor-pointer" @click="copy(target.keyId)">{{ target.keyId }}</span></div></template>
          <span v-else>{{ apiKey || keyId ? '未找到此 Key' : '仅保留上线后的轨迹;输入完整 Key 可检索,表中显示凭据指纹' }}</span>
        </div>
        <div class="flex items-center gap-1"><span>共 {{ total }} 条</span><button class="btn btn-secondary" :disabled="page <= 1 || loading" @click="changePage(-1)">上一页</button><span>{{ page }}</span><button class="btn btn-secondary" :disabled="page * 20 >= total || loading" @click="changePage(1)">下一页</button></div>
<VirtualTable class="min-h-0 flex-1 overflow-auto rounded border border-gray-200 dark:border-gray-700" :row-key="row => row.id" :rows="rows">
<table class="w-full text-left text-sm text-gray-700 dark:text-gray-200"><thead class="sticky top-0 bg-gray-100 dark:bg-gray-900"><tr><th>Key / 当时归属</th><th>操作</th><th>旧凭据指纹</th><th>新凭据指纹</th><th>操作人 / IP</th><th>北京时间</th></tr></thead><VirtualTableRows v-slot="{ row: row }"><tr  :key="row.id" class="border-t border-gray-200 dark:border-gray-700"><td class="p-2"><span class="cursor-pointer" @click="copy(row.keyName)">{{ row.keyName }}</span><div>{{ row.ownerName || (row.ownerId ? '原用户 ' + row.ownerId : '独立 Key') }}</div></td><td>{{ actions[row.action] }}</td><td class="p-2 font-mono"><span class="cursor-pointer" :title="row.oldHash" @click="copy(row.oldHash)">{{ row.oldHash?.slice(0, 12) }}...</span></td><td class="p-2 font-mono"><span v-if="row.newHash" class="cursor-pointer" :title="row.newHash" @click="copy(row.newHash)">{{ row.newHash.slice(0, 12) }}...</span></td><td class="p-2"><span>{{ actors[row.actorKind] }} {{ row.actorName }}</span><div class="cursor-pointer" @click="copy(row.ip)">{{ row.ip }}</div></td><td class="whitespace-nowrap p-2"><span class="cursor-pointer" @click="copy(formatTime(row.eventTime))">{{ formatTime(row.eventTime) }}</span></td></tr></VirtualTableRows></table>
</VirtualTable>
        <div class="mt-3 flex shrink-0 flex-wrap items-center justify-between gap-1"><button class="btn btn-secondary" @click="visible = false">关闭</button></div>
      </div>
    </div>
  </ModalTransition>
  <RotateKeyModal ref="rotation" mode="admin" @rotated="load" />
</template>
<script setup>
import { ref } from 'vue'

import VirtualTable from '@/components/common/virtual_table.vue'
import VirtualTableRows from '@/components/common/virtual_table_rows.vue'
import ModalTransition from '@/components/common/modal_transition.vue'
import { copyText } from '@/libs/tools'
import RotateKeyModal from './rotate_key_modal.vue'
import { getKeyCredentialHistoryApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'

const visible = ref(false), apiKey = ref(''), keyId = ref(''), rows = ref([]), target = ref(null), page = ref(1), total = ref(0), error = ref(''), loading = ref(false), rotation = ref(null)
const sortOrder = ref('desc')
const toggleSort = () => { sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc'; page.value = 1; return load() }
const actions = { create: '创建', rotate: '更换', delete: '删除', purge: '彻底删除' }, actors = { admin: '管理员', user: '用户', key: '独立 Key', system: '系统' }
const copy = (value) => { if (value && !window.getSelection()?.toString()) return copyText(value) }
const formatTime = (value) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
let sequence = 0
const load = async () => {
  const run = ++sequence
  loading.value = true; error.value = ''
  try { const response = await getKeyCredentialHistoryApi({ apiKey: apiKey.value.trim(), keyId: keyId.value, page: page.value, pageSize: 20, sortOrder: sortOrder.value }); if (run !== sequence) return; if (!isOk(response)) throw Error(msgOf(response, '查询失败')); rows.value = response.data.rows; total.value = response.data.total; target.value = response.data.target } catch (failure) { console.error('[key history]', failure); if (run === sequence) error.value = 'Key 轨迹加载失败' } finally { if (run === sequence) loading.value = false }
}
const search = () => { keyId.value = ''; page.value = 1; return load() }
const showAll = () => { apiKey.value = ''; return search() }
const changePage = (delta) => { page.value += delta; return load() }
const open = (row) => { keyId.value = row?.id ?? ''; apiKey.value = ''; rows.value = []; target.value = null; page.value = 1; total.value = 0; visible.value = true; return load() }
defineExpose({ open })
</script>
