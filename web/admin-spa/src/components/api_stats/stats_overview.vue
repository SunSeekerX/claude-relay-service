<template>
  <div class="stats-overview">
    <section class="overview-card card">
      <div class="overview-identity">
        <div class="overview-name-row">
          <template v-if="multiKeyMode && aggregatedStats">
            <h3>多 Key 用量汇总</h3>
            <span class="overview-status"
              >{{ aggregatedStats.activeKeys }} / {{ aggregatedStats.totalKeys }} 个有效</span
            >
            <span v-if="invalidKeys.length" class="overview-warning"
              >{{ invalidKeys.length }} 个无效</span
            >
          </template>
          <template v-else>
            <button
              class="overview-key-name"
              :title="`点击复制：${statsData.name}`"
              type="button"
              @click="copyText(statsData.name)"
            >
              {{ statsData.name }}
            </button>
            <span class="overview-status" :class="{ 'is-inactive': !statsData.isActive }">{{
              statsData.isActive ? '活跃' : '已停用'
            }}</span>
          </template>
          <button
            v-if="showTimelineButton"
            class="btn btn-secondary overview-timeline"
            :disabled="timelineDisabled"
            type="button"
            @click="emit('open-timeline')"
          >
            <i class="i-lucide-align-justify" />请求时间线
          </button>
        </div>
        <dl v-if="multiKeyMode && aggregatedStats" class="overview-facts">
          <div>
            <dt>累计请求</dt>
            <dd>{{ formatNumber(aggregatedStats.usage.requests) }}</dd>
          </div>
          <div>
            <dt>累计 Token</dt>
            <dd>{{ formatNumber(aggregatedStats.usage.allTokens) }}</dd>
          </div>
          <div>
            <dt>累计费用</dt>
            <dd>{{ aggregatedStats.usage.formattedCost }}</dd>
          </div>
          <div v-if="individualStats.length > 1">
            <dt>主要用量</dt>
            <dd class="overview-contributors">
              <span v-for="stat in topContributors" :key="stat.apiId"
                >{{ stat.name }} {{ calculateContribution(stat) }}%</span
              >
            </dd>
          </div>
        </dl>
        <dl v-else class="overview-facts">
          <div>
            <dt>权限</dt>
            <dd>{{ formatPermissions(statsData.permissions) }}</dd>
          </div>
          <div>
            <dt>创建</dt>
            <dd>{{ formatDate(statsData.createdAt) }}</dd>
          </div>
          <div>
            <dt>到期</dt>
            <dd>
              <template v-if="statsData.expirationMode === 'activation' && !statsData.isActivated"
                ><span class="overview-warning">未激活</span>，首次使用后
                {{ statsData.activationDays || (statsData.activationUnit === 'hours' ? 24 : 30) }}
                {{ statsData.activationUnit === 'hours' ? '小时' : '天' }}过期</template
              >
              <template v-else-if="statsData.expiresAt"
                ><span
                  :class="{
                    'overview-expired': isApiKeyExpired(statsData.expiresAt),
                    'overview-warning': isApiKeyExpiringSoon(statsData.expiresAt)
                  }"
                  >{{ isApiKeyExpired(statsData.expiresAt) ? '已过期 · ' : ''
                  }}{{ formatExpireDate(statsData.expiresAt) }}</span
                ></template
              >
              <template v-else>永不过期</template>
            </dd>
          </div>
          <div v-if="hasServiceRates">
            <dt>服务倍率</dt>
            <dd class="overview-service-rates">
              <span v-for="(rate, service) in statsData.serviceRates" :key="service"
                >{{ service }} {{ rate }}x</span
              >
            </dd>
          </div>
        </dl>
      </div>
      <dl :aria-label="`${periodText}使用统计概览`" class="overview-metrics">
        <div>
          <dt>{{ periodText }}请求</dt>
          <dd class="usage-input" :title="Number(currentPeriodData.requests ?? 0).toLocaleString()">
            {{ formatNumber(currentPeriodData.requests) }}
          </dd>
        </div>
        <div>
          <dt>{{ periodText }} Token</dt>
          <dd
            class="usage-output"
            :title="Number(currentPeriodData.allTokens ?? 0).toLocaleString()"
          >
            {{ formatNumber(currentPeriodData.allTokens) }}
          </dd>
        </div>
        <div>
          <dt>{{ periodText }}原始费用</dt>
          <dd class="overview-cost usage-cache">
            {{ currentPeriodData.formattedCost || '$0.000000' }}
          </dd>
        </div>
      </dl>
    </section>

    <!-- 专属账号运行状态，仅在单 key 且存在绑定时显示 -->
    <div v-if="!multiKeyMode && boundAccountList.length > 0" class="card-section">
      <header class="section-header">
        <i class="header-icon i-lucide-plug text-indigo-500" />
        <h3 class="header-title">专属账号运行状态</h3>
        <span class="header-tag">实时更新</span>
      </header>

      <div class="grid grid-cols-1 gap-4" :class="accountGridClass">
        <div
          v-for="account in boundAccountList"
          :key="account.id || account.key"
          class="account-card"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <span class="account-icon">
                <i aria-hidden="true" :class="PLATFORM_ICONS[account.key]" />
              </span>
              <div>
                <p class="account-name">{{ getAccountLabel(account) }}</p>
                <p class="account-sub">
                  {{ account.platform === 'claude' ? '会话窗口' : '额度窗口' }}
                </p>
              </div>
            </div>
            <div
              v-if="getRateLimitDisplay(account.rateLimitStatus)"
              :class="['rate-badge', getRateLimitDisplay(account.rateLimitStatus).class]"
            >
              <i class="i-lucide-gauge mr-1" />
              {{ getRateLimitDisplay(account.rateLimitStatus).text }}
            </div>
          </div>

          <div v-if="account.platform === 'claude'" class="mt-3 space-y-2">
            <div class="progress-row">
              <div class="progress-track">
                <div
                  class="progress-bar"
                  :class="
                    getSessionProgressBarClass(account.sessionWindow?.sessionWindowStatus, account)
                  "
                  :style="{
                    width: `${Math.min(100, Math.max(0, account.sessionWindow?.progress || 0))}%`
                  }"
                />
              </div>
              <span class="progress-value">
                {{ Math.min(100, Math.max(0, Math.round(account.sessionWindow?.progress || 0))) }}%
              </span>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
              <span>
                {{
                  formatSessionWindowRange(
                    account.sessionWindow?.windowStart,
                    account.sessionWindow?.windowEnd
                  )
                }}
              </span>
              <span
                v-if="account.sessionWindow?.remainingTime > 0"
                class="font-medium text-indigo-600 dark:text-indigo-400"
              >
                剩余 {{ formatSessionRemaining(account.sessionWindow.remainingTime) }}
              </span>
            </div>
          </div>

          <div v-else-if="account.platform === 'openai'" class="mt-3">
            <div v-if="account.codexUsage" class="space-y-2">
              <div
                v-for="type in ['primary', 'secondary']"
                :key="`${account.key}-${type}`"
                class="quota-row"
              >
                <div class="quota-header">
                  <span class="quota-tag" :class="type === 'primary' ? 'tag-indigo' : 'tag-blue'">
                    {{ getCodexWindowLabel(type) }}
                  </span>
                  <span class="quota-percent">
                    {{ formatCodexUsagePercent(account.codexUsage?.[type]) }}
                  </span>
                </div>
                <div class="progress-track">
                  <div
                    class="progress-bar"
                    :class="getCodexUsageBarClass(account.codexUsage?.[type])"
                    :style="{ width: getCodexUsageWidth(account.codexUsage?.[type]) }"
                  />
                </div>
                <div class="quota-foot">
                  重置剩余 {{ formatCodexRemaining(account.codexUsage?.[type]) }}
                </div>
              </div>
            </div>
            <p
              v-else
              class="rounded-xl bg-gray-100 px-3 py-2 text-sm text-gray-500 dark:bg-gray-800 dark:text-gray-300"
            >
              暂无额度使用数据
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useApiStatsStore } from '@/stores/api_stats'
import { copyText, formatNumber, formatDate } from '@/libs/tools'
import { formatLocalDateTime } from '@/libs/time'
import { PLATFORM_ICONS } from '@/libs/platform_icons'

defineProps({
  showTimelineButton: {
    type: Boolean,
    default: false
  },
  timelineDisabled: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['open-timeline'])

const apiStatsStore = useApiStatsStore()
const {
  statsData,
  statsPeriod,
  currentPeriodData,
  multiKeyMode,
  aggregatedStats,
  individualStats,
  invalidKeys
} = storeToRefs(apiStatsStore)

const topContributors = computed(() => {
  if (!individualStats.value || individualStats.value.length === 0) return []
  return [...individualStats.value]
    .sort((a, b) => (b.usage?.allTokens || 0) - (a.usage?.allTokens || 0))
    .slice(0, 3)
})

const periodText = computed(() => {
  if (statsPeriod.value === 'daily') return '今日'
  if (statsPeriod.value === 'monthly') return '本月'
  return '全部'
})

// 是否有自定义服务倍率
const hasServiceRates = computed(() => {
  return statsData.value?.serviceRates && Object.keys(statsData.value.serviceRates).length > 0
})

const calculateContribution = (stat) => {
  if (!aggregatedStats.value || !aggregatedStats.value.usage.allTokens) return 0
  const percentage = ((stat.usage?.allTokens || 0) / aggregatedStats.value.usage.allTokens) * 100
  return percentage.toFixed(1)
}

const formatExpireDate = (dateString) => {
  if (!dateString) return ''
  return formatLocalDateTime(dateString, 'YYYY-MM-DD HH:mm') || ''
}

const isApiKeyExpired = (expiresAt) => {
  if (!expiresAt) return false
  return new Date(expiresAt) < new Date()
}

const isApiKeyExpiringSoon = (expiresAt) => {
  if (!expiresAt) return false
  const expireDate = new Date(expiresAt)
  const now = new Date()
  const daysUntilExpire = (expireDate - now) / (1000 * 60 * 60 * 24)
  return daysUntilExpire > 0 && daysUntilExpire <= 7
}

const formatPermissions = (permissions) => {
  const map = {
    claude: 'Claude',
    openai: 'OpenAI',
    gemini: 'Gemini',
    codex: 'Codex',
    droid: 'Droid',
    grok: 'Grok',
    bedrock: 'Bedrock',
    azure: 'Azure',
    ccr: 'CCR'
  }
  // 空值 = 全部服务
  if (!permissions) return '全部服务'
  // 尝试解析字符串格式的数组
  let parsed = permissions
  if (typeof permissions === 'string') {
    if (permissions === 'all' || permissions === '[]') return '全部服务'
    try {
      parsed = JSON.parse(permissions)
    } catch {
      return map[permissions] || permissions
    }
  }
  // 空数组 = 全部服务
  if (Array.isArray(parsed) && parsed.length === 0) return '全部服务'
  // 数组格式
  if (Array.isArray(parsed)) {
    return parsed.map((p) => map[p] || p).join(', ')
  }
  return map[permissions] || permissions
}

const boundAccountList = computed(() => {
  const accounts = statsData.value?.accounts?.details
  if (!accounts) return []
  const result = []
  if (accounts.claude && accounts.claude.accountType === 'dedicated') {
    result.push({ key: 'claude', ...accounts.claude })
  }
  if (accounts.openai && accounts.openai.accountType === 'dedicated') {
    result.push({ key: 'openai', ...accounts.openai })
  }
  return result
})

const accountGridClass = computed(() => {
  const count = boundAccountList.value.length
  if (count <= 1) {
    return 'md:grid-cols-1 lg:grid-cols-1'
  }
  if (count === 2) {
    return 'md:grid-cols-2'
  }
  return 'md:grid-cols-2 xl:grid-cols-3'
})

const getAccountLabel = (account) => {
  if (!account) return '专属账号'
  return account.platform === 'openai' ? 'OpenAI 专属账号' : 'Claude 专属账号'
}

const formatRateLimitTime = (minutes) => {
  if (!minutes || minutes <= 0) return ''
  const total = Math.floor(minutes)
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const mins = total % 60
  if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`
  if (hours > 0) return mins > 0 ? `${hours}小时${mins}分钟` : `${hours}小时`
  return `${mins}分钟`
}

const getRateLimitDisplay = (status) => {
  if (!status) {
    return {
      text: '状态未知',
      class: 'text-gray-400'
    }
  }
  if (status.isRateLimited) {
    const remaining = formatRateLimitTime(status.minutesRemaining)
    const suffix = remaining ? ` · 剩余约 ${remaining}` : ''
    return {
      text: `限流中${suffix}`,
      class: 'text-red-500 dark:text-red-400'
    }
  }
  return {
    text: '未限流',
    class: 'text-green-600 dark:text-emerald-400'
  }
}

const formatSessionWindowRange = (start, end) => {
  if (!start || !end) return '暂无时间窗口信息'
  const s = new Date(start)
  const e = new Date(end)
  const fmt = (d) => `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`
  return `${fmt(s)} - ${fmt(e)}`
}

const formatSessionRemaining = (minutes) => {
  if (!minutes || minutes <= 0) return ''
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return hours > 0 ? `${hours}小时${mins}分钟` : `${mins}分钟`
}

const getSessionProgressBarClass = (status, account) => {
  if (!status) return 'bg-gradient-to-r from-blue-500 to-indigo-500'
  if (account?.rateLimitStatus?.isRateLimited) return 'bg-gradient-to-r from-red-500 to-red-600'
  const normalized = String(status).toLowerCase()
  if (normalized === 'rejected') return 'bg-gradient-to-r from-red-500 to-red-600'
  if (normalized === 'allowed_warning') return 'bg-gradient-to-r from-yellow-500 to-orange-500'
  return 'bg-gradient-to-r from-blue-500 to-indigo-500'
}

const normalizeCodexUsagePercent = (usageItem) => {
  if (!usageItem) return null
  const percent =
    typeof usageItem.usedPercent === 'number' && !Number.isNaN(usageItem.usedPercent)
      ? usageItem.usedPercent
      : null
  const resetAfterSeconds =
    typeof usageItem.resetAfterSeconds === 'number' && !Number.isNaN(usageItem.resetAfterSeconds)
      ? usageItem.resetAfterSeconds
      : null
  const remainingSeconds =
    typeof usageItem.remainingSeconds === 'number' ? usageItem.remainingSeconds : null
  const resetAtMs = usageItem.resetAt ? Date.parse(usageItem.resetAt) : null
  const resetElapsed =
    resetAfterSeconds !== null &&
    ((remainingSeconds !== null && remainingSeconds <= 0) ||
      (resetAtMs !== null && !Number.isNaN(resetAtMs) && Date.now() >= resetAtMs))
  if (resetElapsed) return 0
  if (percent === null) return null
  return Math.max(0, Math.min(100, percent))
}

const getCodexUsageBarClass = (usageItem) => {
  const percent = normalizeCodexUsagePercent(usageItem)
  if (percent === null) return 'bg-gradient-to-r from-gray-300 to-gray-400'
  if (percent >= 90) return 'bg-gradient-to-r from-red-500 to-red-600'
  if (percent >= 75) return 'bg-gradient-to-r from-yellow-500 to-orange-500'
  return 'bg-gradient-to-r from-emerald-500 to-teal-500'
}

const getCodexUsageWidth = (usageItem) => {
  const percent = normalizeCodexUsagePercent(usageItem)
  if (percent === null) return '0%'
  return `${percent}%`
}

const formatCodexUsagePercent = (usageItem) => {
  const percent = normalizeCodexUsagePercent(usageItem)
  if (percent === null) return '--'
  return `${percent.toFixed(1)}%`
}

const formatCodexRemaining = (usageItem) => {
  if (!usageItem) return '--'
  let seconds = usageItem.remainingSeconds
  if (seconds === null || seconds === undefined) {
    seconds = usageItem.resetAfterSeconds
  }
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) {
    return '--'
  }
  seconds = Math.max(0, Math.floor(Number(seconds)))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`
  if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`
  if (minutes > 0) return `${minutes}分钟`
  return `${secs}秒`
}

const getCodexWindowLabel = (type) => (type === 'secondary' ? '周限' : '5h')
</script>

<style scoped>
.stats-overview {
  display: grid;
  gap: 10px;
}
.overview-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 13px 14px;
}
.overview-identity {
  min-width: 0;
}
.overview-name-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.overview-name-row h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.overview-key-name {
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
  text-align: left;
  max-width: 100%;
  overflow-wrap: anywhere;
  white-space: normal;
}
.overview-key-name:hover {
  color: var(--primary-color);
}
.overview-status {
  padding: 2px 7px;
  background: var(--success-soft);
  color: var(--success-color);
  border-radius: var(--radius-sm);
  font-size: 14px;
}
.overview-status.is-inactive,
.overview-expired {
  color: var(--error-color);
}
.overview-warning {
  color: var(--warning-color);
}
.overview-name-row .overview-timeline {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 30px;
  padding: 3px 8px;
  margin-left: auto;
}
.overview-facts {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 16px;
  margin: 9px 0 0;
  font-size: 14px;
}
.overview-facts > div {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.overview-facts dt {
  color: var(--text-secondary);
  flex-shrink: 0;
}
.overview-facts dd {
  color: var(--text-primary);
  margin: 0;
  overflow-wrap: anywhere;
}
.overview-contributors,
.overview-service-rates {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.overview-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(108px, 1fr));
  gap: 14px;
  margin: 0;
  padding-left: 18px;
  border-left: 1px solid var(--divider-color);
}
.overview-metrics dt {
  color: var(--text-secondary);
  font-size: 14px;
}
.overview-metrics dd {
  margin: 4px 0 0;
  font-size: 22px;
  line-height: 1.35;
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.overview-metrics .overview-cost {
  color: var(--primary-color);
  font-size: 20px;
}
@media (max-width: 1099px) {
  .overview-card {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  .overview-metrics {
    padding-left: 0;
    padding-top: 10px;
    border-left: 0;
    border-top: 1px solid var(--divider-color);
  }
}
@media (max-width: 479px) {
  .overview-metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .overview-metrics dd,
  .overview-metrics .overview-cost {
    font-size: 17px;
    overflow-wrap: anywhere;
  }
  .overview-facts {
    gap: 6px 12px;
  }
}

.card-section {
  @apply flex h-full flex-col gap-1.5 rounded-lg border border-gray-200 p-2 shadow-sm dark:border-gray-700 sm:p-2.5;
  background: var(--surface-color);
}

.section-header {
  @apply mb-1 flex flex-wrap items-center gap-1.5;
}

.header-icon {
  @apply text-sm;
}

.header-title {
  @apply text-sm font-semibold;
  color: var(--text-primary, #1e293b);
}

:global(.dark) .header-title {
  color: var(--text-primary, #f1f5f9);
}

.header-tag {
  @apply ml-auto rounded-full px-1.5 py-0.5 text-sm font-medium;
  background: rgba(var(--primary-rgb), 0.1);
  color: var(--primary-color);
}

.info-grid {
  @apply grid gap-1.5;
  grid-template-columns: repeat(1, minmax(0, 1fr));
}

@media (min-width: 768px) {
  .info-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 1280px) {
  .info-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.info-item {
  @apply rounded-md border border-gray-200 px-2 py-1.5 dark:border-gray-700;
  background: rgba(var(--primary-rgb), 0.03);
  min-height: 0;
}

:global(.dark) .info-item {
  background: rgba(var(--primary-rgb), 0.08);
}

.info-label {
  @apply text-sm leading-tight;
  color: var(--text-secondary, #64748b);
}

:global(.dark) .info-label {
  color: var(--text-secondary, #94a3b8);
}

.info-value {
  @apply mt-0.5 text-sm leading-snug;
  color: var(--text-primary, #1e293b);
}

:global(.dark) .info-value {
  color: var(--text-primary, #f1f5f9);
}

.contributor-item {
  @apply flex items-center justify-between rounded-md px-2 py-1 text-sm;
  background: rgba(var(--primary-rgb), 0.05);
  color: var(--text-secondary, #64748b);
}

:global(.dark) .contributor-item {
  background: rgba(var(--primary-rgb), 0.1);
  color: var(--text-secondary, #cbd5e1);
}

.metric-grid {
  @apply grid grid-cols-2 gap-1.5 sm:grid-cols-4;
}

.metric-card {
  @apply rounded-md border border-gray-200 px-2 py-1.5 text-center dark:border-gray-700;
  background: rgba(var(--primary-rgb), 0.03);
}

:global(.dark) .metric-card {
  background: rgba(var(--primary-rgb), 0.08);
}

.metric-value {
  @apply text-sm font-semibold leading-tight sm:text-base;
}

.metric-label {
  @apply mt-0.5 text-sm leading-tight;
  color: var(--text-secondary, #64748b);
}

:global(.dark) .metric-label {
  color: var(--text-secondary, #cbd5e1);
}

.account-card {
  @apply rounded-lg border border-gray-200 p-2 shadow-sm transition-shadow hover:shadow-md dark:border-gray-700;
  background: var(--surface-color);
}

.account-icon {
  @apply inline-flex h-6 w-6 shrink-0 items-center justify-center;
  color: var(--text-primary);
  font-size: 20px;
}

.account-name {
  @apply text-sm font-semibold;
  color: var(--text-primary, #1e293b);
}

:global(.dark) .account-name {
  color: var(--text-primary, #f1f5f9);
}

.account-sub {
  @apply text-sm;
  color: var(--text-secondary, #64748b);
}

:global(.dark) .account-sub {
  color: var(--text-secondary, #94a3b8);
}

.rate-badge {
  @apply rounded-full px-2 py-0.5 text-sm font-medium;
  background: rgba(var(--primary-rgb), 0.1);
}

.progress-row {
  @apply flex items-center gap-2;
}

.progress-track {
  @apply h-1.5 flex-1 rounded-full;
  background: rgba(var(--primary-rgb), 0.15);
}

:global(.dark) .progress-track {
  background: rgba(var(--primary-rgb), 0.25);
}

.progress-bar {
  @apply h-1.5 rounded-full transition-all duration-300;
}

.progress-value {
  @apply text-sm font-semibold;
  color: var(--text-secondary, #475569);
}

:global(.dark) .progress-value {
  color: var(--text-secondary, #e2e8f0);
}

.quota-row {
  @apply rounded-md border border-gray-200 p-2 dark:border-gray-700;
  background: rgba(var(--primary-rgb), 0.03);
}

:global(.dark) .quota-row {
  background: rgba(var(--primary-rgb), 0.08);
}

.quota-header {
  @apply mb-2 flex items-center justify-between;
}

.quota-tag {
  @apply inline-flex min-w-[34px] justify-center rounded-full px-2 py-0.5 text-sm font-semibold;
}

.tag-indigo {
  @apply bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-200;
}

.tag-blue {
  @apply bg-sky-100 text-sky-600 dark:bg-sky-500/20 dark:text-sky-200;
}

.quota-percent {
  @apply text-sm font-semibold;
  color: var(--text-secondary, #475569);
}

:global(.dark) .quota-percent {
  color: var(--text-secondary, #e2e8f0);
}

.quota-foot {
  @apply mt-1 text-sm;
  color: var(--text-tertiary, #94a3b8);
}

:global(.dark) .quota-foot {
  color: var(--text-tertiary, #cbd5e1);
}
</style>
