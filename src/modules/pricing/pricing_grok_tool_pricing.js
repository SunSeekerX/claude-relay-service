// 官方工具计费量与单价：https://docs.x.ai/developers/pricing（2026-10-13）。
export const GROK_TOOL_PRICING_MODEL = 'grok-server-tools'

export const GROK_TOOL_UNIT_PRICES = {
  web_search_calls: 0.005,
  x_posts_fetched: 0.005,
  x_users_fetched: 0.01,
  code_interpreter_calls: 0.005,
  file_search_calls: 0.0025,
  document_search_calls: 0.01,
}

export const GROK_TOOL_FALLBACK_PRICING = {
  [GROK_TOOL_PRICING_MODEL]: {
    mode: 'server_tools',
    xai_tool_costs_per_unit: GROK_TOOL_UNIT_PRICES,
  },
}

export const calculateGrokToolCost = (usage, pricing) => {
  const source = usage?.server_side_tool_usage_details ?? {}
  const counts = {}
  const breakdown = {}
  let total = 0
  for (const [unit, price] of Object.entries(pricing)) {
    const count = Number(source[unit] ?? 0)
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Invalid Grok tool usage: ${unit}`)
    }
    if (count === 0) {
      continue
    }
    counts[unit] = count
    breakdown[unit] = count * price
    total += breakdown[unit]
  }
  return { counts, breakdown, total }
}

export const getGrokUpstreamCost = (usage) => {
  const raw = usage?.cost_in_usd_ticks
  if (raw === undefined || raw === null) {
    return null
  }
  const ticks = String(raw)
  if (!/^\d+$/.test(ticks)) {
    throw new Error('Invalid Grok cost_in_usd_ticks')
  }
  const amount = Number(ticks) / 10000000000
  if (!Number.isFinite(amount)) {
    throw new Error('Invalid Grok upstream cost')
  }
  return { ticks, amount }
}
