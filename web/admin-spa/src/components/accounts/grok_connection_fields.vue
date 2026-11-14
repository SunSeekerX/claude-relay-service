<template>
  <div class="space-y-3 text-sm">
    <label class="block space-y-1">
      <span class="font-medium text-gray-700 dark:text-gray-200">Grok 上游地址</span>
      <select class="form-input w-full" :value="mode" @change="selectMode($event.target.value)">
        <option v-for="item in choices" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
        <option value="custom">自定义中转</option>
      </select>
    </label>
    <p v-if="mode === 'us'" class="text-gray-500 dark:text-gray-400">
      美国端点提供文本模型，不提供图像、视频和语音服务。
    </p>
    <label v-if="mode === 'custom'" class="block space-y-1">
      <span class="font-medium text-gray-700 dark:text-gray-200">自定义 Base URL</span>
      <input
        v-model="baseUrl"
        class="form-input w-full"
        placeholder="https://relay.example.com/v1"
        required
        type="url"
      />
    </label>
    <p v-if="oauth && mode === 'custom'" class="text-amber-700 dark:text-amber-300">
      OAuth 凭证将用于此上游；授权与刷新仍使用官方端点。
    </p>
    <AccountApiKeyField
      v-if="!oauth"
      v-model="apiKey"
      v-model:replace-enabled="replaceEnabled"
      :editing="editing"
    />
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import AccountApiKeyField from './account_api_key_field.vue'

const props = defineProps({ oauth: Boolean, editing: Boolean })
const baseUrl = defineModel('baseUrl', { type: String, default: '' })
const apiKey = defineModel('apiKey', { type: String, default: '' })
const replaceEnabled = defineModel('replaceEnabled', { type: Boolean, default: false })
const choices = computed(() =>
  props.oauth
    ? [{ value: 'cli', label: '官方 Grok CLI', url: 'https://cli-chat-proxy.grok.com/v1' }]
    : [
        { value: 'api', label: '官方 xAI API', url: 'https://api.x.ai/v1' },
        { value: 'us', label: '官方美国区域（上游费用 +10%）', url: 'https://us.api.x.ai/v1' }
      ]
)
const deriveMode = () =>
  !baseUrl.value
    ? choices.value[0].value
    : choices.value.find((item) => item.url === baseUrl.value.replace(/\/+$/, ''))?.value ||
      'custom'
const mode = ref(deriveMode())
watch(
  () => props.oauth,
  () => {
    mode.value = choices.value[0].value
    baseUrl.value = choices.value[0].url
  }
)
const selectMode = (value) => {
  mode.value = value
  baseUrl.value = value === 'custom' ? '' : choices.value.find((item) => item.value === value).url
}
</script>
