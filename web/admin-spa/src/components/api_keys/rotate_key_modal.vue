<template>
  <button v-if="mode === 'key' && (apiKey || pending)" class="btn btn-secondary px-3 py-2 text-sm" @click="open()">{{ pending ? '恢复换 Key 结果' : '更换 Key' }}</button>
  <ModalTransition>
    <div v-if="visible" class="modal fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="modal-content flex w-full max-w-xl flex-col p-4 dark:bg-gray-800">
        <h3 class="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">更换 Key</h3>
        <div class="min-h-32 flex-1 space-y-3 overflow-auto text-sm text-gray-700 dark:text-gray-200">
          <template v-if="newKey"><p>更换成功,旧 Key 已失效。请复制新 Key 并更新客户端配置。</p><span class="cursor-pointer break-all font-mono" @click="copy(newKey)">{{ newKey }}</span></template>
          <template v-else><p>{{ pending ? '上次结果尚未确认。请在 10 分钟内恢复同一次请求;逾期请联系管理员。' : '确认生成全新 Key? 旧 Key 将失效,额度、用量、订单和限制保持不变。' }}</p><p v-if="mode === 'key'">账号所属 Key 请登录账号管理。</p><p v-if="error" class="text-red-600">{{ error }}</p></template>
        </div>
        <div class="mt-3 flex shrink-0 justify-end gap-1"><button class="btn btn-secondary" :disabled="busy" @click="visible = false">关闭</button><button v-if="!newKey" class="btn btn-primary" :disabled="busy" @click="submit">{{ busy ? '处理中...' : pending ? '恢复结果' : '确认更换' }}</button></div>
      </div>
    </div>
  </ModalTransition>
</template>
<script setup>
import { ref } from 'vue'

import ModalTransition from '@/components/common/modal_transition.vue'
import { copyText } from '@/libs/tools'
import { regenerateAdminKeyApi, regenerateUserKeyApi, regenerateSelfKeyApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'

const props = defineProps({ mode: { type: String, default: 'key' }, apiKey: { type: String, default: '' } })
const emit = defineEmits(['rotated'])
const copy = (value) => { if (!window.getSelection()?.toString()) return copyText(value) }
const visible = ref(false), busy = ref(false), newKey = ref(''), error = ref(''), pending = ref(null)
let keyId = ''
const storageKey = 'crsKeyRotationPending'
if (props.mode === 'key') {
  try { const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'); if (saved && typeof saved.apiKey === 'string' && typeof saved.requestId === 'string') pending.value = saved } catch (failure) { console.error('[key rotation]', failure) }
}
const open = (row) => { if (props.mode !== 'key' && keyId !== row?.id) pending.value = null; keyId = row?.id ?? ''; newKey.value = ''; error.value = ''; visible.value = true }
const submit = async () => {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    if (!pending.value) {
      const request = { apiKey: props.apiKey, keyId, requestId: crypto.randomUUID() }
      if (props.mode === 'key') sessionStorage.setItem(storageKey, JSON.stringify(request))
      pending.value = request
    }
    const request = pending.value
    const response = await (props.mode === 'admin' ? regenerateAdminKeyApi(request.keyId, request.requestId) : props.mode === 'user' ? regenerateUserKeyApi(request.keyId, request.requestId) : regenerateSelfKeyApi(request.apiKey, request.requestId))
    if (!isOk(response)) {
      error.value = msgOf(response, '更换失败,请重试同一次请求')
      if ([400, 401, 403, 404, 409].includes(response?.code)) { pending.value = null; if (props.mode === 'key') sessionStorage.removeItem(storageKey) }
      return
    }
    newKey.value = response.data.key
    emit('rotated', response.data)
    pending.value = null
    if (props.mode === 'key') sessionStorage.removeItem(storageKey)
  } catch (failure) {
    console.error('[key rotation]', failure)
    error.value = failure.response?.data?.msg ?? failure.message ?? '结果尚未确认,请恢复同一次请求'
    if ([400, 401, 403, 404, 409].includes(failure.response?.status)) { pending.value = null; if (props.mode === 'key') sessionStorage.removeItem(storageKey) }
  } finally { busy.value = false }
}
defineExpose({ open })
</script>
