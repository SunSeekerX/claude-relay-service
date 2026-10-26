<template>
  <section aria-label="服务费用统计" class="service-cost-panel card">
    <header class="service-cost-heading">
      <h3><i class="i-lucide-coins" />服务费用</h3>
      <span>{{ periodLabel }} · 原始费用与实际扣费</span>
    </header>
    <div v-if="serviceStats.length" class="service-cost-list">
      <article v-for="service in serviceStats" :key="service.name" class="service-cost-row">
        <div class="service-name">
          <strong>{{ service.label }}</strong
          ><span>{{ formatNumber(service.requests) }} 次请求</span>
        </div>
        <dl class="service-token-pairs">
          <div>
            <dt>输入 / 输出</dt>
            <dd>
              {{ formatNumber(service.inputTokens) }} / {{ formatNumber(service.outputTokens) }}
            </dd>
          </div>
          <div>
            <dt>缓存写 / 读</dt>
            <dd>
              {{ formatNumber(service.cacheCreateTokens) }} /
              {{ formatNumber(service.cacheReadTokens) }}
            </dd>
          </div>
        </dl>
        <dl class="service-fees">
          <div>
            <dt class="usage-original">原始费用</dt>
            <dd class="usage-original">{{ service.officialCost }}</dd>
          </div>
          <div>
            <dt>实际扣费</dt>
            <dd class="service-charged usage-charge">{{ service.ccCost }}</dd>
          </div>
        </dl>
        <div class="service-rate">
          <span>全局 {{ service.globalRate }}x</span><span>Key {{ service.keyRate }}x</span>
        </div>
        <details class="service-price">
          <summary>参考单价</summary>
          <dl v-if="service.pricing">
            <div>
              <dt>输入</dt>
              <dd>{{ service.pricing.input }}/M</dd>
            </div>
            <div>
              <dt>输出</dt>
              <dd>{{ service.pricing.output }}/M</dd>
            </div>
            <div>
              <dt>缓存写入</dt>
              <dd>{{ service.pricing.cacheCreate || '$0.00' }}/M</dd>
            </div>
            <div>
              <dt>缓存读取</dt>
              <dd>{{ service.pricing.cacheRead || '$0.00' }}/M</dd>
            </div>
          </dl>
          <p v-else>暂无参考单价</p>
        </details>
      </article>
    </div>
    <p v-else class="service-cost-empty">暂无{{ periodLabel }}服务费用统计</p>
  </section>
</template>

<script setup>
import { formatNumber } from '@/libs/tools'
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useApiStatsStore } from '@/stores/api_stats'

const apiStatsStore = useApiStatsStore()
const { modelStats, serviceRates, keyServiceRates, multiKeyMode, statsPeriod } =
  storeToRefs(apiStatsStore)

const periodLabel = computed(
  () => ({ daily: '今日', monthly: '本月', alltime: '全部' })[statsPeriod.value]
)

// 服务标签映射
const serviceLabels = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  droid: 'Droid',
  bedrock: 'Bedrock',
  azure: 'Azure',
  ccr: 'CCR'
}

// 根据模型名称判断服务类型
const getServiceFromModel = (model) => {
  if (!model) return 'claude'
  const m = model.toLowerCase()
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku'))
    return 'claude'
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'codex'
  if (m.includes('gemini')) return 'gemini'
  if (m.includes('droid') || m.includes('factory')) return 'droid'
  if (m.includes('bedrock') || m.includes('amazon')) return 'bedrock'
  if (m.includes('azure')) return 'azure'
  return 'claude'
}

// 按服务聚合统计
const serviceStats = computed(() => {
  if (!serviceRates.value?.rates || !modelStats.value?.length) return []

  const stats = {}

  // 初始化所有服务
  Object.keys(serviceRates.value.rates).forEach((service) => {
    stats[service] = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      realCost: 0,
      ratedCost: 0,
      pricing: null
    }
  })

  // 聚合模型数据 - 按模型逐个计算计费费用
  modelStats.value.forEach((model) => {
    const service = getServiceFromModel(model.model)
    if (stats[service]) {
      stats[service].requests += model.requests || 0
      stats[service].inputTokens += model.inputTokens || 0
      stats[service].outputTokens += model.outputTokens || 0
      stats[service].cacheCreateTokens += model.cacheCreateTokens || 0
      stats[service].cacheReadTokens += model.cacheReadTokens || 0
      // 累加官方费用
      const modelRealCost = model.costs?.real ?? model.costs?.total ?? 0
      stats[service].realCost += modelRealCost
      // 按模型判断：有存储费用用存储的，否则用当前倍率计算
      const globalRate = serviceRates.value.rates[service] || 1.0
      const keyRate = multiKeyMode.value ? 1.0 : (keyServiceRates.value?.[service] ?? 1.0)
      const modelRatedCost =
        !model.isLegacy && model.costs?.rated !== undefined
          ? model.costs.rated
          : modelRealCost * globalRate * keyRate
      stats[service].ratedCost += modelRatedCost
      if (!stats[service].pricing && model.pricing) {
        stats[service].pricing = model.pricing
      }
    }
  })

  // 转换为数组
  return Object.entries(stats)
    .filter(
      ([, data]) =>
        data.requests > 0 ||
        data.inputTokens > 0 ||
        data.outputTokens > 0 ||
        data.cacheCreateTokens > 0 ||
        data.realCost > 0
    )
    .map(([service, data]) => {
      const globalRate = serviceRates.value.rates[service] || 1.0
      const keyRate = multiKeyMode.value ? 1.0 : (keyServiceRates.value?.[service] ?? 1.0)
      const p = data.pricing
      return {
        name: service,
        label: serviceLabels[service] || service,
        globalRate: globalRate,
        keyRate: keyRate,
        requests: data.requests,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        cacheCreateTokens: data.cacheCreateTokens,
        cacheReadTokens: data.cacheReadTokens,
        officialCost: formatCost(data.realCost),
        ccCost: formatCost(data.ratedCost),
        pricing: p
          ? {
              input: formatCost(p.input),
              output: formatCost(p.output),
              cacheCreate: p.cacheCreate ? formatCost(p.cacheCreate) : null,
              cacheRead: p.cacheRead ? formatCost(p.cacheRead) : null
            }
          : null
      }
    })
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
})

// 格式化费用
const formatCost = (cost) => {
  if (!cost || cost === 0) return '$0.00'
  if (cost >= 1) return '$' + cost.toFixed(2)
  if (cost >= 0.01) return '$' + cost.toFixed(4)
  return '$' + cost.toFixed(6)
}

// 格式化数字
</script>
<style scoped>
.service-cost-panel {
  padding: 11px 13px;
}
.service-cost-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 7px;
}
.service-cost-heading h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.service-cost-heading > span,
.service-cost-empty {
  font-size: 14px;
  color: var(--text-secondary);
}
.service-cost-row {
  display: grid;
  grid-template-columns: minmax(90px, 0.7fr) minmax(240px, 1.8fr) minmax(230px, 1.5fr) auto auto;
  align-items: start;
  gap: 12px;
  padding: 9px 0;
  border-top: 1px solid var(--divider-color);
  font-size: 14px;
}
.service-name {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.service-name > span,
.service-rate {
  color: var(--text-secondary);
}
.service-token-pairs,
.service-fees {
  display: grid;
  gap: 5px;
  margin: 0;
}
.service-token-pairs > div,
.service-fees > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.service-cost-row dt {
  color: var(--text-secondary);
}
.service-cost-row dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.service-charged {
  color: var(--primary-color);
  font-weight: 600;
}
.service-rate {
  display: grid;
  gap: 5px;
  padding-inline: 12px;
  border-left: 1px solid var(--divider-color);
}
.service-price summary {
  color: var(--primary-color);
  cursor: pointer;
  white-space: nowrap;
}
.service-price dl {
  display: grid;
  gap: 5px;
  margin: 8px 0 0;
  min-width: 145px;
}
.service-price dl > div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.service-cost-empty {
  margin: 0;
  padding: 10px 0;
}
@media (max-width: 1099px) {
  .service-cost-row {
    grid-template-columns: minmax(90px, 1fr) minmax(170px, 2fr);
  }
  .service-fees {
    grid-column: 2;
  }
  .service-rate {
    grid-column: 1;
    grid-row: 2;
    padding-inline: 0;
    border: 0;
  }
  .service-price {
    grid-column: 1 / -1;
  }
}
@media (max-width: 479px) {
  .service-cost-row {
    grid-template-columns: minmax(70px, 1fr) minmax(0, 2fr);
    gap: 9px;
  }
  .service-token-pairs > div,
  .service-fees > div {
    flex-wrap: wrap;
    gap: 4px;
  }
}
</style>
