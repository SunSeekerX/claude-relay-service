<template>
  <div class="space-y-4">
    <div>
      <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
        >API 基础地址{{ isCreate ? ' *' : '' }}</label
      >
      <input
        class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
        placeholder="https://api.example.com/v1"
        :required="isCreate"
        type="url"
        :value="baseApi"
        @input="emit('update:baseApi', $event.target.value)"
      />
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        第三方 OpenAI 兼容 API 的基础地址，不要包含具体路径
      </p>
    </div>

    <AccountApiKeyField
      :editing="!isCreate"
      :error="apiKeyError"
      :model-value="apiKey"
      :replace-enabled="replaceEnabled"
      @update:model-value="emit('update:apiKey', $event)"
      @update:replace-enabled="emit('update:replaceEnabled', $event)"
    />

    <div>
      <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
        >自定义 User-Agent</label
      >
      <input
        class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
        placeholder="留空则透传客户端 User-Agent"
        type="text"
        :value="userAgent"
        @input="emit('update:userAgent', $event.target.value)"
      />
    </div>

    <div>
      <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
        >上游请求标识响应头</label
      >
      <input
        class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
        placeholder="留空自动探测 x-request-id / openai-request-id 等"
        type="text"
        :value="upstreamRequestIdHeader"
        @input="emit('update:upstreamRequestIdHeader', $event.target.value)"
      />
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        仅字母数字与连字符，最长 64。配置后只读该头写入请求详情的上游ID。
      </p>
    </div>

    <div>
      <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
        >Provider 端点类型</label
      >
      <CustomDropdown
        accent="blue"
        class="w-full"
        icon="i-lucide-route"
        :model-value="providerEndpoint"
        :options="providerEndpointOptions"
        placeholder="选择端点类型"
        @update:model-value="(v) => emit('update:providerEndpoint', v)"
      />
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Responses：含 chat/completions 也会转到 responses；自动则保持原始路径
      </p>
    </div>

    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
          >每日额度限制 ($)</label
        >
        <input
          class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
          min="0"
          placeholder="0 表示不限制"
          step="0.01"
          type="number"
          :value="dailyQuota"
          @input="emit('update:dailyQuota', Number($event.target.value) || 0)"
        />
      </div>
      <div>
        <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
          >额度重置时间</label
        >
        <input
          class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
          type="time"
          :value="quotaResetTime"
          @input="emit('update:quotaResetTime', $event.target.value)"
        />
      </div>
    </div>

    <div>
      <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300"
        >最大并发任务数</label
      >
      <input
        class="form-input w-full border-transparent dark:border-transparent dark:bg-gray-700 dark:text-gray-200"
        min="0"
        placeholder="0 表示不限制"
        type="number"
        :value="maxConcurrentTasks"
        @input="emit('update:maxConcurrentTasks', Number($event.target.value) || 0)"
      />
    </div>
  </div>
</template>
<script setup>
import AccountApiKeyField from './account_api_key_field.vue'
defineProps({
  isCreate: { type: Boolean, default: false },
  baseApi: { type: String, default: '' },
  apiKey: { type: String, default: '' },
  replaceEnabled: { type: Boolean, default: false },
  apiKeyError: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  upstreamRequestIdHeader: { type: String, default: '' },
  providerEndpoint: { type: String, default: 'responses' },
  dailyQuota: { type: Number, default: 0 },
  quotaResetTime: { type: String, default: '00:00' },
  maxConcurrentTasks: { type: Number, default: 0 },
  providerEndpointOptions: {
    type: Array,
    default: () => [
      { value: 'responses', label: 'Responses（推荐）' },
      { value: 'auto', label: '自动（保持原始路径）' }
    ]
  }
})

const emit = defineEmits([
  'update:baseApi',
  'update:apiKey',
  'update:replaceEnabled',
  'update:userAgent',
  'update:upstreamRequestIdHeader',
  'update:providerEndpoint',
  'update:dailyQuota',
  'update:quotaResetTime',
  'update:maxConcurrentTasks'
])
</script>
