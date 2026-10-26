// 此函数在 HTML head 中同步执行，不依赖应用脚本或组件挂载。
export const bootstrapAppearance = (themes) => {
  const root = document.documentElement
  const read = (key) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }
  const savedMode = read('themeMode')
  const mode = ['light', 'dark', 'auto'].includes(savedMode) ? savedMode : 'auto'
  const savedScheme = read('colorScheme')
  const scheme = Object.hasOwn(themes, savedScheme) ? savedScheme : 'purple'
  const dark =
    mode === 'dark' ||
    (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const theme = themes[scheme]
  const tokens = dark ? theme.dark : theme.light
  root.classList.toggle('dark', dark)
  root.dataset.theme = scheme
  root.style.colorScheme = dark ? 'dark' : 'light'
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(`--${name}`, value)
  root.style.backgroundColor = tokens['page-bg']
  const hasLayoutPreference = read('adminLayoutVersion') === '1'
  const savedNavigation = read('adminNavigationLayout')
  const navigation =
    hasLayoutPreference && ['auto', 'top', 'sidebar'].includes(savedNavigation)
      ? savedNavigation
      : 'sidebar'
  root.dataset.themeLayout = navigation === 'auto' ? theme.layout : navigation
  const savedWidth = read('adminWorkspaceWidth')
  const width =
    hasLayoutPreference && ['focused', 'wide', 'fluid'].includes(savedWidth) ? savedWidth : 'wide'
  root.dataset.workspaceWidth = width
  root.style.setProperty(
    '--workspace-max-width',
    { focused: '1360px', wide: '1680px', fluid: 'none' }[width]
  )
}
