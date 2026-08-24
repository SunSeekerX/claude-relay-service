// 定价源字段的本地修正层。
//
// [人工决策-2026-08-24 11:33:43] 现行定价源（Wei-Shaw/model-price-repo 精选集，226 个模型）
// 给 gpt-5.6 系列变体写了 max_input_tokens=400000，而 LiteLLM 官方对同批模型是 922000、
// 基础型 gpt-5.6 两源均为 1050000。经确认按 1050000 修正，与 Codex manifest 的
// context_window 保持同一口径（src/constants/codex_client_models.json）。
//
// 边界（代码强制，不是约定）：这里只能修正「非计费展示字段」。max_input_tokens 后端零引用，
// 唯一消费者是管理端定价表的「上下文窗口」列。计费相关字段（名字含 cost/price/multiplier/tier
// 或 provider_specific_entry）一律禁止覆盖——定价源始终是价格的唯一权威源，在这里改价会让
// 「实收金额」与「定价表展示」一起错、无从对账发现。
// 违规字段会让 pricingService._assertPricingOverridesSafe 抛错、拒绝启动（fail-fast）。
//
// 下线条件：定价源自身把这批 max_input_tokens 修正到正确值后，删除对应条目。
// 每次条目生效/失效都会打日志（见 pricingService._applyPricingOverrides），
// 便于发现「源已修正、覆盖变冗余」。
const LONG_CONTEXT_GPT56 = 1050000

module.exports = {
  'gpt-5.6-terra': { max_input_tokens: LONG_CONTEXT_GPT56 },
  'gpt-5.6-sol': { max_input_tokens: LONG_CONTEXT_GPT56 },
  'gpt-5.6-luna': { max_input_tokens: LONG_CONTEXT_GPT56 }
}
