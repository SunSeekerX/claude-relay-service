import { defineStore } from 'pinia'
import { ref, computed, watch, onScopeDispose } from 'vue'
import { ColorSchemes, createThemeTokens } from '@/libs/theme_presets'

export { ColorSchemes }
export const ThemeMode = { LIGHT: 'light', DARK: 'dark', AUTO: 'auto' }

export const useThemeStore = defineStore('theme', () => {
  const themeMode = ref(ThemeMode.AUTO)
  const systemPrefersDark = ref(false)
  const systemPrefersReducedMotion = ref(false)
  const colorScheme = ref('purple')
  const density = ref('comfortable')
  const fontSize = ref(14)
  const motion = ref('system')
  const settingsOpen = ref(false)
  const layoutSettingsOpen = ref(false)
  const workspaceWidth = ref('wide')
  const navigationLayout = ref('sidebar')
  let initialized = false
  let stopSystemTheme
  let themeFrame

  const isDarkMode = computed(() =>
    themeMode.value === ThemeMode.AUTO
      ? systemPrefersDark.value
      : themeMode.value === ThemeMode.DARK
  )
  const reducedMotion = computed(
    () => motion.value === 'reduced' || systemPrefersReducedMotion.value
  )
  const currentTheme = computed(() => (isDarkMode.value ? ThemeMode.DARK : ThemeMode.LIGHT))
  const currentColorScheme = computed(() => ColorSchemes[colorScheme.value])
  const currentNavigationLayout = computed(() =>
    navigationLayout.value === 'auto' ? currentColorScheme.value.layout : navigationLayout.value
  )
  const currentColors = computed(() =>
    isDarkMode.value ? currentColorScheme.value.dark : currentColorScheme.value.light
  )

  const applyTheme = () => {
    const root = document.documentElement
    // 一次更新所有颜色，避免旧页面的逐元素 transition 产生混色闪烁。
    root.classList.add('theme-changing')
    cancelAnimationFrame(themeFrame)
    root.classList.toggle('dark', isDarkMode.value)
    root.dataset.theme = colorScheme.value
    root.dataset.material = currentColorScheme.value.material
    root.dataset.themeLayout = currentNavigationLayout.value
    root.dataset.workspaceWidth = workspaceWidth.value
    root.style.setProperty(
      '--workspace-max-width',
      { focused: '1360px', wide: '1680px', fluid: 'none' }[workspaceWidth.value]
    )
    root.dataset.density = density.value
    root.dataset.motion = motion.value
    root.style.colorScheme = currentTheme.value
    root.style.backgroundColor = currentColors.value.page
    for (const [name, value] of Object.entries(
      createThemeTokens(colorScheme.value, isDarkMode.value, density.value)
    )) {
      root.style.setProperty(`--${name}`, value)
    }
    root.style.setProperty('--base-font-size', `${fontSize.value}px`)
    themeFrame = requestAnimationFrame(() => {
      themeFrame = requestAnimationFrame(() => {
        root.classList.remove('theme-changing')
        window.dispatchEvent(new Event('resize'))
      })
    })
  }

  // 多个旧页面仍调用初始化；系统监听只注册一次。
  const watchSystemTheme = () => {
    if (stopSystemTheme) return stopSystemTheme
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    systemPrefersDark.value = query.matches
    systemPrefersReducedMotion.value = motionQuery.matches
    const handleChange = (event) => {
      systemPrefersDark.value = event.matches
    }
    const handleMotionChange = (event) => {
      systemPrefersReducedMotion.value = event.matches
    }
    query.addEventListener('change', handleChange)
    motionQuery.addEventListener('change', handleMotionChange)
    stopSystemTheme = () => {
      query.removeEventListener('change', handleChange)
      motionQuery.removeEventListener('change', handleMotionChange)
      stopSystemTheme = undefined
    }
    return stopSystemTheme
  }

  const initTheme = () => {
    if (initialized) return
    const savedMode = localStorage.getItem('themeMode')
    const savedScheme = localStorage.getItem('colorScheme')
    const savedDensity = localStorage.getItem('themeDensity')
    const savedFontSize = Number(localStorage.getItem('themeFontSize'))
    const savedMotion = localStorage.getItem('themeMotion')
    const savedWidth = localStorage.getItem('adminWorkspaceWidth')
    const savedNavigation = localStorage.getItem('adminNavigationLayout')
    const hasLayoutPreference = localStorage.getItem('adminLayoutVersion') === '1'
    if (Object.values(ThemeMode).includes(savedMode)) themeMode.value = savedMode
    if (Object.hasOwn(ColorSchemes, savedScheme)) colorScheme.value = savedScheme
    if (['comfortable', 'compact'].includes(savedDensity)) density.value = savedDensity
    if ([14, 15, 16].includes(savedFontSize)) fontSize.value = savedFontSize
    if (['system', 'reduced'].includes(savedMotion)) motion.value = savedMotion
    if (hasLayoutPreference && ['focused', 'wide', 'fluid'].includes(savedWidth))
      workspaceWidth.value = savedWidth
    if (hasLayoutPreference && ['auto', 'top', 'sidebar'].includes(savedNavigation))
      navigationLayout.value = savedNavigation
    localStorage.setItem('adminLayoutVersion', '1')
    localStorage.setItem('adminWorkspaceWidth', workspaceWidth.value)
    localStorage.setItem('adminNavigationLayout', navigationLayout.value)
    watchSystemTheme()
    initialized = true
    applyTheme()
  }

  const setWorkspaceWidth = (value) => {
    if (['focused', 'wide', 'fluid'].includes(value)) workspaceWidth.value = value
  }
  const setNavigationLayout = (value) => {
    if (['auto', 'top', 'sidebar'].includes(value)) navigationLayout.value = value
  }
  const resetLayout = () => {
    workspaceWidth.value = 'wide'
    navigationLayout.value = 'sidebar'
  }
  const setThemeMode = (mode) => {
    if (Object.values(ThemeMode).includes(mode)) themeMode.value = mode
  }
  const setColorScheme = (scheme) => {
    if (Object.hasOwn(ColorSchemes, scheme)) colorScheme.value = scheme
  }
  const setDensity = (value) => {
    if (['comfortable', 'compact'].includes(value)) density.value = value
  }
  const setFontSize = (value) => {
    if ([14, 15, 16].includes(value)) fontSize.value = value
  }
  const setMotion = (value) => {
    if (['system', 'reduced'].includes(value)) motion.value = value
  }
  const cycleThemeMode = () => {
    const modes = Object.values(ThemeMode)
    setThemeMode(modes[(modes.indexOf(themeMode.value) + 1) % modes.length])
  }
  const cycleColorScheme = () => {
    const schemes = Object.keys(ColorSchemes)
    setColorScheme(schemes[(schemes.indexOf(colorScheme.value) + 1) % schemes.length])
  }
  const resetAppearance = () => {
    themeMode.value = ThemeMode.AUTO
    colorScheme.value = 'purple'
    density.value = 'comfortable'
    fontSize.value = 14
    motion.value = 'system'
  }

  watch(
    [
      themeMode,
      colorScheme,
      density,
      fontSize,
      motion,
      systemPrefersDark,
      workspaceWidth,
      navigationLayout
    ],
    () => {
      if (!initialized) return
      localStorage.setItem('themeMode', themeMode.value)
      localStorage.setItem('colorScheme', colorScheme.value)
      localStorage.setItem('themeDensity', density.value)
      localStorage.setItem('themeFontSize', String(fontSize.value))
      localStorage.setItem('themeMotion', motion.value)
      localStorage.setItem('adminWorkspaceWidth', workspaceWidth.value)
      localStorage.setItem('adminNavigationLayout', navigationLayout.value)
      applyTheme()
    },
    { flush: 'sync' }
  )

  onScopeDispose(() => {
    stopSystemTheme?.()
    cancelAnimationFrame(themeFrame)
    document.documentElement.classList.remove('theme-changing')
  })

  return {
    themeMode,
    systemPrefersDark,
    colorScheme,
    density,
    fontSize,
    motion,
    settingsOpen,
    layoutSettingsOpen,
    workspaceWidth,
    navigationLayout,
    currentNavigationLayout,
    setWorkspaceWidth,
    setNavigationLayout,
    resetLayout,
    isDarkMode,
    reducedMotion,
    currentTheme,
    currentColorScheme,
    currentColors,
    initTheme,
    applyTheme,
    watchSystemTheme,
    setThemeMode,
    setColorScheme,
    setDensity,
    setFontSize,
    setMotion,
    cycleThemeMode,
    cycleColorScheme,
    resetAppearance,
    toggleTheme: cycleThemeMode,
    setTheme: setThemeMode,
    ThemeMode,
    ColorSchemes
  }
})
