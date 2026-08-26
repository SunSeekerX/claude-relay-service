<template>
  <div class="space-y-3">
    <CuteOptionCards
      v-model="mode"
      :columns="1"
      :disabled="false"
      :options="modeOptions"
      size="md"
    />

    <div v-if="mode === 'custom'" class="rounded-xl border border-gray-200 p-3 dark:border-gray-600">
      <ProxyConfig
        :model-value="modelValue"
        @update:model-value="(v) => emit('update:modelValue', v)"
      />
    </div>

    <div v-if="mode === 'group'" class="rounded-xl border border-gray-200 p-3 dark:border-gray-600">
      <CustomDropdown
        accent="blue"
        :disabled="!canBindPool"
        icon="i-lucide-layers"
        :model-value="proxyGroupId"
        :options="groupOptions"
        placeholder="— 选择分组 —"
        @update:model-value="onGroupChange"
      />
    </div>

    <div v-if="mode === 'proxy'" class="rounded-xl border border-gray-200 p-3 dark:border-gray-600">
      <CustomDropdown
        accent="blue"
        :disabled="!canBindPool"
        icon="i-lucide-server"
        :model-value="proxyId"
        :options="proxyOptions"
        placeholder="— 选择代理 —"
        @update:model-value="onProxyChange"
      />
    </div>

    <p v-if="poolSupported && !accountId" class="text-sm text-amber-500">
      代理池绑定需先保存账户，再在编辑中设置（创建前的授权流程仅支持自定义代理）
    </p>
    <p v-else-if="!poolSupported" class="text-sm text-gray-400">该平台暂不支持代理池绑定</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

import ProxyConfig from './proxy_config.vue'
import CuteOptionCards from '@/components/common/cute_option_cards.vue'
import * as httpApis from '@/libs/http_apis'

// 仅这些平台的 relay 已接入代理池解析，绑定才会真正生效
const POOL_SUPPORTED_PLATFORMS = [
  'claude',
  'claude-console',
  'ccr',
  'droid',
  'openai-responses',
  'azure_openai',
  'openai',
  'gemini',
  'gemini-antigravity',
  'gemini-api',
  'bedrock'
]

// 完全受控组件：mode 与三个绑定值都由父表单持有（props），本组件不保存任何模式/绑定状态。
// 切换模式时 emit update:mode + 更新对应绑定值并清空互斥项，全部随父表单一起保存。
const props = defineProps({
  modelValue: { type: Object, default: null },
  platform: { type: String, default: '' },
  accountId: { type: String, default: '' },
  proxyGroupId: { type: String, default: '' },
  proxyId: { type: String, default: '' },
  mode: { type: String, default: 'none' }
})
const emit = defineEmits([
  'update:modelValue',
  'update:proxyGroupId',
  'update:proxyId',
  'update:mode'
])

const groups = ref([])
const proxies = ref([])
const groupOptions = computed(() => [
  { value: '', label: '— 选择分组 —' },
  ...groups.value.map((group) => ({
    value: String(group.id),
    label: `${group.name} (${group.memberCount})`
  }))
])
const proxyOptions = computed(() => [
  { value: '', label: '— 选择代理 —' },
  ...proxies.value.map((proxy) => ({
    value: String(proxy.id),
    label: `${proxy.name} — ${proxy.url}`
  }))
])

const poolSupported = computed(() => POOL_SUPPORTED_PLATFORMS.includes(props.platform))
// 创建态（无 accountId）禁用代理池：池绑定 relay 时才解析，而创建前的授权流程（OAuth/SetupToken/Cookie/设备码）
// 在账户落库前发起、只能用静态 proxy；先存账户、再在编辑里绑池
const canBindPool = computed(() => poolSupported.value && !!props.accountId)

const modeOptions = computed(() => [
  {
    value: 'none',
    label: '不使用代理',
    description: '直连上游，不经过任何代理',
    icon: 'i-lucide-ban'
  },
  {
    value: 'custom',
    label: '自定义代理',
    description: '为该账户单独配置 host/port/鉴权',
    icon: 'i-lucide-wrench'
  },
  {
    value: 'group',
    label: '代理池 · 分组',
    description: canBindPool.value
      ? '负载均衡 + 故障转移 + 健康检查'
      : poolSupported.value
        ? '需先保存账户后再绑定'
        : '该平台暂不支持代理池',
    icon: 'i-lucide-layers',
    disabled: !canBindPool.value
  },
  {
    value: 'proxy',
    label: '代理池 · 指定代理',
    description: canBindPool.value
      ? '固定单个代理，享受健康检查'
      : poolSupported.value
        ? '需先保存账户后再绑定'
        : '该平台暂不支持代理池',
    icon: 'i-lucide-server',
    disabled: !canBindPool.value
  }
])

// 空静态 proxy（切到池子/不使用时清空表单静态代理）
const emptyProxy = () => ({
  enabled: false,
  type: 'socks5',
  host: '',
  port: '',
  username: '',
  password: ''
})

// mode 完全由父持有：get 直接返回 props.mode（无任何本地状态），set 更新模式并清互斥项
const mode = computed({
  get: () => props.mode,
  set: (next) => {
    emit('update:mode', next)
    if (next === 'none') {
      emit('update:proxyGroupId', '')
      emit('update:proxyId', '')
      emit('update:modelValue', emptyProxy())
    } else if (next === 'custom') {
      emit('update:proxyGroupId', '')
      emit('update:proxyId', '')
    } else if (next === 'group') {
      emit('update:proxyId', '')
      emit('update:modelValue', emptyProxy())
    } else if (next === 'proxy') {
      emit('update:proxyGroupId', '')
      emit('update:modelValue', emptyProxy())
    }
  }
})

const onGroupChange = (value) => {
  emit('update:proxyGroupId', value)
}

const onProxyChange = (value) => {
  emit('update:proxyId', value)
}

const loadPoolData = async () => {
  if (!poolSupported.value) {
    return
  }
  const [groupRes, proxyRes] = await Promise.all([
    httpApis.getProxyGroupsApi(),
    httpApis.getProxiesApi()
  ])
  if (groupRes.success) {
    groups.value = groupRes.data || []
  }
  if (proxyRes.success) {
    proxies.value = proxyRes.data || []
  }
}

onMounted(loadPoolData)
</script>
