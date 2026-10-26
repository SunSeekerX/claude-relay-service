<template>
  <section :aria-busy="modelStatsLoading" aria-label="模型使用统计" class="model-stats-panel card">
    <header class="model-stats-toolbar">
      <div class="model-stats-heading">
        <h3><i class="i-lucide-bot" />模型使用统计</h3>
        <span>{{ stats.length }} / {{ modelStats.length }} 个模型</span>
      </div>
      <div class="model-stats-controls">
        <div class="model-search">
          <label class="sr-only" for="model-stats-keyword">筛选模型</label
          ><input
            id="model-stats-keyword"
            v-model="keyword"
            class="form-input"
            placeholder="筛选模型名称"
            type="search"
            @keydown.esc.stop="clearKeyword"
          />
        </div>
        <SegmentedTabs
          aria-label="模型统计时间范围"
          :disabled="modelStatsLoading"
          :model-value="statsPeriod"
          size="sm"
          :tabs="periodOptions"
          @update:model-value="switchPeriod"
        />
      </div>
    </header>
    <p class="model-stats-note">
      Token 数悬停可查看完整值；点击模型名称复制。合计以总 Token 为准。
    </p>
    <div v-if="modelStatsLoading" aria-live="polite" class="model-stats-empty">
      <i class="i-lucide-loader-circle animate-spin" />正在加载{{ periodLabel }}模型统计...
    </div>
    <template v-else-if="stats.length">
      <div class="model-table-scroll">
        <table class="model-stats-table">
          <caption class="sr-only">
            {{
              periodLabel
            }}模型使用统计
          </caption>
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th class="text-right" scope="col">请求</th>
              <th class="text-right" scope="col">总 Token</th>
              <th class="text-right usage-input" scope="col">输入</th>
              <th class="text-right usage-output" scope="col">输出</th>
              <th
                class="text-right usage-thinking"
                scope="col"
                title="部分模型的思考已包含在输出中，合计请以总 Token 为准"
              >
                思考
              </th>
              <th class="text-right usage-cache" scope="col">缓存写入</th>
              <th class="text-right usage-cache" scope="col">缓存读取</th>
              <th class="text-right usage-hit" scope="col">命中率</th>
              <th class="text-right usage-original" scope="col">原始费用</th>
              <th class="text-right usage-charge" scope="col">实际扣费</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="model in stats" :key="model.model">
              <th scope="row">
                <button
                  :aria-label="`复制模型 ${model.model}`"
                  class="model-copy"
                  :title="model.model"
                  type="button"
                  @click="copyModelName(model.model)"
                >
                  {{ model.model }}
                </button>
              </th>
              <td class="text-right" :title="exactNumber(model.requests)">
                {{ formatNumber(model.requests) }}
              </td>
              <td class="text-right model-total" :title="exactNumber(model.allTokens)">
                {{ formatNumber(model.allTokens) }}
              </td>
              <td class="usage-input text-right" :title="exactNumber(model.inputTokens)">
                {{ formatNumber(model.inputTokens) }}
              </td>
              <td class="usage-output text-right" :title="exactNumber(model.outputTokens)">
                {{ formatNumber(model.outputTokens) }}
              </td>
              <td class="usage-thinking text-right" :title="exactNumber(thinkingTokensOf(model))">
                {{ formatNumber(thinkingTokensOf(model)) }}
              </td>
              <td class="usage-cache text-right" :title="exactNumber(model.cacheCreateTokens)">
                {{ formatNumber(model.cacheCreateTokens ?? 0) }}
              </td>
              <td class="usage-cache text-right" :title="exactNumber(model.cacheReadTokens)">
                {{ formatNumber(model.cacheReadTokens ?? 0) }}
              </td>
              <td class="usage-hit text-right" :title="`缓存读取 /（输入 + 缓存读取 + 缓存写入）`">
                {{ formatHitRate(model) }}
              </td>
              <td
                class="usage-original text-right"
                :title="`$${Number(model.costs?.total ?? 0).toFixed(6)}`"
              >
                {{ model.formatted?.total || formatCostValue(model.costs?.total) }}
              </td>
              <td
                class="usage-charge text-right model-charge"
                :title="
                  model.costs?.rated !== undefined
                    ? `$${Number(model.costs.rated).toFixed(6)}`
                    : calculateCcCost(model)
                "
              >
                {{ calculateCcCost(model) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="model-mobile-list">
        <article v-for="model in stats" :key="model.model" class="model-mobile-row">
          <header>
            <button
              :aria-label="`复制模型 ${model.model}`"
              class="model-copy"
              :title="model.model"
              type="button"
              @click="copyModelName(model.model)"
            >
              {{ model.model }}</button
            ><span>{{ formatNumber(model.requests) }} 次</span>
          </header>
          <dl>
            <div>
              <dt>总 Token</dt>
              <dd :title="exactNumber(model.allTokens)">{{ formatNumber(model.allTokens) }}</dd>
            </div>
            <div>
              <dt class="usage-charge">实际扣费</dt>
              <dd class="model-charge usage-charge">{{ calculateCcCost(model) }}</dd>
            </div>
            <div>
              <dt>
                <span class="usage-input">输入</span> / <span class="usage-output">输出</span>
              </dt>
              <dd>
                <span class="usage-input">{{ formatNumber(model.inputTokens) }}</span> /
                <span class="usage-output">{{ formatNumber(model.outputTokens) }}</span>
              </dd>
            </div>
            <div>
              <dt class="usage-thinking">思考</dt>
              <dd class="usage-thinking">{{ formatNumber(thinkingTokensOf(model)) }}</dd>
            </div>
            <div>
              <dt class="usage-cache">缓存写 / 读</dt>
              <dd class="usage-cache">
                {{ formatNumber(model.cacheCreateTokens ?? 0) }} /
                {{ formatNumber(model.cacheReadTokens ?? 0) }}
              </dd>
            </div>
            <div>
              <dt class="usage-hit">命中率</dt>
              <dd class="usage-hit">{{ formatHitRate(model) }}</dd>
            </div>
            <div>
              <dt class="usage-original">原始费用</dt>
              <dd class="usage-original">
                {{ model.formatted?.total || formatCostValue(model.costs?.total) }}
              </dd>
            </div>
          </dl>
        </article>
      </div>
    </template>
    <div v-else aria-live="polite" class="model-stats-empty">
      {{ keyword.trim() ? '没有匹配的模型，试试其他关键词' : `暂无${periodLabel}模型使用数据` }}
    </div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import SegmentedTabs from '@/components/common/segmented_tabs.vue'
import { storeToRefs } from 'pinia'
import { useApiStatsStore } from '@/stores/api_stats'
import { copyText, formatNumber } from '@/libs/tools'

const apiStatsStore = useApiStatsStore()
const { modelStats, modelStatsLoading, statsPeriod, serviceRates, keyServiceRates, multiKeyMode } =
  storeToRefs(apiStatsStore)
const { switchPeriod } = apiStatsStore
const keyword = ref('')
const periodOptions = [
  { key: 'daily', label: '今日' },
  { key: 'monthly', label: '本月' },
  { key: 'alltime', label: '全部' }
]
const stats = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  return query
    ? modelStats.value.filter((model) => model.model.toLowerCase().includes(query))
    : modelStats.value
})
const periodLabel = computed(
  () => periodOptions.find((option) => option.key === statsPeriod.value).label
)
const exactNumber = (value) => Number(value ?? 0).toLocaleString('zh-CN')
const clearKeyword = () => {
  keyword.value = ''
}

const copyModelName = (name) => copyText(name, '模型名称已复制')

const thinkingTokensOf = (model) =>
  Number(model.thinkingTokens || model.reasoningTokens || model.reasoning_tokens || 0) || 0

// 命中率：缓存读 / (输入 + 缓存读 + 缓存写)
const formatHitRate = (model) => {
  const inputTokens = Number(model.inputTokens) || 0
  const cacheReadTokens = Number(model.cacheReadTokens) || 0
  const cacheCreateTokens = Number(model.cacheCreateTokens) || 0
  const denominator = inputTokens + cacheReadTokens + cacheCreateTokens
  if (denominator <= 0) return '0%'
  const rate = (cacheReadTokens / denominator) * 100
  if (rate >= 10) return `${rate.toFixed(1)}%`
  if (rate > 0) return `${rate.toFixed(2)}%`
  return '0%'
}

const formatCostValue = (cost) => {
  const value = Number(cost) || 0
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(6)}`
}

const getServiceFromModel = (model) => {
  if (!model) return 'claude'
  const lowerName = model.toLowerCase()
  if (
    lowerName.includes('claude') ||
    lowerName.includes('sonnet') ||
    lowerName.includes('opus') ||
    lowerName.includes('haiku')
  ) {
    return 'claude'
  }
  if (
    lowerName.includes('gpt') ||
    lowerName.includes('o1') ||
    lowerName.includes('o3') ||
    lowerName.includes('o4')
  ) {
    return 'codex'
  }
  if (lowerName.includes('gemini')) return 'gemini'
  if (lowerName.includes('droid') || lowerName.includes('factory')) return 'droid'
  if (lowerName.includes('bedrock') || lowerName.includes('amazon')) return 'bedrock'
  if (lowerName.includes('azure')) return 'azure'
  return 'claude'
}

const calculateCcCost = (model) => {
  // 已结算桶：直接用存储的 rated（已含全局×Key）
  if (!model.isLegacy && model.costs?.rated !== undefined) {
    return formatCostValue(model.costs.rated)
  }
  // 历史/未结算：官方费用 × 全局服务倍率 × Key 倍率（对齐 service_cost_cards）
  const cost = model.costs?.real ?? model.costs?.total ?? 0
  if (!cost || !serviceRates.value?.rates) return '$0.00'
  const service = getServiceFromModel(model.model)
  const globalRate = serviceRates.value.rates[service] || 1.0
  const keyRate = multiKeyMode.value ? 1.0 : (keyServiceRates.value?.[service] ?? 1.0)
  return formatCostValue(cost * globalRate * keyRate)
}
</script>

<style scoped>
.model-stats-panel {
  min-width: 0;
  padding: 12px;
}
.model-stats-toolbar,
.model-stats-heading,
.model-stats-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.model-stats-toolbar {
  justify-content: space-between;
}
.model-stats-heading h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.model-stats-heading > span,
.model-stats-note {
  color: var(--text-secondary);
  font-size: 14px;
}
.model-stats-note {
  margin: 7px 0 10px;
}
.model-search input {
  width: 190px;
}
.model-table-scroll {
  overflow-x: auto;
}
.model-stats-table {
  width: 100%;
  min-width: 1010px;
  border-collapse: collapse;
  font-size: 14px;
  table-layout: fixed;
}
.model-stats-table :is(th, td) {
  padding: 8px 7px;
  text-align: right;
  white-space: nowrap;
  font-size: 14px;
  border-bottom: 1px solid var(--divider-color);
  font-variant-numeric: tabular-nums;
}
.model-stats-table :is(th, td):first-child {
  width: 22%;
  text-align: left;
}
.model-stats-table thead th {
  background: var(--table-head-bg);
  color: var(--text-secondary);
  font-weight: 500;
}
.model-stats-table tbody th {
  background: transparent;
  color: var(--text-primary);
  font-weight: 500;
}
.model-stats-table tbody tr:hover {
  background: var(--table-hover);
}
.model-copy {
  display: block;
  max-width: 100%;
  text-align: left;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}
.model-copy:hover {
  color: var(--primary-color);
}
.model-total {
  font-weight: 600;
}
.model-charge {
  color: var(--usage-charge, var(--success-color));
  font-weight: 600;
}
.model-mobile-list {
  display: none;
}
.model-stats-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 28px 12px;
  font-size: 14px;
  color: var(--text-secondary);
}
@media (max-width: 1099px) {
  .model-table-scroll {
    display: none;
  }
  .model-mobile-list {
    display: block;
  }
  .model-mobile-row {
    padding: 10px 0;
    border-top: 1px solid var(--divider-color);
  }
  .model-mobile-row header {
    display: flex;
    align-items: center;
    gap: 12px;
    justify-content: space-between;
  }
  .model-mobile-row header > span {
    flex-shrink: 0;
    font-size: 14px;
    color: var(--text-secondary);
  }
  .model-mobile-row dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 7px 14px;
    margin: 10px 0 0;
  }
  .model-mobile-row dl > div {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    font-size: 14px;
  }
  .model-mobile-row dt {
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .model-mobile-row dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
  }
}
@media (max-width: 639px) {
  .model-stats-controls {
    width: 100%;
  }
  .model-search,
  .model-search input {
    width: 100%;
  }
  .model-mobile-row dl {
    grid-template-columns: 1fr;
  }
}
</style>
