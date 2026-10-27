# 2026-10-26 转发审计后续

本轮实现缓存写入分桶与 TTL 计费一致性、账户测试错误上下文、Responses 输入计数接口、指标快照。生产配置、数据和运行实例不由这些本地改动自动更改；历史账目不回写。

## 输入计数

支持 `POST /v1/responses/input_tokens`、`/responses/input_tokens`、`/openai/v1/responses/input_tokens` 和命名入口的对应路径。结果使用官方 `object: response.input_tokens` 与 `input_tokens` 字段。

OpenAI Responses API Key 账户优先代理上游原生计数接口。404/405/501 且不是 `model_not_found` 时使用本地词表估算；其他鉴权、模型错误和服务错误保持失败，不通过估算掩盖。Codex OAuth 没有已核实的原生计数能力，因此返回可见文本估算。请求仍须认证、符合模型/入口权限和客户端限制，计数不进入生成扣费、token 用量或分组费用预扣。

估算结果明确包含 `_crs_estimate: true`、`_crs_estimate_method`、`_crs_precision`、`_crs_scope: visible-text`、`_crs_missing`，并设置 `X-Token-Count-Estimated: true`。`previous_response_id`、`conversation`、远程提示模板、文件、图片、音视频和加密历史不能由本地还原；上游不支持计数时，这些输入返回 422，不下载远程文件、不把 base64 长度当作模型 token。

本地词表依赖沿用管理后台的启用/停用及应用状态；词表不可用时沿用现有字符估算，并保持估算标识。可见文本估算不能用于宣称精确上下文长度。

MCP、file_search、tool_search 等依赖远程工具或检索上下文时，同样不能降级为本地估算。

## 缓存写入

普通输入、缓存读取、缓存写入互不重叠。OpenAI 的 `cache_write_tokens_details.ttl_30m_tokens`、`ttl_12h_tokens` 使用独立字段，不占用 Anthropic 的 `ephemeral_5m_input_tokens`、`ephemeral_1h_input_tokens`。

明细记录、请求详情、日/月/小时/模型/账户统计分别保存 `cacheWrite30mTokens`、`cacheWrite12hTokens`；费用总额只计算一次。12h 使用当前模型、档位和长上下文对应的 `cache_creation_input_token_cost_above_12hr` 字段，缺少时按生效普通输入价的 2.5 倍处理，显式零价保持零。已落账费用继续优先于按当前价表重算。

缺少 30m 写入价时，带 TTL 分桶的 OpenAI 用量按生效输入价的 1.25 倍处理。档位与长上下文同时生效时，优先完整组合价；没有组合价但两维专门价格均已配置时沿用既有比率计算。缺少任一维度的写入价时按当前生效输入价推导，不把基础档写入价当成溢价档的明确单价。未带 TTL 分桶的历史用量沿用原先回退规则。

原生输入计数接受 `input: null`，并交由支持该接口的上游处理。上游不支持时，`input: [{id: "服务端item ID"}]`（包括省略 `type` 或 `type: null`）与显式 `item_reference` 一样返回 422；带 `id` 且包含本地消息正文的完整 message 不受此限制。

## 指标

`/metrics` 的精确 key 数在同进程共享 15 秒快照，并合并并发刷新；一次刷新只遍历一轮 Redis keyspace。结果保留原有数量字段并增加 `collectedAt`、`cacheAgeMs`。进程内存、uptime 仍按请求读取。快照不是实时计费或配额依据。

## 生产资源及扫描流量建议（本轮不执行）

us_1 现场存在持续换页和多个数据库/应用竞争工作集。建议先按现有主机容量安排：

1. 优先将主机内存提升到至少 4 GiB；按 MySQL、ClickHouse、Bun/Node、各 Redis 的常驻数据与峰值继续核算，4 GiB 不是所有负载均可承载的保证。
2. 若暂不扩容，先确认哪些共驻服务可以迁走或减少常驻工作集，再逐项制定内存预算。不要直接给生产 Redis 开启逐出策略来节省内存：其中存有账目、认证、配额和索引。不要直接清 swap、清库或停服务。
3. 将扫描类 404、禁用 key 的探测与业务转发失败分开统计。Nginx/Cloudflare 的限制应针对已确认扫描路径和异常来源，不对所有生成 POST 设置统一的小突发阈值，避免影响多用户并发和长 SSE。
4. 配置 IP 限流前先核对 CDN 与反向代理的可信来源及真实客户端 IP；不能把所有用户视为一个 CDN 节点，也不能信任任意客户端填写的 X-Forwarded-For。
5. 变更后验证 OOM、swap-in/out、memory PSI、Redis P99、请求首字时延和真实流量；Docker RSS 低不代表数据未被换出。费用与可用性不应仅以 HTTP 200 评估。

2026-10-26 19:39 只读复核：三个实例仍 healthy，当前容器无 OOM、无自动重启。us_1 swap 仍约 1,781 MiB，但短采样 memory PSI full avg10 已降到约 0.02%，未观察到先前的连续大量 swap-out。已用 swap 不能单独证明此刻仍在严重换页；上述建议应结合持续采样再安排执行。

## 本地验证

Windows Node/pnpm：七个定向测试文件共 39 项通过，另有 Responses 用量与终态的 4 项定向回归通过；定向 ESLint、前端 Vite 构建和完整应用模块图加载通过。模块图检查使用隔离日志目录，没有启动应用或连接数据库。测试包含原生计数响应、命名入口分发、显式估算、鉴权/模型错误不降级、远程输入不估算、两类记账入口、历史金额优先、缓存分桶/倍率/零价、Redis 聚合及快照并发刷新。前端检查包含 30m/12h 明细与 CSV 的构建结果。

四项边界修复后的补充验证：同七个定向测试文件共 58 项通过，定向 ESLint 与两个变更实现文件的 Node 语法检查通过。新增用例覆盖 30m 缺价、12h 缺少档位/上下文组合价、明确零价和明确组合价、ultrafast 后缀回退、未分桶旧用量，以及 `input: null`、省略类型的远程 item 引用、包含正文的带 ID 消息。用量记录中的账务证据断言同步为当前已确认的保留契约，不删除实现中的证据字段。

没有通过真实生产生成请求验证本次代码，也没有对历史金额补扣或退款。

参考：[OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[OpenAI Counting tokens](https://developers.openai.com/api/docs/guides/token-counting)。
