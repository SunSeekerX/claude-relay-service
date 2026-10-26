import { CostCalculator } from './pricing_cost_calculator.js'
import { getOpenAICacheWriteDetails } from '../../common/openai_cache_write.js'

// 单次查询内复用缺失费用的重算；已落账的金额和明细始终优先。
export const createUsageRecordCostResolver = () => {
  const calculated = new WeakMap()
  return (record, usage, serviceTier, withDetails = false) => {
    const compute = () => {
      if (!calculated.has(record)) {
        const lifetimes = getOpenAICacheWriteDetails({
          cache_write_tokens_details: [record.cacheWrite12hTokens, record.cacheWrite30mTokens].some(
            (value) => value !== undefined && value !== null,
          )
            ? {
                ttl_30m_tokens: record.cacheWrite30mTokens ?? 0,
                ttl_12h_tokens: record.cacheWrite12hTokens ?? 0,
              }
            : null,
        })
        calculated.set(
          record,
          CostCalculator.calculateCost(
            { ...usage, ...(lifetimes ? { cache_write_tokens_details: lifetimes } : {}) },
            record.model || 'unknown',
            serviceTier,
          ),
        )
      }
      return calculated.get(record)
    }
    const cost = typeof record.cost === 'number' ? record.cost : (compute()?.costs?.total ?? 0)
    if (!withDetails) {
      return { cost }
    }
    const realCost = typeof record.realCost === 'number' ? record.realCost : (compute()?.costs?.total ?? 0)
    let breakdown = record.costBreakdown ?? record.realCostBreakdown
    if (!breakdown) {
      const costs = compute()?.costs
      breakdown = {
        input: costs?.input ?? 0,
        output: costs?.output ?? 0,
        cacheCreate: costs?.cacheWrite ?? 0,
        cacheRead: costs?.cacheRead ?? 0,
        total: costs?.total ?? cost,
      }
    }
    return {
      cost,
      realCost,
      costBreakdown: breakdown,
      realCostBreakdown: record.realCostBreakdown ?? breakdown,
    }
  }
}
