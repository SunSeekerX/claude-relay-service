<template>
  <AppDialog
    v-model="themeStore.settingsOpen"
    description="主题、明暗与显示偏好即时生效，自动保存在此浏览器。"
    icon="i-lucide-palette"
    size="xl"
    title="外观设置"
  >
    <div ref="content" class="appearance-layout">
      <section aria-label="选择主题">
        <div class="appearance-section-heading">
          <h4>主题风格</h4>
          <span>{{ themeStore.currentColorScheme.name }}</span>
        </div>
        <div class="theme-gallery">
          <button
            v-for="(scheme, key) in ColorSchemes"
            :key="key"
            :aria-label="`${scheme.name}，${scheme.description}`"
            :aria-pressed="themeStore.colorScheme === key"
            class="theme-choice"
            :style="previews[key]"
            type="button"
            @click="themeStore.setColorScheme(key)"
          >
            <span
              aria-hidden="true"
              class="theme-miniature"
              :data-preview-layout="
                themeStore.navigationLayout === 'auto' ? scheme.layout : themeStore.navigationLayout
              "
              :data-preview-theme="key"
            >
              <span class="theme-miniature__bar"><b /><span /><span /></span>
              <span class="theme-miniature__workspace">
                <span class="theme-miniature__nav"><b /><span /><span /></span>
                <span class="theme-miniature__content">
                  <span class="theme-miniature__tiles"><b /><b /><b /></span>
                  <span class="theme-miniature__table"><span /><span /><span /></span>
                </span>
              </span>
            </span>
            <span class="theme-choice__label">
              <strong>{{ scheme.name }}</strong>
              <i
                v-if="themeStore.colorScheme === key"
                aria-hidden="true"
                class="i-lucide-circle-check"
              />
              <span v-else aria-hidden="true" class="theme-choice__dot" />
            </span>
            <span class="theme-choice__description">{{ scheme.description }}</span>
          </button>
        </div>
      </section>

      <aside class="appearance-preferences">
        <section aria-label="组件预览" class="appearance-live-preview">
          <div class="appearance-section-heading">
            <h4>组件预览</h4>
            <span>实时</span>
          </div>
          <div class="appearance-example card">
            <div class="appearance-example__heading">
              <strong>中转服务</strong
              ><span class="theme-status theme-status--success">运行中</span>
            </div>
            <label for="appearance-preview-input">名称</label>
            <input
              id="appearance-preview-input"
              class="form-input w-full"
              placeholder="输入名称查看效果"
            />
            <CustomDropdown v-model="previewRange" :options="previewOptions" size="sm" />
            <div class="appearance-example__actions">
              <button class="btn btn-primary" type="button" @click="previewRange = 'today'">
                主要操作
              </button>
              <button class="btn btn-secondary" type="button" @click="previewRange = 'week'">
                次要操作
              </button>
            </div>
            <div class="appearance-example__statuses">
              <span class="theme-status theme-status--info">信息</span>
              <span class="theme-status theme-status--warning">注意</span>
              <span class="theme-status theme-status--error">异常</span>
            </div>
          </div>
        </section>

        <section aria-label="明暗模式" class="appearance-preference">
          <h4>明暗模式</h4>
          <div class="appearance-options">
            <button
              v-for="option in modeOptions"
              :key="option.value"
              :aria-pressed="themeStore.themeMode === option.value"
              type="button"
              @click="themeStore.setThemeMode(option.value)"
            >
              <i :class="option.icon" />{{ option.label }}
            </button>
          </div>
        </section>
        <section aria-label="界面密度" class="appearance-preference">
          <h4>界面密度</h4>
          <div class="appearance-options">
            <button
              v-for="option in densityOptions"
              :key="option.value"
              :aria-pressed="themeStore.density === option.value"
              type="button"
              @click="themeStore.setDensity(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </section>
        <section aria-label="文字大小" class="appearance-preference">
          <h4>文字大小</h4>
          <div class="appearance-options">
            <button
              v-for="size in [14, 15, 16]"
              :key="size"
              :aria-pressed="themeStore.fontSize === size"
              type="button"
              @click="themeStore.setFontSize(size)"
            >
              {{ size }} px
            </button>
          </div>
        </section>
        <section aria-label="动效" class="appearance-preference">
          <h4>动效</h4>
          <div class="appearance-options">
            <button
              v-for="option in motionOptions"
              :key="option.value"
              :aria-pressed="themeStore.motion === option.value"
              type="button"
              @click="themeStore.setMotion(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </section>
      </aside>
    </div>
    <template #footer>
      <span aria-live="polite" class="appearance-saved"><i class="i-lucide-check" />已保存</span>
      <button class="btn btn-secondary" type="button" @click="themeStore.resetAppearance">
        恢复默认
      </button>
      <DialogSaveActions
        :show-cancel="false"
        @save="(closeAfter) => { if (closeAfter) themeStore.settingsOpen = false }"
      />
    </template>
  </AppDialog>
</template>

<script setup>
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useThemeStore } from '@/stores/theme'
import { ColorSchemes, createThemeTokens } from '@/libs/theme_presets'
import AppDialog from './app_dialog.vue'
import CustomDropdown from './custom_dropdown.vue'

const themeStore = useThemeStore()
const content = ref(null)
const previewRange = ref('today')
const previewOptions = [
  { value: 'today', label: '今日请求' },
  { value: 'week', label: '最近一周' }
]
const modeOptions = [
  { value: 'light', label: '浅色', icon: 'i-lucide-sun' },
  { value: 'dark', label: '深色', icon: 'i-lucide-moon' },
  { value: 'auto', label: '系统', icon: 'i-lucide-contrast' }
]
const densityOptions = [
  { value: 'comfortable', label: '舒适' },
  { value: 'compact', label: '紧凑' }
]
const motionOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'reduced', label: '减少动效' }
]
const previews = computed(() =>
  Object.fromEntries(
    Object.keys(ColorSchemes).map((key) => {
      const tokens = createThemeTokens(key, themeStore.isDarkMode)
      return [
        key,
        {
          '--preview-page': tokens['page-bg'],
          '--preview-surface': tokens['glass-strong-color'],
          '--preview-primary': tokens['primary-color'],
          '--preview-muted': tokens['surface-muted'],
          '--preview-border': tokens['border-color'],
          '--preview-radius': tokens['radius-sm'],
          '--preview-shadow': tokens['card-shadow'],
          '--preview-card': tokens['card-face'],
          '--preview-navigation': tokens['navigation-face'],
          '--preview-active-bg': tokens['navigation-active-bg'],
          '--preview-icon': tokens['metric-icon-bg']
        }
      ]
    })
  )
)

let returnFocus
watch(
  () => themeStore.settingsOpen,
  async (open) => {
    if (open) {
      returnFocus = document.activeElement
      await nextTick()
      const dialog = content.value.closest('[role="dialog"]')
      dialog.querySelector('button').focus()
    } else {
      returnFocus?.focus()
    }
  }
)
const handleKeydown = (event) => {
  if (!themeStore.settingsOpen || event.defaultPrevented) return
  if (event.key === 'Escape') {
    event.preventDefault()
    themeStore.settingsOpen = false
  }
  if (event.key !== 'Tab') return
  // 下拉菜单 Teleport 到 body，自身处理键盘；关闭后再回到弹窗。
  if (event.target.closest('.cute-dropdown__panel')) return
  const controls = [
    ...content.value
      .closest('[role="dialog"]')
      .querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')
  ].filter((element) => element.getClientRects().length)
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (event.shiftKey && event.target === first) {
    event.preventDefault()
    last.focus()
  }
  if (!event.shiftKey && event.target === last) {
    event.preventDefault()
    first.focus()
  }
}
onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))
</script>

<style scoped>
.appearance-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 250px;
  gap: 24px;
  align-items: start;
}
.appearance-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}
h4 {
  margin: 0;
  font-size: var(--base-font-size);
  font-weight: 600;
  color: var(--text-primary);
}
.appearance-section-heading > span {
  color: var(--text-secondary);
  font-size: var(--base-font-size);
}
.theme-gallery {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.theme-choice {
  white-space: normal;
  overflow-wrap: anywhere;
  min-width: 0;
  text-align: left;
  border: 1px solid var(--border-color);
  padding: 6px;
  border-radius: var(--radius-md);
  background: var(--surface-color);
}
.theme-choice:hover {
  border-color: var(--primary-color);
  background: var(--primary-soft);
}
.theme-choice[aria-pressed='true'] {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 1px var(--primary-color);
}
.theme-choice:focus-visible,
.appearance-options button:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 3px;
}
.theme-miniature {
  display: flex;
  flex-direction: column;
  height: 94px;
  padding: 7px;
  gap: 5px;
  border: 1px solid var(--preview-border);
  border-radius: var(--preview-radius);
  background: var(--preview-page);
  overflow: hidden;
}
.theme-miniature__bar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 13px;
  padding: 4px;
  background: var(--preview-surface);
  border-radius: var(--preview-radius);
}
.theme-miniature__bar > b {
  width: 5px;
  height: 5px;
  border-radius: 1px;
  background: var(--preview-primary);
}
.theme-miniature__bar > span {
  width: 25%;
  height: 3px;
  background: var(--preview-border);
}
.theme-miniature__bar > span:last-child {
  width: 10%;
  margin-left: auto;
  background: var(--preview-primary);
}
.theme-miniature__workspace {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 5px;
}
.theme-miniature__nav {
  display: flex;
  height: 9px;
  padding: 2px;
  gap: 4px;
  border-radius: var(--preview-radius);
  background: var(--preview-navigation);
}
.theme-miniature__nav > * {
  height: 4px;
  flex: 1;
  border-radius: var(--preview-radius);
  background: var(--preview-border);
}
.theme-miniature__nav > b {
  background: var(--preview-active-bg);
  border-bottom: 1px solid var(--preview-primary);
}
.theme-miniature__content {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.theme-miniature__tiles {
  display: flex;
  gap: 4px;
  height: 18px;
}
.theme-miniature__tiles > b {
  position: relative;
  flex: 1;
  border: 1px solid var(--preview-border);
  border-radius: var(--preview-radius);
  background: var(--preview-card);
  box-shadow: var(--preview-shadow);
}
.theme-miniature__tiles > b::after {
  content: '';
  position: absolute;
  top: 4px;
  right: 3px;
  height: 5px;
  width: 5px;
  border-radius: var(--preview-radius);
  background: var(--preview-icon);
  border: 1px solid var(--preview-primary);
}
.theme-miniature__table {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: space-evenly;
  min-height: 10px;
  padding: 2px 5px;
  background: var(--preview-card);
  border-radius: var(--preview-radius);
}
.theme-miniature__table > span {
  height: 1px;
  background: var(--preview-border);
}
.theme-miniature[data-preview-layout='sidebar'] .theme-miniature__workspace {
  flex-direction: row;
}
.theme-miniature[data-preview-layout='sidebar'] .theme-miniature__nav {
  flex-direction: column;
  width: 24%;
  height: auto;
  gap: 5px;
  padding: 4px;
}
.theme-miniature[data-preview-layout='sidebar'] .theme-miniature__nav > * {
  flex: none;
}
.theme-miniature[data-preview-theme='celadon'] .theme-miniature__nav {
  border-bottom: 1px solid var(--preview-border);
}
.theme-miniature[data-preview-theme='celadon'] .theme-miniature__tiles > b {
  border: 0;
  border-radius: 8px;
}
.theme-miniature[data-preview-theme='cinnabar'] .theme-miniature__tiles > b {
  border-left: 2px solid var(--preview-primary);
}
.theme-miniature[data-preview-theme='cinnabar'] .theme-miniature__bar {
  border-bottom: 2px solid var(--preview-primary);
}
.theme-miniature[data-preview-theme='indigo'] {
  background-image:
    linear-gradient(var(--preview-border) 1px, transparent 1px),
    linear-gradient(90deg, var(--preview-border) 1px, transparent 1px);
  background-size: 8px 8px;
}
.theme-miniature[data-preview-theme='indigo'] .theme-miniature__tiles > b {
  border-style: dashed;
}
.theme-miniature[data-preview-theme='amber'] .theme-miniature__tiles > b {
  border-top: 2px solid var(--preview-primary);
}
.theme-miniature[data-preview-theme='rouge'] .theme-miniature__tiles {
  display: grid;
  grid-template-columns: 1fr 1fr;
  height: 30px;
}
.theme-miniature[data-preview-theme='rouge'] .theme-miniature__tiles > b {
  border: 0;
  border-radius: 8px;
}
.theme-miniature[data-preview-theme='rouge'] .theme-miniature__tiles > b:last-child {
  display: none;
}
.theme-miniature[data-preview-theme='zinc'] .theme-miniature__tiles {
  gap: 0;
}
.theme-miniature[data-preview-theme='zinc'] .theme-miniature__tiles > b {
  border-right: 0;
}
.theme-miniature[data-preview-theme='zinc'] .theme-miniature__tiles > b:last-child {
  border-right: 1px solid var(--preview-border);
}
.theme-miniature[data-preview-theme='macos'] .theme-miniature__bar {
  border-radius: 5px 5px 0 0;
  gap: 2px;
}
.theme-miniature[data-preview-theme='macos'] .theme-miniature__bar > b {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #fa6158;
  box-shadow:
    6px 0 #fdbc40,
    12px 0 #34c84a;
  margin-right: 15px;
}
.theme-miniature[data-preview-theme='liquid_glass'] {
  background:
    radial-gradient(at 10% 10%, var(--preview-primary), transparent 65%), var(--preview-page);
}
.theme-miniature[data-preview-theme='liquid_glass'] .theme-miniature__nav {
  border-radius: 99px;
}
.theme-miniature[data-preview-theme='smartisan'] .theme-miniature__nav {
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.25);
}
.theme-miniature[data-preview-theme='smartisan'] .theme-miniature__tiles > b {
  border-bottom-width: 2px;
}
.theme-choice__label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 3px 3px;
  font-size: var(--base-font-size);
  color: var(--text-primary);
}
.theme-choice__label i {
  color: var(--primary-color);
}
.theme-choice__dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--preview-primary);
}
.theme-choice__description {
  display: block;
  padding: 0 3px 3px;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
}
.appearance-preferences {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-left: 20px;
  border-left: 1px solid var(--divider-color);
}
.appearance-example {
  display: grid;
  gap: 10px;
  border: 1px solid var(--border-color);
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--surface-muted);
  box-shadow: var(--shadow-sm);
}
.appearance-example__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.appearance-example label {
  font-size: var(--base-font-size);
  color: var(--text-secondary);
}
.appearance-example__actions {
  display: flex;
  gap: 6px;
}
.appearance-example__actions .btn {
  flex: 1;
  padding-inline: 8px;
  white-space: nowrap;
}
.appearance-example__statuses {
  display: flex;
  gap: 6px;
}
.appearance-preference h4 {
  margin-bottom: 8px;
}
.appearance-options {
  display: flex;
  padding: 3px;
  gap: 3px;
  background: var(--surface-muted);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
}
.appearance-options button {
  display: flex;
  flex: 1;
  gap: 5px;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: max(3px, calc(var(--radius-sm) - 3px));
  font-size: var(--base-font-size);
  color: var(--text-secondary);
}
.appearance-options button[aria-pressed='true'] {
  border-color: var(--border-color);
  color: var(--primary-color);
  background: var(--surface-color);
  box-shadow: var(--shadow-sm);
}
.appearance-options button:hover {
  color: var(--primary-color);
}
.appearance-saved {
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  font-size: 14px;
  color: var(--text-secondary);
}
@media (max-width: 760px) {
  .appearance-layout {
    grid-template-columns: 1fr;
    gap: 20px;
  }
  .appearance-preferences {
    padding-left: 0;
    padding-top: 18px;
    border-left: 0;
    border-top: 1px solid var(--divider-color);
  }
}
@media (max-width: 480px) {
  .theme-gallery {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .appearance-saved {
    white-space: nowrap;
    font-size: 14px;
  }
}
</style>
