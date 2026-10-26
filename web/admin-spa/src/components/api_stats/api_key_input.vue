<template>
  <section aria-label="统计查询" class="api-query-panel card">
    <div class="api-query-heading">
      <h2><i class="i-lucide-chart-line" />用量查询</h2>
      <SegmentedTabs
        :model-value="multiKeyMode ? 'batch' : 'single'"
        size="sm"
        :tabs="modeOptions"
        @update:model-value="setQueryMode"
      />
      <span class="api-query-hint">{{
        multiKeyMode ? '每行一个或逗号分隔，最多 30 个' : '支持 API Key 或分享链接查询'
      }}</span>
    </div>
    <form class="api-query-form" @submit.prevent="queryStats">
      <label class="api-query-label" for="query-api-key">{{
        multiKeyMode ? 'API Keys' : 'API Key'
      }}</label>
      <div class="api-query-field">
        <input
          v-if="!multiKeyMode"
          id="query-api-key"
          v-model="apiKey"
          autocomplete="off"
          class="form-input w-full"
          :disabled="loading"
          :placeholder="
            apiId ? '当前通过分享链接查询，输入其他 API Key 可切换' : '请输入您的 API Key (cr_...)'
          "
          :type="showPassword ? 'text' : 'password'"
        />
        <textarea
          v-else
          id="query-api-key"
          v-model="apiKey"
          autocomplete="off"
          class="form-input w-full"
          :disabled="loading"
          placeholder="每行一个 API Key，或用逗号分隔"
          rows="2"
        />
        <button
          v-if="!multiKeyMode"
          :aria-label="showPassword ? '隐藏 API Key' : '显示 API Key'"
          :aria-pressed="showPassword"
          class="api-query-eye"
          type="button"
          @click="showPassword = !showPassword"
        >
          <i :class="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'" />
        </button>
      </div>
      <div class="api-query-actions">
        <button class="btn btn-primary" :disabled="loading || !hasValidInput" type="submit">
          <i :class="loading ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-search'" />{{
            loading ? '查询中' : '查询'
          }}
        </button>
        <button
          class="btn btn-secondary"
          :disabled="loading || !canRefresh"
          type="button"
          @click="refreshStats"
        >
          <i class="i-lucide-refresh-cw" />刷新
        </button>
        <button
          class="btn btn-secondary"
          :disabled="loading || (!apiKey && !apiId && !statsData)"
          type="button"
          @click="reset"
        >
          <i class="i-lucide-x" />清空
        </button>
      </div>
    </form>
    <p class="api-query-note">
      {{
        multiKeyMode
          ? `已识别 ${parsedApiKeys.length} 个 Key；Ctrl+Enter 查询`
          : '浏览器记忆上次查询的 Key；Ctrl+Enter 查询'
      }}
    </p>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useApiStatsStore } from '@/stores/api_stats'
import SegmentedTabs from '@/components/common/segmented_tabs.vue'

const apiStatsStore = useApiStatsStore()
const { apiKey, apiId, apiIds, statsData, loading, multiKeyMode } = storeToRefs(apiStatsStore)
const { queryStats, loadStatsWithApiId, reset } = apiStatsStore
const showPassword = ref(false)
const modeOptions = [
  { key: 'single', label: '单 Key' },
  { key: 'batch', label: '多 Key' }
]
const setQueryMode = (mode) => {
  multiKeyMode.value = mode === 'batch'
}
const parsedApiKeys = computed(() =>
  [
    ...new Set(
      apiKey.value
        .split(/[,\n]+/)
        .map((key) => key.trim())
        .filter(Boolean)
    )
  ].slice(0, 30)
)
const hasValidInput = computed(() =>
  multiKeyMode.value ? parsedApiKeys.value.length > 0 : apiKey.value.trim().length > 0
)
const canRefresh = computed(() =>
  multiKeyMode.value
    ? apiIds.value.length > 0 && hasValidInput.value
    : !!apiId.value || hasValidInput.value
)
const refreshStats = () => {
  if (multiKeyMode.value || !apiId.value) return queryStats()
  return loadStatsWithApiId()
}
</script>

<style scoped>
.api-query-panel {
  padding: 12px 14px;
}
.api-query-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 9px;
  flex-wrap: wrap;
}
.api-query-heading h2 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
}
.api-query-hint,
.api-query-note {
  color: var(--text-secondary);
  font-size: 14px;
}
.api-query-note {
  margin: 6px 0 0;
}
.api-query-form {
  display: flex;
  align-items: center;
  gap: 9px;
}
.api-query-label {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 14px;
}
.api-query-field {
  position: relative;
  min-width: 0;
  flex: 1;
}
.api-query-field input {
  padding-right: 38px;
}
.api-query-field textarea.form-input {
  min-height: 64px;
}
.api-query-eye {
  position: absolute;
  top: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: var(--control-height);
  color: var(--text-secondary);
}
.api-query-actions {
  display: flex;
  gap: 7px;
}
.api-query-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding-inline: 11px;
}
@media (max-width: 639px) {
  .api-query-heading {
    gap: 8px;
  }
  .api-query-hint {
    width: 100%;
  }
  .api-query-form {
    flex-wrap: wrap;
  }
  .api-query-label {
    display: none;
  }
  .api-query-field,
  .api-query-actions {
    flex-basis: 100%;
  }
  .api-query-actions .btn {
    flex: 1;
    justify-content: center;
  }
}
</style>
