<template>
  <div class="claude-settings max-w-3xl">
    <div v-if="loading" class="py-12 text-center">
      <div class="loading-spinner mx-auto mb-4"></div>
      <p class="t-text-secondary text-sm">正在加载配置...</p>
    </div>

    <div v-else-if="loadFailed" class="py-12 text-center">
      <p class="mb-3 text-sm text-red-600 dark:text-red-400">{{ loadError || '获取转发配置失败' }}</p>
      <button class="btn btn-primary h-8 px-3 text-sm" type="button" @click="loadClaudeConfig">
        <i class="i-lucide-refresh-cw mr-1.5"></i>
        重新加载
      </button>
    </div>

    <div v-else class="cs-stack">
      <!-- 仅 Claude Code -->
      <div class="cs-block">
        <div class="cs-row">
          <div class="cs-row__text">
            <div class="cs-row__title">仅允许 Claude Code 客户端</div>
            <p class="cs-row__desc">
              强制校验
              <code class="cs-code">/api/v1/messages</code>
              与
              <code class="cs-code">/claude/v1/messages</code>
              的 Claude Code CLI。与 API Key 级限制为 OR。
            </p>
          </div>
          <AppSwitch
            :model-value="!!claudeConfig.claudeCodeOnlyEnabled"
            color="blue"
            size="md"
            @change="(value) => onToggle('claudeCodeOnlyEnabled', value)"
          />
        </div>
      </div>

      <!-- 会话绑定 -->
      <div class="cs-block">
        <div class="cs-row">
          <div class="cs-row__text">
            <div class="cs-row__title">强制会话绑定</div>
            <p class="cs-row__desc">
              将原始 session ID 绑定首次账户，保证上下文一致；污染会话（历史无记录且 messages.length &gt; 1）会被拒绝。
            </p>
          </div>
          <AppSwitch
            :model-value="!!claudeConfig.globalSessionBindingEnabled"
            color="blue"
            size="md"
            @change="(value) => onToggle('globalSessionBindingEnabled', value)"
          />
        </div>
        <div v-if="claudeConfig.globalSessionBindingEnabled" class="cs-sub">
          <label class="cs-field">
            <span class="cs-field__label">绑定有效期（天）</span>
            <input
              v-model.number="claudeConfig.sessionBindingTtlDays"
              class="form-input max-w-xs"
              max="365"
              min="1"
              type="number"
              @change="saveClaudeConfig({ silent: true })"
            />
          </label>
          <label class="cs-field">
            <span class="cs-field__label">旧会话污染提示</span>
            <textarea
              v-model="claudeConfig.sessionBindingErrorMessage"
              class="form-input w-full"
              rows="2"
              placeholder="你的本地session已污染，请清理后使用。"
              @change="saveClaudeConfig({ silent: true })"
            ></textarea>
          </label>
        </div>
      </div>

      <!-- 用户消息串行队列 -->
      <div class="cs-block">
        <div class="cs-row">
          <div class="cs-row__text">
            <div class="cs-row__title">用户消息串行队列</div>
            <p class="cs-row__desc">
              同一账户的 user 消息串行并加间隔，降低上游限流；工具结果/助手续传不受限。
            </p>
          </div>
          <AppSwitch
            :model-value="!!claudeConfig.userMessageQueueEnabled"
            color="blue"
            size="md"
            @change="(value) => onToggle('userMessageQueueEnabled', value)"
          />
        </div>
        <div v-if="claudeConfig.userMessageQueueEnabled" class="cs-sub cs-sub--grid">
          <label class="cs-field">
            <span class="cs-field__label">请求间隔（ms）</span>
            <input
              v-model.number="claudeConfig.userMessageQueueDelayMs"
              class="form-input"
              max="10000"
              min="0"
              type="number"
              @change="saveClaudeConfig({ silent: true })"
            />
          </label>
          <label class="cs-field">
            <span class="cs-field__label">队列超时（ms）</span>
            <input
              v-model.number="claudeConfig.userMessageQueueTimeoutMs"
              class="form-input"
              max="300000"
              min="1000"
              type="number"
              @change="saveClaudeConfig({ silent: true })"
            />
          </label>
        </div>
      </div>

      <!-- 并发请求排队 -->
      <div class="cs-block">
        <div class="cs-row">
          <div class="cs-row__text">
            <div class="cs-row__title">并发请求排队</div>
            <p class="cs-row__desc">账户并发打满后进入排队，而非直接 429。</p>
          </div>
          <AppSwitch
            :model-value="!!claudeConfig.concurrentRequestQueueEnabled"
            color="blue"
            size="md"
            @change="(value) => onToggle('concurrentRequestQueueEnabled', value)"
          />
        </div>
        <div v-if="claudeConfig.concurrentRequestQueueEnabled" class="cs-sub cs-sub--grid">
          <label class="cs-field">
            <span class="cs-field__label">固定最小排队数</span>
            <input
              v-model.number="claudeConfig.concurrentRequestQueueMaxSize"
              class="form-input"
              min="0"
              type="number"
              @change="saveClaudeConfig({ silent: true })"
            />
          </label>
          <label class="cs-field">
            <span class="cs-field__label">排队数倍数</span>
            <input
              v-model.number="claudeConfig.concurrentRequestQueueMaxSizeMultiplier"
              class="form-input"
              min="0"
              step="0.1"
              type="number"
              @change="saveClaudeConfig({ silent: true })"
            />
          </label>
          <label class="cs-field">
            <span class="cs-field__label">排队超时（ms）</span>
            <input
              v-model.number="claudeConfig.concurrentRequestQueueTimeoutMs"
              class="form-input"
              min="1000"
              type="number"
              @change="saveClaudeConfig({ silent: true })"
            />
          </label>
        </div>
      </div>

      <!-- 请求明细 -->
      <div class="cs-block">
        <div class="cs-row">
          <div class="cs-row__text">
            <div class="cs-row__title">请求明细采集</div>
            <p class="cs-row__desc">
              采集请求摘要供「请求明细」检索。关闭后已有数据保留至自然过期。
            </p>
          </div>
          <AppSwitch
            :model-value="!!claudeConfig.requestDetailCaptureEnabled"
            color="blue"
            size="md"
            @change="(value) => onToggle('requestDetailCaptureEnabled', value)"
          />
        </div>
        <div v-if="claudeConfig.requestDetailCaptureEnabled" class="cs-sub">
          <div class="cs-field">
            <span class="cs-field__label">保留时间（天 + 小时，合计 1–720 小时）</span>
            <div class="flex max-w-md gap-3">
              <label class="min-w-0 flex-1">
                <span class="mb-1 block t-text-secondary text-sm">天</span>
                <input
                  v-model.number="requestDetailRetentionInput.days"
                  class="form-input w-full"
                  max="30"
                  min="0"
                  type="number"
                  @change="handleRequestDetailRetentionChange"
                />
              </label>
              <label class="min-w-0 flex-1">
                <span class="mb-1 block t-text-secondary text-sm">小时</span>
                <input
                  v-model.number="requestDetailRetentionInput.hours"
                  class="form-input w-full"
                  max="23"
                  min="0"
                  type="number"
                  @change="handleRequestDetailRetentionChange"
                />
              </label>
            </div>
            <p v-if="requestDetailRetentionError" class="mt-1 text-sm text-red-500">
              {{ requestDetailRetentionError }}
            </p>
            <p v-else-if="requestDetailRetentionWarning" class="mt-1 text-sm text-amber-600 dark:text-amber-400">
              {{ requestDetailRetentionWarning }}
            </p>
          </div>

          <div class="cs-row cs-row--nested">
            <div class="cs-row__text">
              <div class="cs-row__title">请求体预览</div>
              <p class="cs-row__desc">
                保存脱敏截断预览（增 Redis 压力）。关闭只影响新请求；历史可在请求明细页清理。
              </p>
            </div>
            <AppSwitch
              :model-value="!!claudeConfig.requestDetailBodyPreviewEnabled"
              color="blue"
              size="sm"
              :disabled="requestDetailBodyPreviewSaving"
              @change="handleRequestDetailBodyPreviewToggle"
            />
          </div>
        </div>
      </div>

      <!-- 账号错误收集 -->
      <div class="cs-block">
        <div class="cs-row">
          <div class="cs-row__text">
            <div class="cs-row__title">账号错误收集</div>
            <p class="cs-row__desc">
              记录上游错误供账号「错误历史」查看；关闭后停采新错误，已有历史保留至过期。
            </p>
          </div>
          <AppSwitch
            :model-value="!!claudeConfig.errorHistoryCollectionEnabled"
            color="blue"
            size="md"
            :disabled="errorHistoryCollectionSaving"
            @change="handleErrorHistoryCollectionToggle"
          />
        </div>
      </div>

      <div v-if="claudeConfig.updatedAt" class="pt-2 t-text-secondary text-sm">
        最后更新：{{ formatDateTime(claudeConfig.updatedAt) }}
        <span v-if="claudeConfig.updatedBy">· {{ claudeConfig.updatedBy }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'

import { isOk, msgOf, dataOf } from '@/libs/http_envelope'
import * as httpApis from '@/libs/http_apis'
import { showToast } from '@/libs/tools'
import { useSettingsStore } from '@/stores/settings'
import AppSwitch from '@/components/common/app_switch.vue'

const settingsStore = useSettingsStore()
const formatDateTime = settingsStore.formatDateTime

const isMounted = ref(true)
const abortController = ref(new AbortController())
const loading = ref(true)
const loadFailed = ref(false)
const loadError = ref('')
// 仅在成功拉到服务端配置后允许保存，避免失败时用本地默认值覆盖真实配置
const configReady = ref(false)

const REQUEST_DETAIL_RETENTION_DEFAULT_HOURS = 6
const REQUEST_DETAIL_RETENTION_WARNING_HOURS = 72
const REQUEST_DETAIL_RETENTION_MAX_HOURS = 720

const claudeConfig = ref({
  claudeCodeOnlyEnabled: false,
  globalSessionBindingEnabled: false,
  sessionBindingErrorMessage: '你的本地session已污染，请清理后使用。',
  sessionBindingTtlDays: 1,
  userMessageQueueEnabled: false,
  userMessageQueueDelayMs: 200,
  userMessageQueueTimeoutMs: 5000,
  concurrentRequestQueueEnabled: false,
  concurrentRequestQueueMaxSize: 3,
  concurrentRequestQueueMaxSizeMultiplier: 0,
  concurrentRequestQueueTimeoutMs: 10000,
  requestDetailCaptureEnabled: false,
  requestDetailRetentionHours: 6,
  requestDetailBodyPreviewEnabled: false,
  errorHistoryCollectionEnabled: true,
  updatedAt: null,
  updatedBy: null
})

const requestDetailRetentionInput = reactive({
  days: 0,
  hours: REQUEST_DETAIL_RETENTION_DEFAULT_HOURS
})
const requestDetailBodyPreviewSaving = ref(false)
const errorHistoryCollectionSaving = ref(false)

const normalizeRetentionPart = (value) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

const splitRequestDetailRetentionHours = (totalHours = REQUEST_DETAIL_RETENTION_DEFAULT_HOURS) => {
  const normalized = Math.max(
    1,
    Math.min(REQUEST_DETAIL_RETENTION_MAX_HOURS, normalizeRetentionPart(totalHours))
  )
  return {
    days: Math.floor(normalized / 24),
    hours: normalized % 24
  }
}

const syncRequestDetailRetentionInput = (totalHours = REQUEST_DETAIL_RETENTION_DEFAULT_HOURS) => {
  const { days, hours } = splitRequestDetailRetentionHours(totalHours)
  requestDetailRetentionInput.days = days
  requestDetailRetentionInput.hours = hours
}

const requestDetailRetentionTotalHours = computed(() => {
  const days = normalizeRetentionPart(requestDetailRetentionInput.days)
  const hours = normalizeRetentionPart(requestDetailRetentionInput.hours)
  return days * 24 + hours
})

const requestDetailRetentionError = computed(() => {
  const days = normalizeRetentionPart(requestDetailRetentionInput.days)
  const hours = normalizeRetentionPart(requestDetailRetentionInput.hours)
  if (days < 0 || hours < 0) return '保留时间不能为负数'
  if (hours > 23) return '小时须为 0–23'
  if (days > 30) return '天数须为 0–30'
  if (requestDetailRetentionTotalHours.value < 1) return '总保留时间至少 1 小时'
  if (requestDetailRetentionTotalHours.value > REQUEST_DETAIL_RETENTION_MAX_HOURS) {
    return `总保留时间不能超过 ${REQUEST_DETAIL_RETENTION_MAX_HOURS} 小时`
  }
  return ''
})

const requestDetailRetentionWarning = computed(() => {
  if (
    !requestDetailRetentionError.value &&
    requestDetailRetentionTotalHours.value > REQUEST_DETAIL_RETENTION_WARNING_HOURS
  ) {
    return `保留超过 ${REQUEST_DETAIL_RETENTION_WARNING_HOURS} 小时会显著增加存储`
  }
  return ''
})

const loadClaudeConfig = async () => {
  if (!isMounted.value) return
  loading.value = true
  loadFailed.value = false
  loadError.value = ''
  try {
    const response = await httpApis.getClaudeRelayConfigApi({
      signal: abortController.value.signal
    })
    if (!isMounted.value) return
    if (isOk(response)) {
      const config = dataOf(response)?.config || {}
      claudeConfig.value = {
        claudeCodeOnlyEnabled: config.claudeCodeOnlyEnabled ?? false,
        globalSessionBindingEnabled: config.globalSessionBindingEnabled ?? false,
        sessionBindingErrorMessage:
          config.sessionBindingErrorMessage || '你的本地session已污染，请清理后使用。',
        sessionBindingTtlDays: config.sessionBindingTtlDays ?? 1,
        userMessageQueueEnabled: config.userMessageQueueEnabled ?? false,
        userMessageQueueDelayMs: config.userMessageQueueDelayMs ?? 200,
        userMessageQueueTimeoutMs: config.userMessageQueueTimeoutMs ?? 5000,
        concurrentRequestQueueEnabled: config.concurrentRequestQueueEnabled ?? false,
        concurrentRequestQueueMaxSize: config.concurrentRequestQueueMaxSize ?? 3,
        concurrentRequestQueueMaxSizeMultiplier: config.concurrentRequestQueueMaxSizeMultiplier ?? 0,
        concurrentRequestQueueTimeoutMs: config.concurrentRequestQueueTimeoutMs ?? 10000,
        requestDetailCaptureEnabled: config.requestDetailCaptureEnabled ?? false,
        requestDetailRetentionHours:
          config.requestDetailRetentionHours ?? REQUEST_DETAIL_RETENTION_DEFAULT_HOURS,
        requestDetailBodyPreviewEnabled: config.requestDetailBodyPreviewEnabled ?? false,
        errorHistoryCollectionEnabled: config.errorHistoryCollectionEnabled ?? true,
        updatedAt: config.updatedAt || null,
        updatedBy: config.updatedBy || null
      }
      syncRequestDetailRetentionInput(claudeConfig.value.requestDetailRetentionHours)
      configReady.value = true
      loadFailed.value = false
    } else {
      configReady.value = false
      loadFailed.value = true
      loadError.value = msgOf(response, '获取转发配置失败')
      showToast(loadError.value, 'error')
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    configReady.value = false
    loadFailed.value = true
    loadError.value = error.message || '获取转发配置失败'
    showToast(loadError.value, 'error')
    console.error(error)
  } finally {
    if (isMounted.value) loading.value = false
  }
}

const saveClaudeConfig = async (options = {}) => {
  if (!isMounted.value) return
  if (!configReady.value || loadFailed.value) {
    showToast('配置未加载成功，请先重新加载后再保存', 'error')
    return { code: 0, msg: '配置未加载成功' }
  }
  const silent = options.silent === true
  try {
    const requestDetailBodyPreviewEnabled = Object.prototype.hasOwnProperty.call(
      options,
      'requestDetailBodyPreviewEnabled'
    )
      ? options.requestDetailBodyPreviewEnabled === true
      : claudeConfig.value.requestDetailBodyPreviewEnabled

    const payload = {
      claudeCodeOnlyEnabled: claudeConfig.value.claudeCodeOnlyEnabled,
      globalSessionBindingEnabled: claudeConfig.value.globalSessionBindingEnabled,
      sessionBindingErrorMessage: claudeConfig.value.sessionBindingErrorMessage,
      sessionBindingTtlDays: claudeConfig.value.sessionBindingTtlDays,
      userMessageQueueEnabled: claudeConfig.value.userMessageQueueEnabled,
      userMessageQueueDelayMs: claudeConfig.value.userMessageQueueDelayMs,
      userMessageQueueTimeoutMs: claudeConfig.value.userMessageQueueTimeoutMs,
      concurrentRequestQueueEnabled: claudeConfig.value.concurrentRequestQueueEnabled,
      concurrentRequestQueueMaxSize: claudeConfig.value.concurrentRequestQueueMaxSize,
      concurrentRequestQueueMaxSizeMultiplier:
        claudeConfig.value.concurrentRequestQueueMaxSizeMultiplier,
      concurrentRequestQueueTimeoutMs: claudeConfig.value.concurrentRequestQueueTimeoutMs,
      requestDetailCaptureEnabled: claudeConfig.value.requestDetailCaptureEnabled,
      requestDetailRetentionHours: claudeConfig.value.requestDetailRetentionHours,
      requestDetailBodyPreviewEnabled,
      errorHistoryCollectionEnabled: claudeConfig.value.errorHistoryCollectionEnabled
    }

    if (options.purgeRequestDetailBodySnapshots === true) {
      payload.purgeRequestDetailBodySnapshots = true
    }

    const response = await httpApis.updateClaudeRelayConfigApi(payload, {
      signal: abortController.value.signal
    })
    if (isOk(response) && isMounted.value) {
      const payload = dataOf(response) || {}
      const config = payload.config || {}
      claudeConfig.value = {
        ...claudeConfig.value,
        requestDetailRetentionHours:
          config.requestDetailRetentionHours ?? claudeConfig.value.requestDetailRetentionHours,
        requestDetailBodyPreviewEnabled:
          config.requestDetailBodyPreviewEnabled ??
          claudeConfig.value.requestDetailBodyPreviewEnabled,
        updatedAt: config.updatedAt || new Date().toISOString(),
        updatedBy: config.updatedBy || null
      }
      syncRequestDetailRetentionInput(claudeConfig.value.requestDetailRetentionHours)
      if (payload.warning) {
        showToast(payload.warning, 'warning')
      } else if (!silent) {
        showToast(msgOf(response, '转发配置已保存'), 'success')
      }
      return response
    }

    if (isMounted.value) {
      showToast(msgOf(response, '保存转发配置失败'), 'error')
    }
    return response
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    showToast('保存转发配置失败', 'error')
    console.error(error)
    // 非信封失败体：无 code，isOk 为 false
    return { code: 500, msg: error.message || '保存转发配置失败' }
  }
}

const onToggle = async (field, value) => {
  const previous = claudeConfig.value[field]
  claudeConfig.value[field] = value
  const response = await saveClaudeConfig({ silent: true })
  if (!isOk(response)) {
    claudeConfig.value[field] = previous
  }
}

const handleRequestDetailRetentionChange = () => {
  if (requestDetailRetentionError.value) {
    showToast(requestDetailRetentionError.value, 'error')
    return
  }
  claudeConfig.value.requestDetailRetentionHours = requestDetailRetentionTotalHours.value
  saveClaudeConfig({ silent: true })
}

const handleRequestDetailBodyPreviewToggle = async (nextValue) => {
  if (requestDetailBodyPreviewSaving.value) return
  requestDetailBodyPreviewSaving.value = true
  try {
    await saveClaudeConfig({
      requestDetailBodyPreviewEnabled: nextValue === true,
      silent: true
    })
  } catch (error) {
    if (error?.name === 'AbortError') return
    showToast('更新请求体预览配置失败', 'error')
    console.error(error)
  } finally {
    requestDetailBodyPreviewSaving.value = false
  }
}

const handleErrorHistoryCollectionToggle = async (nextValue) => {
  if (errorHistoryCollectionSaving.value) return
  const previous = claudeConfig.value.errorHistoryCollectionEnabled
  claudeConfig.value.errorHistoryCollectionEnabled = nextValue === true
  errorHistoryCollectionSaving.value = true
  try {
    const response = await saveClaudeConfig({ silent: true })
    if (!isOk(response)) {
      claudeConfig.value.errorHistoryCollectionEnabled = previous
    }
  } finally {
    errorHistoryCollectionSaving.value = false
  }
}

onMounted(() => {
  loadClaudeConfig()
})

onBeforeUnmount(() => {
  isMounted.value = false
  abortController.value.abort()
})
</script>

<style scoped>
.cs-stack {
  display: flex;
  flex-direction: column;
}
.cs-block {
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--divider-color);
}
.cs-block:last-of-type {
  border-bottom: 0;
}
.cs-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.cs-row--nested {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px dashed var(--divider-color);
}
.cs-row__text {
  min-width: 0;
  flex: 1;
}
.cs-row__title {
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--text-primary);
}
.cs-row__desc {
  margin: 0.2rem 0 0;
  font-size: 0.875rem;
  line-height: 1.45;
  color: var(--text-secondary);
}
.cs-code {
  border-radius: 0.25rem;
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  padding: 0 0.25rem;
  font-size: 0.8125rem;
}
.cs-sub {
  margin-top: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-left: 0;
}
@media (min-width: 640px) {
  .cs-sub {
    padding-left: 0.25rem;
  }
}
.cs-sub--grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
}
@media (min-width: 640px) {
  .cs-sub--grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.cs-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}
.cs-field__label {
  font-size: 0.875rem;
  color: var(--text-secondary);
}
</style>
