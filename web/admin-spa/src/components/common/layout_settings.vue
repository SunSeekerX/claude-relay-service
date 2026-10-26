<template>
  <AppDialog
    v-model="themeStore.layoutSettingsOpen"
    icon="i-lucide-panels-top-left"
    size="lg"
    title="后台布局"
  >
    <div ref="content" class="layout-settings">
      <section aria-label="内容宽度">
        <h4>内容宽度</h4>
        <div class="layout-width-options">
          <button
            v-for="option in widthOptions"
            :key="option.value"
            :aria-pressed="themeStore.workspaceWidth === option.value"
            class="layout-width-option"
            type="button"
            @click="themeStore.setWorkspaceWidth(option.value)"
          >
            <span aria-hidden="true" class="layout-width-preview" :class="`is-${option.value}`"
              ><span
            /></span>
            <strong>{{ option.label }}</strong
            ><span>{{ option.description }}</span>
          </button>
        </div>
      </section>
      <section aria-label="主导航位置">
        <h4>主导航位置</h4>
        <SegmentedTabs
          :model-value="themeStore.navigationLayout"
          size="sm"
          :tabs="navigationOptions"
          @update:model-value="themeStore.setNavigationLayout"
        />
        <p>所有主题均可选择顶部或侧边导航，窄屏会自动使用顶部导航。</p>
      </section>
      <section class="layout-fullscreen-row">
        <div>
          <h4>浏览器全屏</h4>
          <p>隐藏浏览器栏，退出后恢复原窗口。</p>
        </div>
        <button
          class="btn btn-secondary"
          :disabled="!fullscreenAvailable"
          type="button"
          @click="toggleFullscreen"
        >
          <i :class="fullscreen ? 'i-lucide-minimize' : 'i-lucide-maximize'" />{{
            fullscreen ? '退出全屏' : '进入全屏'
          }}
        </button>
      </section>
    </div>
    <template #footer
      ><span class="layout-saved">本机自动记忆</span
      ><button class="btn btn-secondary" type="button" @click="themeStore.resetLayout">
        恢复布局默认</button
      ><DialogSaveActions
        :show-cancel="false"
        @save="(closeAfter) => { if (closeAfter) themeStore.layoutSettingsOpen = false }"
      /></template
    >
  </AppDialog>
</template>

<script setup>
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useThemeStore } from '@/stores/theme'
import { showToast } from '@/libs/tools'
import AppDialog from './app_dialog.vue'
import SegmentedTabs from './segmented_tabs.vue'

const themeStore = useThemeStore()
const content = ref(null)
const fullscreen = ref(!!document.fullscreenElement)
const fullscreenAvailable =
  document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function'
const widthOptions = [
  { value: 'focused', label: '居中限宽', description: '1360 px，便于聚焦' },
  { value: 'wide', label: '宽屏布局', description: '1680 px，适合宽表' },
  { value: 'fluid', label: '铺满窗口', description: '使用全部可用宽度' }
]
const navigationOptions = [
  { key: 'auto', label: '跟随主题', icon: 'i-lucide-palette' },
  { key: 'top', label: '顶部导航', icon: 'i-lucide-panel-top' },
  { key: 'sidebar', label: '侧边导航', icon: 'i-lucide-panel-left' }
]
const handleFullscreenChange = () => {
  fullscreen.value = !!document.fullscreenElement
}
const toggleFullscreen = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch (error) {
    console.error('Fullscreen change failed:', error)
    showToast('无法切换全屏，请使用浏览器的全屏快捷键', 'warning')
  }
}
let returnFocus
watch(
  () => themeStore.layoutSettingsOpen,
  async (open) => {
    if (open) {
      returnFocus = document.activeElement
      await nextTick()
      content.value?.closest('[role="dialog"]').querySelector('button')?.focus()
    } else returnFocus?.focus()
  }
)
const handleKeydown = (event) => {
  if (!themeStore.layoutSettingsOpen || event.defaultPrevented) return
  if (event.key === 'Escape') {
    event.preventDefault()
    themeStore.layoutSettingsOpen = false
  }
  if (event.key !== 'Tab') return
  const controls = [
    ...content.value.closest('[role="dialog"]').querySelectorAll('button:not(:disabled)')
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
onMounted(() => {
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  document.addEventListener('keydown', handleKeydown)
})
onUnmounted(() => {
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.layout-settings {
  display: grid;
  gap: 22px;
}
.layout-settings h4 {
  margin: 0 0 10px;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 600;
}
.layout-settings p {
  margin: 9px 0 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
}
.layout-width-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
}
.layout-width-option {
  display: grid;
  gap: 7px;
  padding: 9px;
  min-width: 0;
  white-space: normal;
  text-align: left;
  background: var(--surface-color);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
}
.layout-width-option[aria-pressed='true'] {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 1px var(--primary-color);
}
.layout-width-option strong {
  font-size: 14px;
  color: var(--text-primary);
}
.layout-width-option > span:last-child {
  font-size: 14px;
  color: var(--text-secondary);
}
.layout-width-preview {
  display: flex;
  justify-content: center;
  height: 47px;
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--surface-muted);
}
.layout-width-preview > span {
  display: block;
  width: 57%;
  border: 1px solid var(--primary-color);
  border-radius: 2px;
  background: var(--primary-soft);
}
.layout-width-preview.is-wide > span {
  width: 78%;
}
.layout-width-preview.is-fluid > span {
  width: 100%;
}
.layout-fullscreen-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid var(--divider-color);
}
.layout-fullscreen-row .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.layout-saved {
  margin-right: auto;
  color: var(--text-secondary);
  font-size: 14px;
}
@media (max-width: 479px) {
  .layout-saved {
    display: none;
  }
  .layout-width-options {
    gap: 7px;
  }
  .layout-width-option {
    padding: 7px;
  }
}
</style>
