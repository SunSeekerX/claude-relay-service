import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { join } from 'node:path'

// unplugin 默认 pascalCase 不拆下划线：custom_dropdown → Custom_dropdown
// 模板写 <CustomDropdown> 对不上。补 resolver：PascalCase → snake_case 文件
// from 必须用 @/ 别名（或正斜杠），Windows 绝对路径反斜杠会被当成 escape 吃掉
const commonComponentsDir = fileURLToPath(new URL('./src/components/common', import.meta.url))
const pascalToSnake = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
const snakeCaseCommonResolver = (componentName) => {
  if (!componentName) return
  const snake = pascalToSnake(componentName)
  if (!existsSync(join(commonComponentsDir, `${snake}.vue`))) return
  return { name: 'default', from: `@/components/common/${snake}.vue` }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:3000'
  const httpProxy = env.VITE_HTTP_PROXY || env.HTTP_PROXY || env.http_proxy
  const basePath = env.VITE_APP_BASE_URL || (mode === 'development' ? '/admin/' : '/admin-next/')

  const proxyConfig = {
    target: apiTarget,
    changeOrigin: true,
    secure: false
  }

  if (httpProxy && mode === 'development') {
    console.log(`Using HTTP proxy: ${httpProxy}`)
    process.env.HTTP_PROXY = httpProxy
    process.env.HTTPS_PROXY = httpProxy
  }

  console.log(
    `${mode === 'development' ? 'Starting dev server' : 'Building'} with base path: ${basePath}`
  )

  return {
    base: basePath,
    plugins: [
      // UnoCSS 放 vue 前，保证原子类与图标在 SFC 中可用
      UnoCSS(),
      vue(),
      // 这里【不挂 vite-plugin-checker】：lint 不参与构建。
      // 挂上它等于让格式问题阻断发布流水线的前端构建。
      // lint 手动跑：pnpm lint / pnpm format。
      AutoImport({
        imports: ['vue', 'vue-router', 'pinia'],
        dts: 'auto-imports.d.ts',
        eslintrc: {
          enabled: true,
          filepath: './.eslintrc-auto-import.json'
        }
      }),
      Components({
        // common 下全局组件自动注册；dirs + resolver 双注册，兼容 CustomDropdown / Custom_dropdown
        dirs: ['src/components/common'],
        dts: 'components.d.ts',
        allowOverrides: true,
        resolvers: [snakeCaseCommonResolver]
      })
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      port: 3001,
      host: true,
      open: false,
      proxy: {
        '/webapi': {
          ...proxyConfig,
          rewrite: (path) => path.replace(/^\/webapi/, ''),
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              console.log(
                'Proxying:',
                req.method,
                req.url,
                '->',
                options.target + req.url.replace(/^\/webapi/, '')
              )
            })
            proxy.on('error', (err) => {
              console.log('Proxy error:', err)
            })
          }
        },
        '/apiStats': {
          ...proxyConfig,
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              console.log(
                'API Stats Proxying:',
                req.method,
                req.url,
                '->',
                options.target + req.url
              )
            })
          }
        }
      }
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (id.includes('chart.js')) return 'chart'
            if (
              id.includes('/vue/') ||
              id.includes('/vue-router/') ||
              id.includes('/pinia/') ||
              id.includes('\\vue\\') ||
              id.includes('\\vue-router\\') ||
              id.includes('\\pinia\\')
            ) {
              return 'vue-vendor'
            }
            if (id.includes('@iconify-json') || id.includes('/unocss/') || id.includes('\\unocss\\')) {
              return 'icons'
            }
            return 'vendor'
          }
        }
      }
    }
  }
})
