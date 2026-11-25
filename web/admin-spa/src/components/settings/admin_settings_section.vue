<template>
  <div class="max-w-3xl space-y-5">
    <section class="rounded-xl border p-4" style="border-color: var(--divider-color)">
      <h3 class="mb-2 text-base font-semibold t-text">管理员登录有效期</h3>
      <p class="mb-3 text-sm t-text-secondary">
        默认沿用现有登录设置。自定义时长仅影响之后的新登录，已有登录保持原有效期；登录后每次管理操作按该时长续期。
      </p>
      <p v-if="loginLoading" class="mb-3 text-sm t-text-secondary" role="status">
        正在加载登录设置...
      </p>
      <p v-if="loginError" class="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">
        {{ loginError }}
      </p>
      <form @submit.prevent="saveLogin">
        <fieldset
          class="space-y-3 border-0 p-0"
          :disabled="!loginReady || loginLoading || loginSaving"
        >
          <div class="flex flex-wrap gap-4 text-sm t-text">
            <label class="flex items-center gap-1"
              ><input
                v-model="loginMode"
                name="admin-login-mode"
                type="radio"
                value="default"
              />沿用默认</label
            >
            <label class="flex items-center gap-1"
              ><input
                v-model="loginMode"
                name="admin-login-mode"
                type="radio"
                value="custom"
              />自定义</label
            >
          </div>
          <label class="block text-sm t-text">
            <span class="mb-1 block">登录有效期（小时）</span>
            <input
              v-model.number="loginHours"
              aria-label="登录有效期（小时）"
              class="form-input w-full max-w-xs"
              :disabled="loginMode !== 'custom'"
              max="8760"
              min="1"
              required
              step="1"
              type="number"
            />
            <span class="mt-1 block t-text-secondary">支持 1 至 8760 小时（最多 365 天）。</span>
          </label>
          <div class="flex flex-wrap gap-1">
            <button
              v-for="days in [1, 7, 30, 90]"
              :key="days"
              class="btn btn-secondary px-3 text-sm"
              type="button"
              @click="applyLoginPreset(days)"
            >
              {{ days }} 天
            </button>
          </div>
        </fieldset>
        <div class="mt-4 flex flex-wrap gap-1">
          <button
            class="btn btn-primary px-3 text-sm"
            :disabled="!loginReady || loginLoading || loginSaving"
            type="submit"
          >
            {{ loginSaving ? '保存中...' : '保存登录设置' }}
          </button>
          <button
            class="btn btn-secondary px-3 text-sm"
            :disabled="loginLoading || loginSaving"
            type="button"
            @click="loadLogin"
          >
            重新加载登录设置
          </button>
        </div>
      </form>
    </section>

    <section class="rounded-xl border p-4" style="border-color: var(--divider-color)">
      <h3 class="mb-2 text-base font-semibold t-text">API Key 快捷调整</h3>
      <p class="mb-3 text-sm t-text-secondary">
        配置“快捷调整”弹窗中的额度与天数按钮，按列表顺序显示。每组最多 20
        项，保存后下次打开弹窗生效。
      </p>
      <p v-if="presetsLoading" class="mb-3 text-sm t-text-secondary" role="status">
        正在加载快捷设置...
      </p>
      <p v-if="presetsError" class="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">
        {{ presetsError }}
      </p>
      <form @submit.prevent="savePresets">
        <fieldset
          class="grid grid-cols-1 gap-4 border-0 p-0 lg:grid-cols-2"
          :disabled="!presetsReady || presetsLoading || presetsSaving"
        >
          <QuickAdjustPresetsEditor
            v-model="presets.costPresets"
            label="额度（美元）"
            :maximum="Number.MAX_SAFE_INTEGER / 100"
            :step="0.01"
          />
          <QuickAdjustPresetsEditor
            v-model="presets.extendPresets"
            label="有效期（天）"
            :maximum="36500"
            :step="1"
          />
        </fieldset>
        <div class="mt-4 flex flex-wrap gap-1">
          <button
            class="btn btn-primary px-3 text-sm"
            :disabled="!presetsReady || presetsLoading || presetsSaving"
            type="submit"
          >
            {{ presetsSaving ? '保存中...' : '保存快捷设置' }}
          </button>
          <button
            class="btn btn-secondary px-3 text-sm"
            :disabled="presetsLoading || presetsSaving"
            type="button"
            @click="loadPresets"
          >
            重新加载快捷设置
          </button>
        </div>
      </form>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import QuickAdjustPresetsEditor from './quick_adjust_presets_editor.vue'
import {
  getAdminLoginSettingsApi,
  saveAdminLoginSettingsApi,
  getApiKeyQuickAdjustSettingsApi,
  saveApiKeyQuickAdjustSettingsApi
} from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast } from '@/libs/tools'

const controller = new AbortController()
const loginLoading = ref(false)
const loginSaving = ref(false)
const loginReady = ref(false)
const loginError = ref('')
const loginMode = ref('default')
const loginHours = ref(24)
const presetsLoading = ref(false)
const presetsSaving = ref(false)
const presetsReady = ref(false)
const presetsError = ref('')
const presets = ref({ costPresets: [], extendPresets: [] })

const applyLoginPreset = (days) => {
  loginMode.value = 'custom'
  loginHours.value = days * 24
}

const applyLogin = (data) => {
  loginMode.value = data.sessionTimeoutHours === null ? 'default' : 'custom'
  loginHours.value = data.sessionTimeoutHours ?? 24
}

const loadLogin = async () => {
  loginLoading.value = true
  loginError.value = ''
  try {
    const response = await getAdminLoginSettingsApi({ signal: controller.signal })
    if (controller.signal.aborted) return
    if (!isOk(response)) throw new Error(msgOf(response, '加载登录设置失败'))
    applyLogin(response.data)
    loginReady.value = true
  } catch (error) {
    if (controller.signal.aborted) return
    loginReady.value = false
    loginError.value = error.message
  } finally {
    loginLoading.value = false
  }
}

const loadPresets = async () => {
  presetsLoading.value = true
  presetsError.value = ''
  try {
    const response = await getApiKeyQuickAdjustSettingsApi({ signal: controller.signal })
    if (controller.signal.aborted) return
    if (!isOk(response)) throw new Error(msgOf(response, '加载快捷设置失败'))
    presets.value = response.data
    presetsReady.value = true
  } catch (error) {
    if (controller.signal.aborted) return
    presetsReady.value = false
    presetsError.value = error.message
  } finally {
    presetsLoading.value = false
  }
}

const saveLogin = async () => {
  if (!loginReady.value || loginLoading.value || loginSaving.value) return
  loginSaving.value = true
  loginError.value = ''
  try {
    const response = await saveAdminLoginSettingsApi(
      { sessionTimeoutHours: loginMode.value === 'default' ? null : loginHours.value },
      { signal: controller.signal }
    )
    if (controller.signal.aborted) return
    if (!isOk(response)) throw new Error(msgOf(response, '保存登录设置失败'))
    applyLogin(response.data)
    showToast('登录设置已保存，下次登录生效', 'success')
  } catch (error) {
    if (!controller.signal.aborted) loginError.value = error.message
  } finally {
    loginSaving.value = false
  }
}

const savePresets = async () => {
  if (!presetsReady.value || presetsLoading.value || presetsSaving.value) return
  presetsSaving.value = true
  presetsError.value = ''
  try {
    const response = await saveApiKeyQuickAdjustSettingsApi(presets.value, {
      signal: controller.signal
    })
    if (controller.signal.aborted) return
    if (!isOk(response)) throw new Error(msgOf(response, '保存快捷设置失败'))
    presets.value = response.data
    showToast('快捷设置已保存', 'success')
  } catch (error) {
    if (!controller.signal.aborted) presetsError.value = error.message
  } finally {
    presetsSaving.value = false
  }
}

onMounted(() => {
  loadLogin()
  loadPresets()
})
onBeforeUnmount(() => controller.abort())
</script>
