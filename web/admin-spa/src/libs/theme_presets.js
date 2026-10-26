// 每套主题分别定义明暗色板与组件形态，旧色系 ID 保持可用。
const palette = ([
  primary,
  secondary,
  accent,
  page,
  surface,
  muted,
  text,
  textSecondary,
  border
]) => ({
  primary,
  secondary,
  accent,
  page,
  surface,
  muted,
  text,
  textSecondary,
  border
})

const preset = (layout, name, description, material, radius, light, dark) => ({
  layout,
  name,
  description,
  material,
  radius,
  light: palette(light),
  dark: palette(dark),
  primary: light[0],
  secondary: light[1],
  accent: light[2]
})

export const ColorSchemes = {
  purple: preset(
    'top',
    '默认紫',
    '柔光渐层，悬浮导航',
    'soft',
    [8, 12, 18],
    [
      '#5661c4',
      '#7353a6',
      '#985ab4',
      '#eef0fa',
      '#ffffff',
      '#f2f3fb',
      '#25283e',
      '#5c6078',
      '#d9dcec'
    ],
    [
      '#a9b0ff',
      '#c1a7ee',
      '#d6a9ec',
      '#131422',
      '#202136',
      '#292b42',
      '#ececf8',
      '#b5b7d0',
      '#41435e'
    ]
  ),
  celadon: preset(
    'top',
    '青瓷',
    '釉面留白，细线导航',
    'soft',
    [12, 22, 30],
    [
      '#316d70',
      '#3d7673',
      '#477f86',
      '#e9f2f1',
      '#f9fdfc',
      '#edf5f3',
      '#203c3c',
      '#506f6e',
      '#c8dcd8'
    ],
    [
      '#99d1ce',
      '#8cc1b7',
      '#abdadd',
      '#102021',
      '#1c3031',
      '#263c3c',
      '#e2f2ef',
      '#acc7c4',
      '#3b5755'
    ]
  ),
  cinnabar: preset(
    'top',
    '朱砂',
    '漆器描金，方印按钮',
    'inset',
    [2, 4, 6],
    [
      '#a33d3d',
      '#873636',
      '#aa5c49',
      '#f3eae6',
      '#fffaf6',
      '#f4eae4',
      '#442c29',
      '#7b5b53',
      '#deccc2'
    ],
    [
      '#f09a8f',
      '#d98178',
      '#e5b28f',
      '#241715',
      '#342320',
      '#422d28',
      '#f7e7df',
      '#d0b1a3',
      '#65463d'
    ]
  ),
  jade: preset(
    'sidebar',
    '墨玉',
    '墨玉侧栏，磨砂面板',
    'flat',
    [3, 6, 10],
    [
      '#376647',
      '#2f5840',
      '#527c60',
      '#eaf0eb',
      '#f7fbf7',
      '#eaf2eb',
      '#24382a',
      '#536a59',
      '#c8d6ca'
    ],
    [
      '#91c29e',
      '#7eaf8d',
      '#b0d1ad',
      '#101d15',
      '#1a2a20',
      '#24392b',
      '#e3efe5',
      '#aac4b0',
      '#3c5643'
    ]
  ),
  indigo: preset(
    'top',
    '藏蓝',
    '蓝图网格，书卷标题',
    'flat',
    [2, 3, 5],
    [
      '#365d91',
      '#2c4a72',
      '#5477a4',
      '#edf1f6',
      '#fbfcff',
      '#eef2f8',
      '#26364d',
      '#596c85',
      '#ccd6e4'
    ],
    [
      '#95b9ee',
      '#8aa4d0',
      '#b4caf0',
      '#131b2b',
      '#1e2b40',
      '#28364d',
      '#e6edf9',
      '#b3c3de',
      '#405472'
    ]
  ),
  amber: preset(
    'top',
    '琥珀',
    '黄铜细边，页签导航',
    'soft',
    [4, 8, 12],
    [
      '#89640f',
      '#78501c',
      '#966930',
      '#f5f0e3',
      '#fffcf5',
      '#f6f0df',
      '#413723',
      '#756749',
      '#dfd3b8'
    ],
    [
      '#e3c16e',
      '#d4ad75',
      '#f0dca3',
      '#221e13',
      '#302b1d',
      '#3d3523',
      '#f2ebd6',
      '#cdbf97',
      '#5e5338'
    ]
  ),
  rouge: preset(
    'top',
    '胭脂',
    '圆润胶囊，柔纸卡片',
    'soft',
    [18, 24, 32],
    [
      '#a14362',
      '#873751',
      '#ad617b',
      '#f6edf1',
      '#fffafd',
      '#f9eef3',
      '#482d3a',
      '#7d596c',
      '#e4ccd8'
    ],
    [
      '#efa6bf',
      '#d792af',
      '#f0bad5',
      '#25171f',
      '#382530',
      '#462e3c',
      '#f7e6ef',
      '#d1b3c5',
      '#624357'
    ]
  ),
  zinc: preset(
    'sidebar',
    '极简灰',
    '直角侧栏，无影线框',
    'flat',
    [0, 0, 0],
    [
      '#3f3f46',
      '#52525b',
      '#62626c',
      '#f3f3f4',
      '#ffffff',
      '#f4f4f5',
      '#27272a',
      '#62626b',
      '#d9d9de'
    ],
    [
      '#d4d4d8',
      '#bfbfc8',
      '#e4e4e7',
      '#151517',
      '#222225',
      '#2e2e32',
      '#f4f4f5',
      '#bcbcc5',
      '#48484f'
    ]
  ),
  macos: preset(
    'sidebar',
    'macOS',
    '窗口侧栏，分组列表',
    'soft',
    [6, 12, 16],
    [
      '#0064ce',
      '#3158a4',
      '#35758c',
      '#ededf2',
      '#ffffff',
      '#f4f4f7',
      '#24242b',
      '#666671',
      '#d8d8e0'
    ],
    [
      '#79baff',
      '#9cb8f4',
      '#95d3e0',
      '#17171c',
      '#27272f',
      '#33333c',
      '#f4f4f8',
      '#bcbcc9',
      '#484853'
    ]
  ),
  liquid_glass: preset(
    'top',
    '流光玻璃',
    '透明悬浮，折光边缘',
    'glass',
    [18, 24, 32],
    [
      '#155d9e',
      '#5358b4',
      '#337c88',
      '#e6f0fb',
      '#f7fbff',
      '#eaf2fc',
      '#213c58',
      '#3f5972',
      '#b8cee7'
    ],
    [
      '#9dceff',
      '#c3b9fa',
      '#9fdae2',
      '#0d1a2b',
      '#1a3049',
      '#27415d',
      '#e5f2ff',
      '#b3cae3',
      '#476381'
    ]
  ),
  smartisan: preset(
    'top',
    '锤子',
    '实体面板，凹凸按键',
    'inset',
    [4, 6, 9],
    [
      '#a53c32',
      '#843b32',
      '#9d6b42',
      '#eae5df',
      '#faf7f2',
      '#eee8df',
      '#3f3731',
      '#73665a',
      '#cfc2b4'
    ],
    [
      '#ec9a86',
      '#d48d7a',
      '#d9b38a',
      '#201b18',
      '#312a25',
      '#40362e',
      '#f3e8da',
      '#cbb8a4',
      '#635346'
    ]
  )
}

const toRgb = (hex) =>
  hex
    .slice(1)
    .match(/.{2}/g)
    .map((value) => parseInt(value, 16))
const rgb = (values) => `rgb(${values.join(', ')})`
const mix = (first, second, amount) =>
  toRgb(first).map((value, index) =>
    Math.round(value * (1 - amount) + toRgb(second)[index] * amount)
  )
const luminance = (values) =>
  values.reduce((sum, value, index) => {
    const channel = value / 255
    return (
      sum +
      (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) *
        [0.2126, 0.7152, 0.0722][index]
    )
  }, 0)

// 实心操作始终使用白字，浅色品牌色也需保证对比度。
const actionBackground = (hex) => {
  let values = toRgb(hex)
  while (1.05 / (luminance(values) + 0.05) < 4.6)
    values = values.map((value) => Math.floor(value * 0.96))
  return rgb(values)
}

export const createThemeTokens = (schemeId, dark, density = 'comfortable') => {
  const scheme = ColorSchemes[schemeId]
  const colors = dark ? scheme.dark : scheme.light
  const { primary, secondary, accent, page, surface, muted, text, textSecondary, border } = colors
  const compact = density === 'compact'
  const glass = scheme.material === 'glass'
  const inset = scheme.material === 'inset'
  const flat = scheme.material === 'flat'
  const shadowColor = dark ? '0, 0, 0' : toRgb(text).join(', ')
  const smallShadow = flat ? 'none' : `0 1px 3px rgba(${shadowColor}, ${dark ? 0.2 : 0.07})`
  const panelShadow = flat
    ? `0 1px 0 rgba(${shadowColor}, 0.04)`
    : `${inset ? `inset 0 1px 2px rgba(${shadowColor}, 0.07), ` : ''}0 6px 24px rgba(${shadowColor}, ${dark ? 0.22 : 0.07})`
  const action = actionBackground(primary)
  const actionSecondary = actionBackground(secondary)
  const tokens = {
    'primary-color': primary,
    'secondary-color': secondary,
    'accent-color': accent,
    'primary-rgb': toRgb(primary).join(', '),
    'secondary-rgb': toRgb(secondary).join(', '),
    'accent-rgb': toRgb(accent).join(', '),
    'action-primary': action,
    'action-secondary': actionSecondary,
    'action-bg': inset || glass ? `linear-gradient(180deg, ${action}, ${actionSecondary})` : action,
    'text-on-primary': '#ffffff',
    'text-primary': text,
    'text-secondary': textSecondary,
    'text-muted': textSecondary,
    'page-bg': page,
    'bg-gradient-start': page,
    'bg-gradient-mid': rgb(mix(page, primary, glass ? 0.12 : 0.025)),
    'bg-gradient-end': rgb(mix(page, secondary, glass ? 0.14 : 0.04)),
    'surface-color': surface,
    'surface-muted': muted,
    'surface-raised': rgb(mix(surface, primary, dark ? 0.09 : 0.025)),
    'glass-strong-color': glass
      ? `rgba(${toRgb(surface).join(', ')}, ${dark ? 0.84 : 0.8})`
      : surface,
    'glass-color': glass ? `rgba(${toRgb(surface).join(', ')}, 0.68)` : muted,
    'popover-bg': surface,
    'input-bg': inset ? muted : surface,
    'table-bg': surface,
    'table-head-bg': muted,
    'table-hover': rgb(mix(surface, primary, dark ? 0.1 : 0.055)),
    'border-color': border,
    'divider-color': rgb(mix(surface, border, 0.65)),
    'input-border': rgb(mix(border, textSecondary, 0.22)),
    'primary-soft': rgb(mix(surface, primary, dark ? 0.17 : 0.08)),
    'primary-soft-strong': rgb(mix(surface, primary, dark ? 0.25 : 0.14)),
    'nav-item-active-bg': rgb(mix(surface, primary, dark ? 0.2 : 0.1)),
    'nav-item-active-fg': primary,
    'nav-item-hover': rgb(mix(surface, text, 0.045)),
    'focus-ring': `rgba(${toRgb(primary).join(', ')}, 0.25)`,
    'modal-bg': `rgba(${toRgb(page).join(', ')}, ${dark ? 0.76 : 0.6})`,
    'radius-sm': `${Math.max(0, scheme.radius[0] - (compact ? 2 : 0))}px`,
    'radius-md': `${Math.max(0, scheme.radius[1] - (compact ? 2 : 0))}px`,
    'radius-lg': `${Math.max(0, scheme.radius[2] - (compact ? 3 : 0))}px`,
    'shadow-sm': smallShadow,
    'shadow-md': panelShadow,
    'shadow-popover': `0 12px 40px rgba(${shadowColor}, ${dark ? 0.4 : 0.16})`,
    'control-shadow': inset ? `inset 0 1px 3px rgba(${shadowColor}, 0.08)` : smallShadow,
    'surface-blur': glass ? '18px' : '0px',
    'control-height': compact ? '32px' : '36px',
    'cell-padding-y': compact ? '7px' : '11px',
    'cell-padding-x': compact ? '10px' : '14px',
    'card-padding': compact ? '12px' : '16px',
    'section-gap': compact ? '12px' : '18px',
    'success-color': dark ? '#8bd5ae' : '#18734b',
    'warning-color': dark ? '#edc57c' : '#8c5b10',
    'error-color': dark ? '#f3a3a6' : '#b03040',
    'info-color': dark ? '#98c5f5' : '#2a669f',
    'scrollbar-track': muted,
    'scrollbar-thumb': rgb(mix(border, textSecondary, 0.3))
  }
  const neutral = dark
    ? {
        50: text,
        100: text,
        200: text,
        300: textSecondary,
        400: textSecondary,
        500: textSecondary,
        600: border,
        700: tokens['surface-raised'],
        800: surface,
        900: page,
        950: page
      }
    : {
        50: muted,
        100: muted,
        200: border,
        300: tokens['input-border'],
        400: textSecondary,
        500: textSecondary,
        600: textSecondary,
        700: textSecondary,
        800: text,
        900: text,
        950: text
      }
  for (const [shade, color] of Object.entries(neutral)) {
    tokens[`neutral-${shade}`] = color.startsWith('#')
      ? toRgb(color).join(', ')
      : color.slice(4, -1)
  }
  for (const name of ['success', 'warning', 'error', 'info']) {
    const color = tokens[`${name}-color`]
    tokens[`${name}-soft`] = rgb(mix(surface, color, dark ? 0.14 : 0.075))
    tokens[`${name}-action`] = actionBackground(color)
  }
  // 材质控制表面、导航、控件和图标；色板之外保留独立的视觉语言。
  const highlight = dark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.9)'
  const relief = `inset 0 1px 0 ${highlight}, 0 2px 0 ${border}, 0 4px 8px rgba(${shadowColor},0.12)`
  const ceramic = `radial-gradient(ellipse at 12% 0%, rgba(${toRgb(primary).join(',')},0.09), transparent 65%), ${surface}`
  const lacquer = `linear-gradient(165deg, ${highlight}, transparent 45%), ${surface}`
  const frostedGlass = `rgba(${toRgb(surface).join(',')},${dark ? 0.64 : 0.6})`
  const treatments = {
    purple: {
      card: surface,
      shadow: panelShadow,
      navigation: muted,
      active: `linear-gradient(115deg,${action},${actionSecondary})`,
      activeColor: '#ffffff',
      control: surface,
      icon: tokens['primary-soft'],
      iconColor: primary,
      heading: 'inherit'
    },
    celadon: {
      card: ceramic,
      shadow: `inset 0 1px 1px ${highlight}, 0 8px 24px rgba(${shadowColor},0.06)`,
      navigation: 'transparent',
      active: 'transparent',
      activeColor: primary,
      control: muted,
      icon: 'transparent',
      iconColor: primary,
      heading: 'inherit'
    },
    cinnabar: {
      card: lacquer,
      shadow: `inset 0 0 0 1px ${highlight}, 0 3px 8px rgba(${shadowColor},0.09)`,
      navigation: surface,
      active: action,
      activeColor: '#ffffff',
      control: muted,
      icon: action,
      iconColor: '#ffffff',
      heading: "'Noto Serif SC', 'Songti SC', SimSun, serif"
    },
    jade: {
      card: `linear-gradient(145deg,${surface},${muted})`,
      shadow: 'none',
      navigation: muted,
      active: tokens['primary-soft-strong'],
      activeColor: primary,
      control: page,
      icon: 'transparent',
      iconColor: primary,
      heading: 'inherit'
    },
    indigo: {
      card: surface,
      shadow: 'none',
      navigation: 'transparent',
      active: surface,
      activeColor: primary,
      control: surface,
      icon: 'transparent',
      iconColor: primary,
      heading: "'Noto Serif SC', 'Songti SC', SimSun, serif"
    },
    amber: {
      card: `linear-gradient(180deg,${surface},${muted})`,
      shadow: `0 2px 0 ${border}, 0 4px 8px rgba(${shadowColor},0.05)`,
      navigation: 'transparent',
      active: surface,
      activeColor: primary,
      control: surface,
      icon: muted,
      iconColor: primary,
      heading: 'inherit'
    },
    rouge: {
      card: surface,
      shadow: `0 8px 28px rgba(${shadowColor},0.07)`,
      navigation: muted,
      active: surface,
      activeColor: primary,
      control: muted,
      icon: tokens['primary-soft'],
      iconColor: primary,
      heading: 'inherit'
    },
    zinc: {
      card: surface,
      shadow: 'none',
      navigation: surface,
      active: muted,
      activeColor: text,
      control: surface,
      icon: 'transparent',
      iconColor: text,
      heading: 'inherit'
    },
    macos: {
      card: surface,
      shadow: `0 1px 2px rgba(${shadowColor},0.06)`,
      navigation: muted,
      active: tokens['primary-soft-strong'],
      activeColor: primary,
      control: surface,
      icon: primary,
      iconColor: dark ? page : '#ffffff',
      heading: 'inherit'
    },
    liquid_glass: {
      card: frostedGlass,
      shadow: `inset 0 1px 0 ${highlight}, inset 0 -1px 0 rgba(${toRgb(primary).join(',')},0.14), 0 14px 40px rgba(${shadowColor},${dark ? 0.24 : 0.09})`,
      navigation: frostedGlass,
      active: surface,
      activeColor: primary,
      control: `rgba(${toRgb(surface).join(',')},0.72)`,
      icon: `rgba(${toRgb(surface).join(',')},0.6)`,
      iconColor: primary,
      heading: 'inherit'
    },
    smartisan: {
      card: `linear-gradient(180deg,${surface},${muted})`,
      shadow: relief,
      navigation: muted,
      active: `linear-gradient(180deg,${action},${actionSecondary})`,
      activeColor: '#ffffff',
      control: muted,
      icon: `linear-gradient(180deg,${surface},${muted})`,
      iconColor: primary,
      heading: 'inherit'
    }
  }
  const treatment = treatments[schemeId]
  Object.assign(tokens, {
    'card-face': treatment.card,
    'card-shadow': treatment.shadow,
    'navigation-face': treatment.navigation,
    'navigation-active-bg': treatment.active,
    'navigation-active-color': treatment.activeColor,
    'control-face': treatment.control,
    'metric-icon-bg': treatment.icon,
    'metric-icon-color': treatment.iconColor,
    'heading-font': treatment.heading,
    'relief-shadow': relief,
    'surface-highlight': highlight
  })
  return tokens
}
