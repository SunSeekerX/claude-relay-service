# Claude Relay Service 管理后台 SPA

Claude Relay Service 管理后台的 Vue 3 SPA。

## 环境要求

- Node.js >= 20.19（Vite 8 要求；推荐 Node 24）
- pnpm（本目录唯一包管理器；不要再用 npm/yarn 装依赖）

## 安装和运行

```bash
cd web/admin-spa
pnpm install
pnpm dev
```

开发服务器默认：

- 端口：`3001`
- base path：开发默认 `/admin/`（可用 `VITE_APP_BASE_URL` 覆盖）
- API 代理：`/webapi` → `VITE_API_TARGET`（默认 `http://localhost:3000`）

生产构建：

```bash
pnpm build
pnpm preview
```

也可在仓库根目录：

```bash
pnpm --dir web/admin-spa install   # 或 npm run install:web（根脚本已转调 pnpm）
pnpm --dir web/admin-spa build     # 或 npm run build:web
```

## 技术栈

| 类别 | 选型 |
| --- | --- |
| 框架 | Vue 3.5 + Vue Router 5 + Pinia 4 |
| 构建 | Vite 8 + `@vitejs/plugin-vue` 6 |
| 原子 CSS | UnoCSS（`presetUno` + `presetIcons` + directives/variant-group） |
| 图标 | Lucide / Logos / Simple Icons（离线 `@iconify-json/*`） |
| 图表 | Chart.js 4 |
| 时间 | dayjs |
| Excel | xlsx-js-style |
| 工程化 | ESLint 10 flat + Prettier 3（格式与 lint 分离） |

## 关键配置文件

- `vite.config.js` — 开发代理、分包、AutoImport/Components、UnoCSS 插件
- `uno.config.js` — 原子类主题、图标集合、safelist（动态 class）
- `eslint.config.js` — flat config
- `.prettierrc` — 与后端一致的基础格式（无 class 排序插件）

## 图标约定

- UI 图标：`class="i-lucide-xxx"`
- 品牌图标：`class="i-logos-xxx"` / `class="i-si-xxx"`
- OpenAI 自定义 SVG：`class="icon-openai"`（见 `src/assets/styles/components.css`）
- 加载中：`class="i-lucide-loader-circle animate-spin"`
- 传给下拉/侧栏的 `icon` prop 直接传完整 class 字符串，组件不再拼接 `fas`

## 开发注意

1. HTTP 走 `src/utils/http.js`（fetch 内核），不要再引 axios
2. 状态管理用 Pinia stores
3. common 组件由 `unplugin-vue-components` 自动注册
4. 暗黑模式必须同时验证；主题色覆盖在 `src/assets/styles/global.css`
5. 动态拼出来的 Uno 图标 class 若静态扫描不到，补进 `uno.config.js` 的 `safelist`

## 代理

创建 `.env.development.local`（不入库）：

```bash
VITE_API_TARGET=http://localhost:3000
VITE_HTTP_PROXY=http://127.0.0.1:7890
```

## 常见问题

### 访问根路径 404

开发 base 是 `/admin/`（或你配置的 `VITE_APP_BASE_URL`），请访问完整路径。

### 登录 API 失败

1. 确认主服务已在 `VITE_API_TARGET` 运行
2. 开发请求应走 `/webapi/...` 代理
3. 改代理配置后重启 `pnpm dev`
