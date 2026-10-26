<template>
  <div class="tab-content" :class="{ 'is-embedded': embedded }">
    <div class="glass-strong rounded-2xl p-3 shadow-xl sm:rounded-2xl sm:p-4">
      <div v-if="!apiKey" class="recharge-key-required">
        <i class="i-lucide-key" />
        <p>充值需要完整的 API Key，分享链接只用于查询统计。</p>
        <router-link class="btn btn-primary" :to="{ name: 'ApiStatsQuery', query: route.query }"
          >返回查询输入 API Key</router-link
        >
      </div>
      <RechargePanel
        v-else
        :key="apiKey"
        :api-id="apiId ?? ''"
        :api-key="apiKey"
        :api-key-name="statsData?.name || ''"
        @busy-change="forwardBusy"
        @completed="loadStatsWithApiId"
      />
    </div>
  </div>
</template>

<script setup>
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useApiStatsStore } from '@/stores/api_stats'
import RechargePanel from '@/components/recharge/recharge_panel.vue'

defineProps({ embedded: { type: Boolean, default: false } })
const emit = defineEmits(['busy-change'])
const forwardBusy = (busy) => emit('busy-change', busy)
const route = useRoute()
const apiStatsStore = useApiStatsStore()
const { apiKey, apiId, statsData } = storeToRefs(apiStatsStore)
const { loadStatsWithApiId } = apiStatsStore
</script>

<style scoped>
.is-embedded.tab-content {
  animation: none;
}
.is-embedded > .glass-strong {
  padding: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
  backdrop-filter: none;
}
.recharge-key-required {
  display: grid;
  justify-items: center;
  gap: 12px;
  padding: 24px 8px;
  font-size: 14px;
  text-align: center;
  color: var(--text-secondary);
}

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
