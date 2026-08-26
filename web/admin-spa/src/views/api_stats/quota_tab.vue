<template>
  <div class="tab-content">
    <div class="glass-strong rounded-2xl p-3 shadow-xl sm:rounded-2xl sm:p-4">
      <div class="mb-3 flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
        <router-link
          :class="[
            'inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium no-underline transition-colors',
            quotaSubTab === 'redeem'
              ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-700 dark:text-blue-300'
              : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
          ]"
          :to="{ name: 'ApiStatsQuota', query: route.query }"
        >
          <i class="i-lucide-ticket text-sm" />
          兑换额度卡
        </router-link>
        <router-link
          :class="[
            'inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium no-underline transition-colors',
            quotaSubTab === 'history'
              ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-700 dark:text-blue-300'
              : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
          ]"
          :to="{ name: 'ApiStatsQuotaHistory', query: route.query }"
        >
          <i class="i-lucide-scroll-text text-sm" />
          兑换记录
        </router-link>
      </div>

      <div v-if="quotaSubTab === 'redeem'">
        <div v-if="!apiId" class="py-5 text-center">
          <div class="mb-4 text-gray-500 dark:text-gray-400">
            <i class="i-lucide-key mb-2 block text-3xl opacity-50" />
            <p>请先在「统计查询」页面输入您的 API Key</p>
          </div>
          <router-link
            class="inline-flex items-center justify-center whitespace-nowrap rounded-lg bg-gradient-to-r from-blue-500 to-cyan-500 px-4 py-2 text-sm font-medium text-white no-underline transition-all hover:from-blue-600 hover:to-cyan-600"
            :to="{ name: 'ApiStatsQuery', query: route.query }"
          >
            前往输入 API Key
          </router-link>
        </div>

        <div v-else>
          <div class="mb-3 rounded-xl bg-blue-50 p-3 dark:bg-blue-900/20">
            <p class="text-sm text-blue-700 dark:text-blue-300">
              <i class="i-lucide-info mr-2" />
              当前 API Key: <span class="font-medium">{{ statsData?.name || apiId }}</span>
            </p>
          </div>

          <div class="space-y-3">
            <div>
              <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                额度卡卡号
              </label>
              <input
                v-model="redeemCode"
                class="form-input w-full"
                placeholder="请输入额度卡卡号"
                type="text"
                @keyup.enter="handleRedeem"
              />
            </div>

            <button
              class="w-full whitespace-nowrap rounded-xl bg-gradient-to-r from-green-500 to-emerald-500 px-4 py-2.5 text-sm font-medium text-white transition-all hover:from-green-600 hover:to-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!redeemCode.trim() || redeemLoading"
              @click="handleRedeem"
            >
              <i v-if="redeemLoading" class="i-lucide-loader-circle animate-spin mr-2" />
              <i v-else class="i-lucide-circle-check mr-2" />
              {{ redeemLoading ? '兑换中...' : '立即兑换' }}
            </button>
          </div>

          <div v-if="redeemResult" class="mt-3">
            <div
              :class="[
                'rounded-xl p-4',
                redeemResult.success
                  ? redeemResult.hasWarnings
                    ? 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-300'
                    : 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300'
                  : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
              ]"
            >
              <div class="flex items-start gap-3">
                <i
                  :class="[
                    'mt-0.5 text-lg',
                    redeemResult.success
                      ? redeemResult.hasWarnings
                        ? 'i-lucide-triangle-alert'
                        : 'i-lucide-circle-check'
                      : 'i-lucide-circle-x'
                  ]"
                />
                <div>
                  <p class="font-medium">
                    {{
                      redeemResult.success
                        ? redeemResult.hasWarnings
                          ? '兑换成功（部分截断）'
                          : '兑换成功'
                        : '兑换失败'
                    }}
                  </p>
                  <p class="mt-1 text-sm opacity-90">{{ redeemResult.message }}</p>
                  <div v-if="redeemResult.success && redeemResult.data" class="mt-2 text-sm">
                    <p v-if="redeemResult.data.quotaAdded">
                      额度增加:
                      <span class="font-medium">${{ redeemResult.data.quotaAdded }}</span>
                    </p>
                    <p v-if="redeemResult.data.timeAdded">
                      有效期延长:
                      <span class="font-medium"
                        >{{ redeemResult.data.timeAdded
                        }}{{
                          redeemResult.data.timeUnit === 'days'
                            ? '天'
                            : redeemResult.data.timeUnit === 'hours'
                              ? '小时'
                              : '月'
                        }}</span
                      >
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else>
        <div v-if="!apiId" class="py-5 text-center">
          <div class="mb-4 text-gray-500 dark:text-gray-400">
            <i class="i-lucide-key mb-2 block text-3xl opacity-50" />
            <p>请先在「统计查询」页面输入您的 API Key</p>
          </div>
          <router-link
            class="inline-flex items-center justify-center whitespace-nowrap rounded-lg bg-gradient-to-r from-blue-500 to-cyan-500 px-4 py-2 text-sm font-medium text-white no-underline transition-all hover:from-blue-600 hover:to-cyan-600"
            :to="{ name: 'ApiStatsQuery', query: route.query }"
          >
            前往输入 API Key
          </router-link>
        </div>

        <div v-else>
          <div v-if="historyLoading" class="py-5 text-center">
            <i class="i-lucide-loader-circle animate-spin text-xl text-gray-400" />
            <p class="mt-2 text-gray-500 dark:text-gray-400">加载中...</p>
          </div>

          <div v-else-if="redemptionHistory.length === 0" class="py-5 text-center">
            <i class="i-lucide-inbox text-4xl text-gray-300 dark:text-gray-600" />
            <p class="mt-2 text-gray-500 dark:text-gray-400">暂无兑换记录</p>
          </div>

          <div v-else class="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
            <div
              v-for="record in redemptionHistory"
              :key="record.id"
              class="bg-white px-3 py-2 dark:bg-gray-800/80"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="mb-0.5 flex flex-wrap items-center gap-1.5">
                    <span
                      :class="[
                        'inline-flex items-center rounded-full px-2 py-0.5 text-sm font-medium',
                        record.cardType === 'quota'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                          : record.cardType === 'time'
                            ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                            : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                      ]"
                    >
                      {{
                        record.cardType === 'quota'
                          ? '额度卡'
                          : record.cardType === 'time'
                            ? '时间卡'
                            : '组合卡'
                      }}
                    </span>
                    <span
                      v-if="record.status === 'revoked'"
                      class="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-sm font-medium text-red-700 dark:bg-red-900/30 dark:text-red-300"
                    >
                      已撤销
                    </span>
                  </div>
                  <p class="flex flex-wrap items-baseline gap-x-2 text-sm leading-tight text-gray-600 dark:text-gray-300">
                    <span v-if="Number(record.quotaAdded) > 0" class="font-medium text-emerald-600 dark:text-emerald-400"
                      >额度 +${{ record.quotaAdded }}</span
                    >
                    <span v-if="Number(record.timeAdded) > 0" class="font-medium text-purple-600 dark:text-purple-400"
                      >有效期 +{{ record.timeAdded
                      }}{{
                        record.timeUnit === 'days'
                          ? '天'
                          : record.timeUnit === 'hours'
                            ? '小时'
                            : '月'
                      }}</span
                    >
                    <span
                      v-if="!Number(record.quotaAdded) && !Number(record.timeAdded)"
                      class="text-gray-400"
                      >无额度/时长变更</span
                    >
                    <span
                      v-if="record.cardCode"
                      class="truncate font-mono text-gray-400 dark:text-gray-500"
                      >{{ record.cardCode }}</span
                    >
                  </p>
                </div>
                <div class="shrink-0 whitespace-nowrap text-right text-sm tabular-nums text-gray-500 dark:text-gray-400">
                  {{ formatDateTime(record.timestamp || record.redeemedAt) }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useApiStatsStore } from '@/stores/api_stats'
import { redeemCardByApiIdApi, getRedemptionHistoryByApiIdApi } from '@/libs/http_apis'
import { formatDateTime, showToast } from '@/libs/tools'

const route = useRoute()
const apiStatsStore = useApiStatsStore()
const { apiId, statsData } = storeToRefs(apiStatsStore)
const { loadStatsWithApiId } = apiStatsStore

const redeemCode = ref('')
const redeemLoading = ref(false)
const redeemResult = ref(null)
const redemptionHistory = ref([])
const historyLoading = ref(false)

const quotaSubTab = computed(() => route.meta.quotaSubTab || 'redeem')

const handleRedeem = async () => {
  if (!redeemCode.value.trim() || !apiId.value) return

  redeemLoading.value = true
  redeemResult.value = null

  const res = await redeemCardByApiIdApi({
    apiId: apiId.value,
    code: redeemCode.value.trim()
  })

  redeemLoading.value = false

  if (res.success) {
    const warnings = res.data?.warnings || []
    const hasWarnings = warnings.length > 0
    redeemResult.value = {
      success: true,
      message: hasWarnings ? warnings.join('；') : '额度卡兑换成功！',
      data: res.data,
      hasWarnings
    }
    redeemCode.value = ''
    showToast(
      hasWarnings ? '兑换成功（部分截断）' : '兑换成功',
      hasWarnings ? 'warning' : 'success'
    )
    loadStatsWithApiId()
  } else {
    redeemResult.value = {
      success: false,
      message: res.error || res.message || '兑换失败'
    }
    showToast(res.error || res.message || '兑换失败', 'error')
  }
}

const loadRedemptionHistory = async () => {
  if (!apiId.value) return

  historyLoading.value = true
  const res = await getRedemptionHistoryByApiIdApi(apiId.value)
  historyLoading.value = false

  if (res.success) {
    // 后端 getRedemptions 返回 { redemptions, total, limit, offset }
    const payload = res.data
    redemptionHistory.value = Array.isArray(payload)
      ? payload
      : payload?.redemptions || payload?.records || []
  } else {
    redemptionHistory.value = []
    showToast(res.message || res.error || '加载兑换记录失败', 'error')
  }
}

watch(
  () => [quotaSubTab.value, apiId.value],
  ([subTab]) => {
    if (subTab === 'history') {
      loadRedemptionHistory()
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.tab-content {
  animation: tabFadeIn 0.4s ease-out;
}

@keyframes tabFadeIn {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.glass-strong {
  background: var(--glass-strong-color);
  backdrop-filter: blur(25px);
  border: 1px solid var(--border-color);
  box-shadow:
    0 25px 50px -12px rgba(0, 0, 0, 0.25),
    0 0 0 1px rgba(255, 255, 255, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  position: relative;
  z-index: 1;
}

:global(.dark) .glass-strong {
  box-shadow:
    0 25px 50px -12px rgba(0, 0, 0, 0.7),
    0 0 0 1px rgba(55, 65, 81, 0.3),
    inset 0 1px 0 rgba(75, 85, 99, 0.2);
}
</style>
