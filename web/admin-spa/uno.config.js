import { createRequire } from 'node:module'

import {
  defineConfig,
  presetIcons,
  presetUno,
  transformerDirectives,
  transformerVariantGroup
} from 'unocss'

// Node ESM 直接 import *.json 要 import attribute；Uno 在构建期同步读集合时更稳妥走 createRequire
const require = createRequire(import.meta.url)
const loadIconifyJson = (pkg) => () => require(`${pkg}/icons.json`)

export default defineConfig({
  presets: [
    presetUno({
      dark: 'class',
      // 开启 preflight（默认 true）：全局 box-sizing:border-box 等基础重置
      preflight: true
    }),
    presetIcons({
      scale: 1,
      warn: true,
      extraProperties: {
        display: 'inline-block',
        'vertical-align': 'middle'
      },
      // 离线集合：构建不访问 iconify API；si 为 simple-icons 短前缀
      collections: {
        lucide: loadIconifyJson('@iconify-json/lucide'),
        logos: loadIconifyJson('@iconify-json/logos'),
        si: loadIconifyJson('@iconify-json/simple-icons')
      }
    })
  ],
  transformers: [transformerDirectives(), transformerVariantGroup()],
  theme: {
    fontFamily: {
      sans: 'var(--font-family)',
      mono: 'var(--font-mono)'
    },
    colors: {
      primary: {
        DEFAULT: 'var(--primary-color)',
        rgb: 'rgb(var(--primary-rgb))'
      },
      secondary: {
        DEFAULT: 'var(--secondary-color)',
        rgb: 'rgb(var(--secondary-rgb))'
      },
      accent: {
        DEFAULT: 'var(--accent-color)',
        rgb: 'rgb(var(--accent-rgb))'
      },
      surface: 'var(--surface-color)',
      'glass-strong': 'var(--glass-strong-color)',
      glass: 'var(--glass-color)'
    },
    animation: {
      keyframes: {
        gradient: `{
          0%, 100% { background-size: 200% 200%; background-position: left center; }
          50% { background-size: 200% 200%; background-position: right center; }
        }`,
        float: `{
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }`,
        'pulse-glow': `{
          0%, 100% { opacity: 1; }
          50% { opacity: 0.8; }
        }`
      },
      durations: {
        gradient: '8s',
        float: '6s',
        'pulse-glow': '2s'
      },
      timingFns: {
        gradient: 'ease',
        float: 'ease-in-out',
        'pulse-glow': 'ease-in-out'
      },
      counts: {
        gradient: 'infinite',
        float: 'infinite',
        'pulse-glow': 'infinite'
      }
    }
  },
  shortcuts: [
    // 主题表面背景（原 tailwind extend）
    ['bg-theme-surface', 'bg-[var(--surface-color)]'],
    ['bg-theme-glass', 'bg-[var(--glass-strong-color)]'],
    ['border-theme-border', 'border-[var(--border-color)]']
  ],
  // JS 动态拼接的图标类静态扫描不到，集中 safelist
  safelist: [
    // 通用状态
    'i-lucide-loader-circle',
    'i-lucide-check',
    'i-lucide-x',
    'i-lucide-circle-check',
    'i-lucide-circle-x',
    'i-lucide-circle-alert',
    'i-lucide-triangle-alert',
    'i-lucide-info',
    'i-lucide-circle-question-mark',
    'animate-spin',
    // 导航 / 布局
    'i-lucide-gauge',
    'i-lucide-key',
    'i-lucide-circle-user',
    'i-lucide-table',
    'i-lucide-ticket',
    'i-lucide-credit-card',
    'i-lucide-server',
    'i-lucide-users',
    'i-lucide-settings-2',
    'i-lucide-settings',
    'i-lucide-sun',
    'i-lucide-moon',
    'i-lucide-contrast',
    // 账户 / 平台
    'i-lucide-bot',
    'i-lucide-brain',
    'i-lucide-gem',
    'i-lucide-code',
    'i-lucide-cpu',
    'i-logos-aws',
    'i-logos-microsoft-icon',
    'i-logos-google-icon',
    'i-logos-android-icon',
    'i-logos-apple',
    'i-logos-linux-tux',
    'i-logos-microsoft-windows',
    'i-logos-openai-icon',
    'i-logos-discord-icon',
    'i-logos-slack-icon',
    'i-logos-telegram',
    'i-si-wechat',
    'icon-openai',
    // 业务常用
    'i-lucide-palette',
    'i-lucide-bell',
    'i-lucide-scale',
    'i-lucide-coins',
    'i-lucide-flask-conical',
    'i-lucide-layers',
    'i-lucide-cloud-download',
    'i-lucide-webhook',
    'i-lucide-filter',
    'i-lucide-ban',
    'i-lucide-wrench',
    'i-lucide-toggle-right',
    'i-lucide-user-round-cog',
    'i-lucide-shield',
    'i-lucide-flag',
    'i-lucide-volume-2',
    'i-lucide-chart-pie',
    'i-lucide-box',
    'i-lucide-plug',
    'i-lucide-list',
    'i-lucide-calendar-days',
    'i-lucide-refresh-cw',
    'i-lucide-trash-2',
    'i-lucide-file-output',
    'i-lucide-arrow-down-wide-narrow',
    'i-lucide-link',
    'i-lucide-box',
    'i-lucide-send',
    'i-lucide-database',
    'i-lucide-arrow-down',
    'i-lucide-arrow-up',
    'i-lucide-paperclip',
    'i-lucide-hourglass',
    'i-lucide-play',
    'i-lucide-zap',
    'i-lucide-user',
    'i-lucide-shield-check'
  ]
})
