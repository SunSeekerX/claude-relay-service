# 2026-11-11 转发协议更新

现有账户保留原来的接入模式。新增模式在账户编辑面板选择，保存后用于后续请求。

## Azure OpenAI

- 接口模式：`deployment` 为原来的部署式接口；`v1` 使用资源地址下的 `/openai/v1`，不附带 dated `api-version`。
- 资源地址填写根地址，支持 `https://资源.openai.azure.com` 和 `https://资源.services.ai.azure.com`。部署名称仍填写 Azure 中的真实部署名称。
- 鉴权选择 API Key 或 Microsoft Entra Access Token；两者均加密保存。Entra 模式接收已签发的 Access Token，可填写 UTC ISO 到期时间，到期后需要更新。本轮未新增 Entra 应用注册或自动获取令牌流程。
- 客户端 HTTP Base URL 可用 `/azure` 或 `/azure/v1`，提供 `models`、`chat/completions`、`responses`、`embeddings`。
- 原生 Responses WebSocket：`/azure/responses` 或 `/azure/v1/responses`。上游使用 v1，一条连接同时只接受一个生成回合，不支持 `stream_id` 多路复用及 steering。
- Azure 入口要求 API Key 具有 OpenAI 权限，所有选号路径使用同一组账户硬门。

官方契约：[Azure v1](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)、[Azure Responses WebSocket](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/websockets)。

## Bedrock Mantle

- 账户接口模式选择 `mantle`；原有 `invoke` 模式继续使用 AWS InvokeModel 和 EventStream。
- Mantle 使用区域端点 `https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages`，请求体与 SSE 采用 Messages 协议。
- 模型 ID 使用 `anthropic.` 前缀，例如 `anthropic.claude-fable-5-2`。编辑账户时同步选择目标模式支持的模型。
- AWS 访问密钥和临时 Session Token 使用 `bedrock-mantle` 服务的 SigV4 签名；Bearer Token 使用 `x-api-key`。令牌有效期和 IAM 权限仍由 AWS 管理。
- 后台配置检查、预置模型列表和测试按钮均识别所选模式；测试按钮发送实际推理请求，配置检查本身不证明上游可用。

官方契约：[Claude in Amazon Bedrock](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock)。

## Grok 语音识别

| 传输 | 本服务入口 | 上游入口 | 计费模型标识 |
| --- | --- | --- | --- |
| HTTP POST | `/grok/stt`、`/grok/v1/stt` | `/v1/stt` | `grok-stt` |
| WebSocket | `/grok/stt`、`/grok/v1/stt` | `/v1/stt` | `grok-stt-streaming` |

- 要求 Grok 权限和 Grok API Key 账户；如配置了支持模型范围，需包含对应计费模型标识。OAuth 账户不会用于此接口。
- HTTP 保留 multipart 音频；WebSocket 保留二进制音频帧、重复查询参数和 transcript 事件。
- 发送完音频后按上游协议发送 `audio.done`，以 `transcript.done` 判断完整结束。
- 按用户选定口径，仅使用上游有效时长或用量计费；缺少计量时保存未计量明细，不从音频字节估算收费。
- 2026-11-11 官方标准时长价为 REST $0.10/小时、流式 $0.20/小时，作为已有定价源未收录时的兜底。内部完整定价配置仍优先。

官方契约：[STT reference](https://docs.x.ai/developers/rest-api-reference/inference/speech-to-text)、[定价](https://docs.x.ai/developers/pricing)。

## Steering 与跨协议转换

- 按用户选择，HTTP→WS 桥接对 `response.steer` 继续返回明确错误，提示使用原生 WebSocket。桥接不会把取消、排队或重试包装成实时 steering。
- 原生 OpenAI WS 同时覆盖 `steered` 终态和原响应正常完成后的自动续接，保留实际档位、逐响应计费和并发租约。
- 跨协议转换把 Responses `configuration_update.reasoning.effort` 解析成目标请求的最终有效 effort。
- 可解析的内联音频传给支持音频的 Gemini 目标；Claude 音频输入以及跨提供商私有文件 ID 返回明确错误。
- 并行工具结果合并为完整用户轮次，结果块位于普通内容之前；真实缺失的结果仍保留恢复行为。

官方语义：[OpenAI steering](https://developers.openai.com/api/docs/guides/steering)。

## 新模型与计量

- 补充 Fable/Mythos 5.2、Haiku 5.5 的模型与 thinking 能力；Haiku 保留可关闭 thinking 的模式，支持的新模型移除不适用的采样参数。
- 新模型缺价时使用已核实的官方兜底，Haiku 5.5 按全部输入桶之和判断 100k 档位。
- Azure 和 Droid 的 OpenAI 输入总量拆成互不重叠的普通输入、缓存读和缓存写；Anthropic 的缓存继续作为独立附加桶。
- Claude 1h 缓存单价独立保存为 `cacheWrite1h`，与 OpenAI 12h 单价分开。
- 音频文本、字幕和原生 SSE 保留原始返回；Droid 使用增量 UTF-8/SSE 解析与协议终态判断。

官方价格：[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)。

本轮完成本地实现和隔离验证；未发布到生产，未改写历史账目，未执行真实提供商联调。CLI 伪装版本基线保留原有设置，未单独抬高版本号。
