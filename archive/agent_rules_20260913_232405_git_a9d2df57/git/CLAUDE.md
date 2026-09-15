# Claude Relay Service 项目规则

- 本文件定义本仓的通用工程规范、项目技术约束、迁移规则和人工决策。

## 通用工程规范

- 默认中文回复，禁止 emoji。源码默认 ASCII + 汉字；i18n、用户文案和协议字面量除外，不得为字符集规则改变语义。
- 复用已有封装；Handler 保持薄壳，业务规则放 service 或纯函数，依赖单向。仅在职责或复用有收益时抽象。
- 错误记录完整对象和业务上下文；边界校验用户输入、上游响应和 Redis 数据；网络调用有超时并走统一封装。
- 共享状态考虑并发、幂等、超时和重建；Redis 读改写使用原子命令、Lua 或 WATCH + MULTI/EXEC。增长型 I/O 批量且有界，禁止 KEYS。
- JS/TS 使用完整命名、const、小写下划线文件名、单行必要注释；禁止内部 || 默认值和 as any 绕过。环境变量只在配置模块读取。
- 前端文字不小于 14px；可选值应可点选。未经用户明确授权，不安装依赖、编译、构建、类型检查或运行测试；Git 仅允许只读查询。

## 对外管理 API

- 管理 JSON API（/admin、/users、/web、/apiStats、/payment 非 webhook）统一响应 { code: number, msg: string, data? }：业务成功 code 为 2xx 且 HTTP 同值；业务失败仅 body.code 区分（鉴权 401/403、限流 429、未捕获 5xx 用真 HTTP）；字符串业务细分码只放 data.reason；中转协议面与支付 webhook 禁止套此信封；路由用 asyncRoute。

## 架构与安全

- 新增路由只做参数和响应，格式转换放 handler/转换服务，Redis 经统一入口访问；key、TTL 和容量只在 src/constants/redisKeys.js 定义。
- OAuth token、refreshToken 和 credentials AES 加密；API Key 仅存 SHA-256 哈希；请求必须完成认证、权限、客户端限制和模型黑名单检查；断连必须释放资源和并发计数；日志用 tokenMask.js 脱敏。
- 代码风格：无分号、单引号、100 字符行宽、尾逗号 none、箭头函数参数带括号、严格相等；UnoCSS 不配 prettier-plugin-tailwindcss。
- 前端为 Vue 3 + Pinia + UnoCSS；组件支持 dark:，主题经 useThemeStore()，图标用离线 Iconify class。

## 时间

- 绝对时间统一 UTC ISO；业务周期、日期筛选和周边界按系统时区，周从周一开始。
- datetime-local 初始化为本地时间，提交时统一转 UTC；禁止直接用 toISOString().slice(...) 回填。
- 时间范围传输契约只能是 UTC ISO 或明确约定的本地业务时间，展示复用 web/admin-spa/src/libs/time.js 或 tools.js。

## 迁移

- 单实例停机发布；新功能不引入双读双写。历史兼容统一在 src/compat/ 登记下线条件。
- src/app.js initialize() 的迁移和自愈调用顺序不可调整。
- src/migrations/registry.js 只登记幂等可重入且失败会抛错的 marker 迁移，up 不保证恰好一次；版本门控仍由 runVersionGated 管理。
- src/bootstrap/registry.js 只登记每次启动可重跑的自愈，调用点保留在 app.js；重或危险操作使用人工执行的 scripts/migrate-*.js。
- 运行态缓存和限流允许从空重建；旧字段在切换后自然过期或一次性清理。

## 账户调度

- disableAutoProtection=true 只跳过上游错误类自动暂停；isActive、schedulable、dailyQuota、模型、订阅和并发仍是硬门。dailyQuota 不得受该开关影响。
- _isAccountAvailable(accountId, accountType, requestedModel) 是每个调度器硬门的唯一权威；专属、分组和会话复检必须委托它。共享池可内联，但硬门必须逐项一致。
- 选号阶段统一处理 token：过期无 refreshToken 拒绝；可刷新则刷新，失败拒绝。新增账户类型或选号路径不得重抄判定。
- 状态字段只能由调度、限流和自动保护写入；外部账户更新经 commonHelper.stripReadonlyAccountFields 剥离状态字段，droid key 同理。
- 上游错误返回客户端前经 utils/clientErrorBuilder.js 归一化、按协议包装并脱敏。

## 本仓前端 UI

- 禁止因数据为空或未配置就隐藏 UI 控件。控件可显示为空状态或默认值，但不能让用户找不到配置入口。v-if 只用于协议或类型不适用的场景。
- Dialog 内有 tab 切换时，PC 端内容区加 min-height 防高度跳动，移动端不加。

## DEC 标记（人工决策）

- 仅用户实际确认的决策才在相关代码注释中标记，格式 DEC_yyyyMMdd_HHmmss 结论；一个英文空格后写一句结论，不写推理。时间戳使用当前北京时间并精确到秒。
- 修改带 DEC_ 的代码前核对决策是否仍有效；没有新的用户决策不得改结论，既有授权已明确覆盖时不重复询问。
