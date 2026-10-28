# Claude Relay Service 项目规则

## 浏览器自动化与文件权限偏好 (2026-10-27)

- 截图和 UI 验证复用统一托管入口, 不临时裸启 Chrome/Edge 后只靠 child.kill() 收尾。沿用 Windows Node/pnpm 和现有依赖, 不为截图另装运行时或浏览器。
- Windows 侧用 Job Object 托管本任务进程树并设置总超时, 覆盖正常结束、异常、超时及宿主被强杀。脚本仍在 finally 中有界关闭 CDP/Browser.close, 不只依赖 WSL timeout 或退出回调。
- 每次使用独立 profile 和随机调试端口, 记录任务、PID、日志位置; 结束后核验本任务进程已退出。真实浏览器和其他任务实例不在回收范围, 不以全机 chrome.exe 清零作为验收条件。
- 自动回收仅限本任务明确拥有的进程树; 历史或归属不明进程先只读列出证据, 获得对应授权后再处理。禁止按进程名批量强杀或仅凭年龄结束其他任务, 默认不注册全局定时清理。
- 文件权限只处理本次实际修改的精确路径。禁止对仓库根、Windows 挂载盘、node_modules 或依赖缓存执行 chmod -R/chown -R; 目录变量须非空且核验真实路径, 切目录失败立即停止, 不退回当前目录继续操作。
- profile、截图及日志放目标项目已忽略的 .agent_tmp/日期_任务名/, 附用途和验证结果; 未获清理授权不删除历史产物。此偏好只约束开发验证, 不改变产品浏览器、登录或常驻实例的生命周期。
- 本机统一入口为 D:/code/ssx/llysc/server_data/dev_tools/browser/run.mjs, 用 Windows Node 执行, --cwd 指定目标项目, -- 后传脚本和参数; 使用说明见同目录 README.md。其他机器按实际仓库位置定位。

## Node.js 与 pnpm 偏好 (2026-10-27)

- 自有 JavaScript/TypeScript 项目统一使用 Node.js LTS 运行、pnpm 管理依赖。开发、测试、构建、CI 和部署均不依赖 Bun/bunx，不新增 Bun 专用入口、安装步骤或回退分支；存量入口在相关任务授权范围内迁移。
- 本地沿用 Windows Node/pnpm、已有项目目录与缓存；锁文件由 pnpm 维护，不混用 Bun/npm 安装依赖。生产切换运行时、部署、重启和数据写入仍需该次操作的明确授权。
- Bun 问题记录: 2026-10-27 Windows 实测，1.3.14 重放新版 Cursor CLI 配方报 ERR_SSL_NO_CIPHER_MATCH；升级 1.4.4 后仍因不支持 X448、ffdhe2048、ffdhe3072 报 ERR_CRYPTO_OPERATION_FAILED。Node 24.22.1 的 Cursor CLI/IDE 参数重放均通过；本地重放不等于完整 TLS 指纹一致或真实上游验证。
- 不为绕过运行时限制删减官方采样的 cipher/curve/ALPN。第三方官方客户端内嵌的 Bun、原始协议字段、指纹样本与不可变历史资料保持原样，它们不属于本项目的宿主运行时依赖。


- 本文件与 AGENTS.md 是本仓两份规则入口；任务开始先读 AGENTS.md，再按当前任务读取本文相关章节。技术细则在本文按章节收口，不因通用 Skills 触发额外流程。
- 规则仅在用户明确要求时修改；本次授权不扩展为其他任务的文档维护权限。

## 通用工程规范

- 默认中文回复，禁止 emoji。源码默认 ASCII + 汉字；i18n、用户文案和协议字面量除外，不得为字符集规则改变语义。
- 复用已有封装；Handler 保持薄壳，业务规则放 service 或纯函数，依赖单向。仅在职责或复用有收益时抽象。
- 新增校验、重试、兜底、配置或抽象必须对应需求、既有调用契约或明确可达的失败路径；已由边界或统一封装保证的内部条件直接信任。
- 错误记录完整对象和业务上下文；边界校验用户输入、上游响应和 Redis 数据；网络调用有超时并走统一封装。
- 共享状态考虑并发、幂等、超时和重建；Redis 读改写使用原子命令、Lua 或 WATCH + MULTI/EXEC。增长型 I/O 批量且有界，禁止 KEYS。
- JS/TS 使用完整命名、const、小写下划线文件名、单行必要注释；函数定义统一使用 `const name = (...) => {}`，异步函数使用 `const name = async (...) => {}`，简单返回写成单行；禁止冗余的具名 function 表达式。仅当需要动态 this、arguments、构造器或生成器语义时保留 function。禁止内部 || 默认值和 as any 绕过。环境变量只在配置模块读取。
- 前端文字不小于 14px；可选值应可点选。Git 仅允许只读查询。
- 已授权任务所需的依赖安装、更新、移除，以及编译、构建、lint、类型检查和本地测试，可从 WSL 调用 Windows 工具直接执行，无需逐项确认；用户当次“只读、不要测试”等明确限制优先。沿用 package.json 固定的 Windows pnpm 与现有锁文件，恢复依赖优先 `pnpm install --frozen-lockfile`，不顺手升级无关依赖或替换包管理器。
- 从 WSL 经 `cmd.exe /d /c`、PowerShell 或 Windows 可执行文件发起，在对应 Windows 项目目录运行；首次使用或环境变化时核对实际程序、子进程与工作目录，Node 的 `process.platform` 应为 `win32`。禁止在 WSL 内另装 Linux 项目依赖/工具链，或用 Linux 工具重建、覆盖 Windows node_modules；工具不可调用时报告阻塞，不回退 Linux 安装或擅自重配全局环境。
- 执行前查看脚本实际行为；本地依赖与检查授权不包含数据库清理/迁移、真实支付或上游操作、生产写入、服务重启和发布部署。获授权的隔离镜像构建可安装声明依赖，不回写宿主依赖目录。

## 对外管理 API

- 管理 JSON API（/admin、/users、/web、/apiStats、/payment 非 webhook）统一响应 { code: number, msg: string, data? }：业务成功 code 为 2xx 且 HTTP 同值；业务失败仅 body.code 区分（鉴权 401/403、限流 429、未捕获 5xx 用真 HTTP）；字符串业务细分码只放 data.reason；中转协议面与支付 webhook 禁止套此信封；路由用 asyncRoute。

## 架构与安全

- 新增路由只做参数和响应，格式转换放 handler/转换服务，Redis 经统一入口访问；key、TTL 和容量只在 src/infra/redis_key.js 定义。
- OAuth token、refreshToken 和 credentials AES 加密；API Key 仅存 SHA-256 哈希；请求必须完成认证、权限、客户端限制和模型黑名单检查；断连必须释放资源和并发计数；日志用 src/common/token_mask.js 脱敏。
- 代码风格：无分号、单引号、100 字符行宽、尾逗号 none、箭头函数参数带括号、严格相等；UnoCSS 不配 prettier-plugin-tailwindcss。
- 前端为 Vue 3 + Pinia + UnoCSS；组件支持 dark:，主题经 useThemeStore()，图标用离线 Iconify class。

## 时间

- 绝对时间统一 UTC ISO；业务周期、日期筛选和周边界按系统时区，周从周一开始。
- datetime-local 初始化为本地时间，提交时统一转 UTC；禁止直接用 toISOString().slice(...) 回填。
- 时间范围传输契约只能是 UTC ISO 或明确约定的本地业务时间，展示复用 web/admin-spa/src/libs/time.js 或 tools.js。

## 迁移

- 单实例停机发布；新功能不引入双读双写。历史兼容统一在 src/common/compat_index.js 登记下线条件。
- src/app.js initialize() 的迁移和自愈调用顺序不可调整。
- src/infra/migration_registry.js 只登记幂等可重入且失败会抛错的 marker 迁移，up 不保证恰好一次；版本门控仍由 runVersionGated 管理。
- src/infra/bootstrap_registry.js 只登记每次启动可重跑的自愈，调用点保留在 app.js；重或危险操作使用人工执行的 scripts/migrate-*.js。
- 运行态缓存和限流允许从空重建；旧字段在切换后自然过期或一次性清理。

## 账户调度

- disableAutoProtection=true 只跳过上游错误类自动暂停；isActive、schedulable、dailyQuota、模型、订阅和并发仍是硬门。dailyQuota 不得受该开关影响。
- _isAccountAvailable(accountId, accountType, requestedModel) 是每个调度器硬门的唯一权威；专属、分组和会话复检必须委托它。共享池可内联，但硬门必须逐项一致。
- 选号阶段统一处理 token：过期无 refreshToken 拒绝；可刷新则刷新，失败拒绝。新增账户类型或选号路径不得重抄判定。
- 状态字段只能由调度、限流和自动保护写入；外部账户更新经 src/common/common_helper.js 的 stripReadonlyAccountFields 剥离状态字段，droid key 同理。
- 上游错误返回客户端前经 src/common/client_error_builder.js 归一化、按协议包装并脱敏。

## 本仓前端 UI

- 禁止因数据为空或未配置就隐藏 UI 控件。控件可显示为空状态或默认值，但不能让用户找不到配置入口。v-if 只用于协议或类型不适用的场景。
- Dialog 内有 tab 切换时，PC 端内容区加 min-height 防高度跳动，移动端不加。
- 表格操作列统一排序：编辑固定第一项，详情/时间线/测试等非破坏操作随后，禁用/删除等破坏性操作最后；桌面端与移动端保持相同顺序。

## DEC 标记（人工决策）

- 仅用户实际确认的决策才在相关代码注释中标记，格式 DEC_yyyyMMdd_HHmmss 结论；一个英文空格后写一句结论，不写推理。时间戳使用当前北京时间并精确到秒。
- 修改带 DEC_ 的代码前核对决策是否仍有效；没有新的用户决策不得改结论，既有授权已明确覆盖时不重复询问。

## 业务域归属与命名

- 业务域拥有自身实体、状态、业务规则和写入入口。表、代码目录、接口、菜单、权限、配置项及 Redis key 应体现同一真实归属；跨域调用走所属模块的公开契约，不直接接管另一业务的数据写入。
- 持久化对象沿用本项目现有命名规范，并包含可辨认的业务域；采用 biz_ 前缀的项目使用 biz_<业务域>_<实体>。系统、监控及其他已有独立分类保留各自约定，不把所有表机械归到同一前缀。外部标准参数与路径保持官方契约。
- 只有与具体业务无关且存在真实跨域消费者的能力才放共用层；共用能力使用独立命名空间，消费者通过接口传入业务上下文。多处调用不能成为搬走业务实体或流程的理由，也不因此新增独立进程或服务。
- 名称调整须核对实体映射、查询、迁移或初始化入口及直接相关端；存量结构按本项目既有发布与迁移制度处理。规则同步不自动触发历史表重命名、迁移执行或生产变更。

## 构建、脚本输出与插件发布偏好 (2026-10-27)

- 构建优先用当前开发操作系统的原生工具链,包括本机交叉编译;能本机完成就不默认套 Docker/WSL。区分宿主与产物目标,本机确实不满足目标要求时再说明原因并使用隔离环境,仍遵守项目工具链和授权边界。
- 脚本输出以人类可读性和操作便利性为先:显示插件、版本、宿主/目标、步骤、耗时、产物和日志位置及下一步操作。默认不倾倒内部 JSON、容器 ID 或冗长构建日志;详细内容落盘,需要时提供详细输出选项。
- 失败时清楚说明失败阶段、关键原因和可执行的处理办法,完整错误与堆栈保留到日志。不要把无关历史产物混入本次成功摘要,也不要把编译成功说成已部署或已通过目标环境运行验收。
- 同一插件的命令连续分组,统一为 <域>:<插件>:<操作>,例如 sidecar:count:version:major、sidecar:count:build:rust。没有 package.json 的项目沿用自身命令入口,不为统一形式新增包管理器。
- 有插件独立发布需求时,插件版本分开维护,同一插件不同实现可共用版本。采用 x.y.z,默认只增加 x 并把 y/z 归零;构建不隐式升版,也不连带修改应用或其他插件版本。
- 发布名和产物名用 _ 连接插件前缀、实现、版本及必要的平台/架构,例如 claude_count_rust_1.0.0_linux_amd64。操作顺序为先插件升版、再编译、后上传、最后手动选择目标发布;上传不自动部署。
- 这些偏好用于当前涉及的构建、脚本输出和插件发布功能,不因此改写无关版本体系或既有部署流程;运行验证仍遵守项目目标平台及隔离要求,生产变更须另获明确授权。
