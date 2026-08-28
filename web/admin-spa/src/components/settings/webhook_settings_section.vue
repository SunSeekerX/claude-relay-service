<template>
  <div class="webhook-settings max-w-3xl">
    <div v-if="loading" class="py-12 text-center">
      <div class="loading-spinner mx-auto mb-4"></div>
      <p class="t-text-secondary text-sm">正在加载通知设置...</p>
    </div>

    <template v-else>
      <!-- 总开关 -->
      <div class="t-setting-stack">
        <div class="t-setting-row sm:items-center">
          <div class="t-setting-row__label">
            <div class="t-setting-row__title">启用通知</div>
            <p class="t-setting-row__desc">开启后按下方配置推送到各渠道</p>
          </div>
          <div class="t-setting-row__control flex items-center gap-3">
            <AppSwitch
              :model-value="!!webhookConfig.enabled"
              color="blue"
              size="md"
              title="启用通知"
              @change="onEnabledChange"
            />
            <span class="text-sm text-gray-600 dark:text-gray-300">
              {{ webhookConfig.enabled ? '已启用' : '已关闭' }}
            </span>
          </div>
        </div>
      </div>

      <!-- 通知事件：整宽模块 -->
      <section class="wh-section">
        <div class="wh-section__head">
          <div>
            <h3 class="wh-section__title">通知事件</h3>
            <p class="wh-section__desc">选择需要推送的事件类型</p>
          </div>
        </div>
        <div class="wh-type-list">
          <div
            v-for="type in notificationTypeKeys"
            :key="type"
            class="wh-type-row"
          >
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-gray-900 dark:text-gray-100">
                {{ getNotificationTypeName(type) }}
              </div>
              <div class="t-text-secondary text-sm">
                {{ getNotificationTypeDescription(type) }}
              </div>
            </div>
            <AppSwitch
              :model-value="!!webhookConfig.notificationTypes[type]"
              color="blue"
              size="sm"
              :title="getNotificationTypeName(type)"
              @change="(value) => onNotificationTypeChange(type, value)"
            />
          </div>
        </div>
      </section>

      <!-- 通知渠道：整宽模块 -->
      <section class="wh-section">
        <div class="wh-section__head">
          <div>
            <h3 class="wh-section__title">通知渠道</h3>
            <p class="wh-section__desc">企业微信 / 钉钉 / 飞书 / Telegram 等</p>
          </div>
          <button class="btn btn-primary h-8 px-3 text-sm" type="button" @click="openAddPlatform">
            <i class="i-lucide-plus mr-1.5"></i>
            添加
          </button>
        </div>

        <div v-if="platforms.length > 0" class="wh-platform-list">
          <div
            v-for="platform in platforms"
            :key="platform.id"
            class="wh-platform-row"
          >
            <div
              class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 dark:bg-gray-700"
            >
              <i class="text-sm" :class="getPlatformIcon(platform.type)"></i>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span class="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                  {{ platform.name || getPlatformName(platform.type) }}
                </span>
                <span class="t-text-secondary text-sm">{{ getPlatformName(platform.type) }}</span>
                <span
                  v-if="platform.enableSign"
                  class="t-text-secondary text-sm"
                  title="已启用签名验证"
                >· 签名</span>
              </div>
              <div class="truncate t-text-secondary text-sm">
                {{ getPlatformSummary(platform) }}
              </div>
            </div>
            <AppSwitch
              :model-value="!!platform.enabled"
              color="blue"
              size="sm"
              title="启用渠道"
              @change="() => togglePlatform(platform.id)"
            />
            <ActionDropdown :actions="platformActions(platform)" />
          </div>
        </div>

        <div v-else class="wh-empty">
          <p class="t-text-secondary text-sm">暂无通知渠道</p>
          <button class="btn btn-primary mt-3 h-8 px-3 text-sm" type="button" @click="openAddPlatform">
            <i class="i-lucide-plus mr-1.5"></i>
            添加渠道
          </button>
        </div>
      </section>

      <!-- 高级：默认折叠 -->
      <section class="wh-section">
        <button class="wh-section__head wh-section__head--btn" type="button" @click="advancedOpen = !advancedOpen">
          <div class="text-left">
            <h3 class="wh-section__title">高级</h3>
            <p class="wh-section__desc">重试次数、延迟与超时</p>
          </div>
          <i
            class="i-lucide-chevron-down text-gray-400 transition-transform"
            :class="{ 'rotate-180': advancedOpen }"
          ></i>
        </button>
        <div v-show="advancedOpen" class="wh-advanced-grid">
          <label class="wh-field">
            <span class="wh-field__label">最大重试</span>
            <input
              v-model.number="webhookConfig.retrySettings.maxRetries"
              class="form-input"
              max="10"
              min="0"
              type="number"
              @change="onRetrySettingsChange"
            />
          </label>
          <label class="wh-field">
            <span class="wh-field__label">重试延迟 (ms)</span>
            <input
              v-model.number="webhookConfig.retrySettings.retryDelay"
              class="form-input"
              max="10000"
              min="100"
              step="100"
              type="number"
              @change="onRetrySettingsChange"
            />
          </label>
          <label class="wh-field">
            <span class="wh-field__label">超时 (ms)</span>
            <input
              v-model.number="webhookConfig.retrySettings.timeout"
              class="form-input"
              max="30000"
              min="1000"
              step="1000"
              type="number"
              @change="onRetrySettingsChange"
            />
          </label>
        </div>
      </section>

      <div class="mt-5">
        <button class="btn btn-secondary h-8 px-3 text-sm" type="button" @click="sendTestNotification">
          <i class="i-lucide-send mr-1.5"></i>
          发送测试通知
        </button>
      </div>
    </template>

    <!-- 添加/编辑渠道 -->
    <ModalTransition>
      <div
        v-if="showPlatformModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        @click="closePlatformModal"
      >
        <div
          class="modal-panel flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-gray-800"
          @click.stop
        >
          <div
            class="flex flex-shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700"
          >
            <div>
              <h3 class="text-base font-semibold text-gray-900 dark:text-white">
                {{ editingPlatform ? '编辑渠道' : '添加渠道' }}
              </h3>
              <p class="t-text-secondary text-sm">配置 Webhook 推送目标</p>
            </div>
            <button
              class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              type="button"
              @click="closePlatformModal"
            >
              <i class="i-lucide-x text-lg"></i>
            </button>
          </div>

          <div class="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div class="space-y-4">
              <div>
                <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  平台类型
                </label>
                <CustomDropdown
                  v-model="platformForm.type"
                  accent="blue"
                  class="w-full"
                  :disabled="!!editingPlatform"
                  :options="platformTypeOptions"
                  placeholder="选择平台类型"
                />
                <p v-if="editingPlatform" class="mt-1 text-sm text-amber-600 dark:text-amber-400">
                  编辑时不可更改类型
                </p>
              </div>

              <div>
                <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  名称
                  <span class="font-normal text-gray-400">可选</span>
                </label>
                <input
                  v-model="platformForm.name"
                  class="form-input w-full"
                  placeholder="例如：运维群"
                  type="text"
                />
              </div>

              <div
                v-if="
                  platformForm.type !== 'bark' &&
                  platformForm.type !== 'smtp' &&
                  platformForm.type !== 'telegram'
                "
              >
                <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Webhook URL
                  <span class="text-red-500">*</span>
                </label>
                <div class="relative">
                  <input
                    v-model="platformForm.url"
                    class="form-input w-full pr-9"
                    :class="{
                      'border-red-500 focus:border-red-500 focus:ring-red-500/20': urlError,
                      'border-green-500 focus:border-green-500 focus:ring-green-500/20': urlValid
                    }"
                    placeholder="https://..."
                    type="url"
                    @input="validateUrl"
                  />
                  <div
                    v-if="urlValid || urlError"
                    class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3"
                  >
                    <i
                      v-if="urlValid"
                      class="i-lucide-circle-check text-green-500"
                    ></i>
                    <i
                      v-else
                      class="i-lucide-circle-alert text-red-500"
                    ></i>
                  </div>
                </div>
                <p v-if="getWebhookHint(platformForm.type)" class="mt-1 t-text-secondary text-sm">
                  {{ getWebhookHint(platformForm.type) }}
                </p>
              </div>

              <template v-if="platformForm.type === 'telegram'">
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Bot Token
                    <span class="text-red-500">*</span>
                  </label>
                  <input
                    v-model="platformForm.botToken"
                    class="form-input w-full"
                    placeholder="123456789:ABCDEFghijk-xyz"
                    type="text"
                  />
                  <p class="mt-1 t-text-secondary text-sm">@BotFather 创建机器人后获得</p>
                </div>
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Chat ID
                    <span class="text-red-500">*</span>
                  </label>
                  <input
                    v-model="platformForm.chatId"
                    class="form-input w-full"
                    placeholder="123456789 或 -1001234567890"
                    type="text"
                  />
                </div>
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    API 基础地址
                    <span class="font-normal text-gray-400">可选</span>
                  </label>
                  <input
                    v-model="platformForm.apiBaseUrl"
                    class="form-input w-full"
                    placeholder="默认 https://api.telegram.org"
                    type="url"
                  />
                </div>
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    代理地址
                    <span class="font-normal text-gray-400">可选</span>
                  </label>
                  <input
                    v-model="platformForm.proxyUrl"
                    class="form-input w-full"
                    placeholder="socks5://127.0.0.1:1080"
                    type="text"
                  />
                </div>
              </template>

              <template v-if="platformForm.type === 'bark'">
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    设备密钥
                    <span class="text-red-500">*</span>
                  </label>
                  <input
                    v-model="platformForm.deviceKey"
                    class="form-input w-full"
                    placeholder="Bark Device Key"
                    type="text"
                  />
                </div>
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    服务器地址
                    <span class="font-normal text-gray-400">可选</span>
                  </label>
                  <input
                    v-model="platformForm.serverUrl"
                    class="form-input w-full"
                    placeholder="默认 https://api.day.app/push"
                    type="url"
                  />
                </div>
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    通知级别
                  </label>
                  <CustomDropdown
                    v-model="platformForm.level"
                    accent="blue"
                    class="w-full"
                    :options="barkLevelOptions"
                    placeholder="选择通知级别"
                  />
                </div>
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    通知声音
                  </label>
                  <CustomDropdown
                    v-model="platformForm.sound"
                    accent="blue"
                    class="w-full"
                    :options="barkSoundOptions"
                    placeholder="选择通知声音"
                  />
                </div>
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    通知分组
                    <span class="font-normal text-gray-400">可选</span>
                  </label>
                  <input
                    v-model="platformForm.group"
                    class="form-input w-full"
                    placeholder="默认 claude-relay"
                    type="text"
                  />
                </div>
              </template>

              <template v-if="platformForm.type === 'smtp'">
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    SMTP 服务器
                    <span class="text-red-500">*</span>
                  </label>
                  <input
                    v-model="platformForm.host"
                    class="form-input w-full"
                    placeholder="smtp.example.com"
                    type="text"
                  />
                </div>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                      端口
                    </label>
                    <input
                      v-model.number="platformForm.port"
                      class="form-input w-full"
                      max="65535"
                      min="1"
                      placeholder="587"
                      type="number"
                    />
                  </div>
                  <div>
                    <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                      加密方式
                    </label>
                    <CustomDropdown
                      v-model="platformForm.secure"
                      accent="blue"
                      class="w-full"
                      :options="smtpSecureOptions"
                      placeholder="选择加密方式"
                    />
                  </div>
                </div>
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    用户名
                    <span class="text-red-500">*</span>
                  </label>
                  <input
                    v-model="platformForm.user"
                    class="form-input w-full"
                    type="text"
                  />
                </div>
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    密码
                    <span class="text-red-500">*</span>
                  </label>
                  <input
                    v-model="platformForm.pass"
                    class="form-input w-full"
                    type="password"
                  />
                </div>
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    发件人
                    <span class="font-normal text-gray-400">可选</span>
                  </label>
                  <input
                    v-model="platformForm.from"
                    class="form-input w-full"
                    placeholder="默认使用用户名"
                    type="email"
                  />
                </div>
                <div>
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    收件人
                    <span class="text-red-500">*</span>
                  </label>
                  <input
                    v-model="platformForm.to"
                    class="form-input w-full"
                    placeholder="admin@example.com"
                    type="text"
                  />
                </div>
              </template>

              <div
                v-if="platformForm.type === 'dingtalk' || platformForm.type === 'feishu'"
                class="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
              >
                <div class="flex items-center justify-between gap-3">
                  <span class="text-sm font-medium text-gray-700 dark:text-gray-300">签名验证</span>
                  <AppSwitch v-model="platformForm.enableSign" color="blue" size="sm" />
                </div>
                <div v-if="platformForm.enableSign">
                  <label class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    签名密钥
                  </label>
                  <input
                    v-model="platformForm.secret"
                    class="form-input w-full"
                    placeholder="SEC..."
                    type="text"
                  />
                </div>
              </div>
            </div>
          </div>

          <div
            class="flex flex-shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-200 px-4 py-3 dark:border-gray-700"
          >
            <button class="btn btn-secondary h-8 px-3 text-sm" type="button" @click="closePlatformModal">
              取消
            </button>
            <button
              class="btn btn-secondary h-8 px-3 text-sm"
              type="button"
              :disabled="testingConnection"
              @click="testPlatformForm"
            >
              <i
                class="mr-1.5"
                :class="
                  testingConnection
                    ? 'i-lucide-loader-circle animate-spin'
                    : 'i-lucide-flask-conical'
                "
              ></i>
              {{ testingConnection ? '测试中...' : '测试' }}
            </button>
            <button
              class="btn btn-primary h-8 px-3 text-sm"
              type="button"
              :disabled="!isPlatformFormValid || savingPlatform"
              @click="savePlatform"
            >
              <i
                class="mr-1.5"
                :class="
                  savingPlatform ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-save'
                "
              ></i>
              {{ savingPlatform ? '保存中...' : editingPlatform ? '保存' : '添加' }}
            </button>
          </div>
        </div>
      </div>
    </ModalTransition>

    <ConfirmModal
      :cancel-text="confirmModalConfig.cancelText"
      :confirm-text="confirmModalConfig.confirmText"
      :message="confirmModalConfig.message"
      :show="showConfirmModal"
      :title="confirmModalConfig.title"
      :type="confirmModalConfig.type"
      @cancel="handleCancelModal"
      @confirm="handleConfirmModal"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

import { showToast } from '@/libs/tools'
import { isOk, dataOf, msgOf } from '@/libs/http_envelope'
import * as httpApis from '@/libs/http_apis'
import AppSwitch from '@/components/common/app_switch.vue'
import ActionDropdown from '@/components/common/action_dropdown.vue'
import ConfirmModal from '@/components/common/confirm_modal.vue'
import ModalTransition from '@/components/common/modal_transition.vue'

const DEFAULT_NOTIFICATION_TYPES = {
  accountAnomaly: true,
  quotaWarning: true,
  systemError: true,
  securityAlert: true,
  rateLimitRecovery: true,
  test: true
}

const NOTIFICATION_TYPE_META = {
  accountAnomaly: { name: '账号异常', description: '账号状态异常、认证失败等' },
  quotaWarning: { name: '配额警告', description: 'API 调用配额不足' },
  systemError: { name: '系统错误', description: '系统运行错误和故障' },
  securityAlert: { name: '安全警报', description: '安全相关警报' },
  rateLimitRecovery: { name: '限流恢复', description: '限流状态恢复时提醒' },
  test: { name: '测试通知', description: '用于测试连接' }
}

const PLATFORM_NAMES = {
  wechat_work: '企业微信',
  dingtalk: '钉钉',
  feishu: '飞书',
  slack: 'Slack',
  discord: 'Discord',
  telegram: 'Telegram',
  bark: 'Bark',
  smtp: '邮件通知',
  custom: '自定义'
}

const PLATFORM_ICONS = {
  wechat_work: 'i-si-wechat text-green-600',
  dingtalk: 'i-lucide-message-circle text-blue-500',
  feishu: 'i-lucide-bird text-blue-600',
  slack: 'i-logos-slack-icon text-purple-600',
  discord: 'i-logos-discord-icon text-indigo-600',
  telegram: 'i-logos-telegram text-sky-500',
  bark: 'i-lucide-bell text-orange-500',
  smtp: 'i-lucide-mail text-blue-600',
  custom: 'i-lucide-webhook text-gray-600'
}

const WEBHOOK_HINTS = {
  wechat_work: '在企业微信群机器人设置中获取 Webhook 地址',
  dingtalk: '在钉钉群机器人设置中获取 Webhook 地址',
  feishu: '在飞书群机器人设置中获取 Webhook 地址',
  slack: '在 Slack Incoming Webhooks 中获取地址',
  discord: '在 Discord 服务器集成中创建 Webhook',
  telegram: 'BotFather 获取 Token；Chat ID 可用相关 bot 查询',
  bark: '在 Bark App 中查看设备密钥',
  smtp: '支持常见邮箱 SMTP',
  custom: '填写完整的 Webhook 接收地址'
}

const platformTypeOptions = [
  { value: 'wechat_work', label: '企业微信' },
  { value: 'dingtalk', label: '钉钉' },
  { value: 'feishu', label: '飞书' },
  { value: 'slack', label: 'Slack' },
  { value: 'discord', label: 'Discord' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'bark', label: 'Bark' },
  { value: 'smtp', label: '邮件通知' },
  { value: 'custom', label: '自定义' }
]

const barkLevelOptions = [
  { value: '', label: '自动（按通知类型）' },
  { value: 'passive', label: '被动' },
  { value: 'active', label: '默认' },
  { value: 'timeSensitive', label: '时效性' },
  { value: 'critical', label: '紧急' }
]

const barkSoundOptions = [
  { value: '', label: '自动（按通知类型）' },
  { value: 'default', label: '默认' },
  { value: 'alarm', label: '警报' },
  { value: 'bell', label: '铃声' },
  { value: 'birdsong', label: '鸟鸣' },
  { value: 'electronic', label: '电子音' },
  { value: 'glass', label: '玻璃' },
  { value: 'horn', label: '喇叭' },
  { value: 'silence', label: '静音' }
]

const smtpSecureOptions = [
  { value: false, label: 'STARTTLS (587)' },
  { value: true, label: 'SSL/TLS (465)' }
]

const emptyPlatformForm = () => ({
  type: 'wechat_work',
  name: '',
  url: '',
  enableSign: false,
  secret: '',
  botToken: '',
  chatId: '',
  apiBaseUrl: '',
  proxyUrl: '',
  deviceKey: '',
  serverUrl: '',
  level: '',
  sound: '',
  group: '',
  host: '',
  port: null,
  secure: false,
  user: '',
  pass: '',
  from: '',
  to: '',
  timeout: null,
  ignoreTLS: false
})

const isMounted = ref(true)
const abortController = ref(new AbortController())
const loading = ref(true)
const advancedOpen = ref(false)
const showPlatformModal = ref(false)
const editingPlatform = ref(null)
const urlError = ref(false)
const urlValid = ref(false)
const testingConnection = ref(false)
const savingPlatform = ref(false)
const platformForm = ref(emptyPlatformForm())

const webhookConfig = ref({
  enabled: false,
  platforms: [],
  notificationTypes: { ...DEFAULT_NOTIFICATION_TYPES },
  retrySettings: {
    maxRetries: 3,
    retryDelay: 1000,
    timeout: 10000
  }
})

const showConfirmModal = ref(false)
const confirmModalConfig = ref({
  title: '',
  message: '',
  type: 'primary',
  confirmText: '确认',
  cancelText: '取消'
})
const confirmResolve = ref(null)

const platforms = computed(() => webhookConfig.value.platforms || [])

const notificationTypeKeys = computed(() => {
  const ordered = Object.keys(DEFAULT_NOTIFICATION_TYPES)
  const extra = Object.keys(webhookConfig.value.notificationTypes || {}).filter(
    (key) => !ordered.includes(key)
  )
  return [...ordered, ...extra]
})

const isPlatformFormValid = computed(() => {
  if (platformForm.value.type === 'bark') return !!platformForm.value.deviceKey
  if (platformForm.value.type === 'telegram') {
    return !!(platformForm.value.botToken && platformForm.value.chatId)
  }
  if (platformForm.value.type === 'smtp') {
    return !!(
      platformForm.value.host &&
      platformForm.value.user &&
      platformForm.value.pass &&
      platformForm.value.to
    )
  }
  return !!platformForm.value.url && !urlError.value
})

const showConfirm = (title, message, confirmText = '确认', cancelText = '取消', type = 'primary') => {
  return new Promise((resolve) => {
    confirmModalConfig.value = { title, message, confirmText, cancelText, type }
    confirmResolve.value = resolve
    showConfirmModal.value = true
  })
}

const handleConfirmModal = () => {
  showConfirmModal.value = false
  const resolve = confirmResolve.value
  confirmResolve.value = null
  resolve?.(true)
}

const handleCancelModal = () => {
  showConfirmModal.value = false
  const resolve = confirmResolve.value
  confirmResolve.value = null
  resolve?.(false)
}

const getNotificationTypeName = (type) => NOTIFICATION_TYPE_META[type]?.name || type
const getNotificationTypeDescription = (type) => NOTIFICATION_TYPE_META[type]?.description || ''
const getPlatformName = (type) => PLATFORM_NAMES[type] || type
const getPlatformIcon = (type) => PLATFORM_ICONS[type] || 'i-lucide-bell'
const getWebhookHint = (type) => WEBHOOK_HINTS[type] || ''

// Telegram botToken / Bark deviceKey 等同敏感凭据，列表只展示掩码
// 短串（含 Bark 可保存的 <20 长度）绝不能用「前N+后N」露出绝大部分正文
const formatSecretToken = (token) => {
  if (!token) return ''
  const text = String(token)
  const length = text.length
  // <=12：全星，不留明文片段
  if (length <= 12) return '*'.repeat(length)
  // 13–20：只露首尾各 1，中间全隐
  if (length <= 20) return `${text.slice(0, 1)}${'*'.repeat(length - 2)}${text.slice(-1)}`
  // >20：前 4 + 后 4，中间省略（常规 Bark/Telegram token 长度）
  return `${text.slice(0, 4)}...${text.slice(-4)}`
}

const getPlatformSummary = (platform) => {
  if (platform.type === 'telegram') {
    const parts = []
    if (platform.chatId) parts.push(`Chat ${platform.chatId}`)
    if (platform.botToken) parts.push(formatSecretToken(platform.botToken))
    return parts.join(' · ') || '未配置'
  }
  if (platform.type === 'smtp') {
    const to = Array.isArray(platform.to) ? platform.to.join(', ') : platform.to
    return to || platform.host || '未配置'
  }
  if (platform.type === 'bark') {
    return platform.deviceKey ? formatSecretToken(platform.deviceKey) : '未配置'
  }
  return platform.url || '未配置'
}

const platformActions = (platform) => [
  {
    key: 'test',
    label: '测试',
    icon: 'i-lucide-flask-conical',
    color: 'blue',
    handler: () => testPlatform(platform)
  },
  {
    key: 'edit',
    label: '编辑',
    icon: 'i-lucide-pen-line',
    color: 'gray',
    handler: () => editPlatform(platform)
  },
  {
    key: 'delete',
    label: '删除',
    icon: 'i-lucide-trash-2',
    color: 'red',
    handler: () => deletePlatform(platform.id)
  }
]

const loadWebhookConfig = async () => {
  if (!isMounted.value) return
  try {
    const response = await httpApis.getWebhookConfigApi({
      signal: abortController.value.signal
    })
    if (!isMounted.value) return
    if (isOk(response)) {
      const config = dataOf(response)?.config || {}
      webhookConfig.value = {
        ...config,
        notificationTypes: {
          ...DEFAULT_NOTIFICATION_TYPES,
          ...(config.notificationTypes || {})
        },
        retrySettings: {
          maxRetries: 3,
          retryDelay: 1000,
          timeout: 10000,
          ...(config.retrySettings || {})
        },
        platforms: config.platforms || []
      }
    } else {
      showToast(msgOf(response, '获取通知配置失败'), 'error')
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    showToast('获取通知配置失败', 'error')
    console.error(error)
  }
}

// 只提交全局设置字段，不带 platforms（后端也不会用全量快照覆盖渠道）
const buildSettingsPayload = () => ({
  enabled: !!webhookConfig.value.enabled,
  notificationTypes: {
    ...DEFAULT_NOTIFICATION_TYPES,
    ...(webhookConfig.value.notificationTypes || {})
  },
  retrySettings: {
    maxRetries: 3,
    retryDelay: 1000,
    timeout: 10000,
    ...(webhookConfig.value.retrySettings || {})
  }
})

// 前端也串行化设置保存，避免开关连点时本地状态互相覆盖
let settingsSaveChain = Promise.resolve()

const saveWebhookConfig = async (options = {}) => {
  if (!isMounted.value) return false
  const silent = options.silent === true

  const run = async () => {
    try {
      const payload = buildSettingsPayload()
      const response = await httpApis.updateWebhookConfigApi(payload, {
        signal: abortController.value.signal
      })
      if (!isMounted.value) return false
      if (isOk(response)) {
        const saved = dataOf(response)?.config
        if (saved) {
          webhookConfig.value = {
            ...webhookConfig.value,
            enabled: saved.enabled,
            notificationTypes: {
              ...DEFAULT_NOTIFICATION_TYPES,
              ...(saved.notificationTypes || {})
            },
            retrySettings: {
              maxRetries: 3,
              retryDelay: 1000,
              timeout: 10000,
              ...(saved.retrySettings || {})
            },
            // 渠道以服务端为准（设置保存本就不改 platforms，这里同步最新）
            platforms: Array.isArray(saved.platforms)
              ? saved.platforms
              : webhookConfig.value.platforms
          }
        } else {
          webhookConfig.value = {
            ...webhookConfig.value,
            ...payload
          }
        }
        if (!silent) showToast('配置已保存', 'success')
        return true
      }
      showToast(msgOf(response, '保存配置失败'), 'error')
      return false
    } catch (error) {
      if (error.name === 'AbortError') return false
      if (!isMounted.value) return false
      showToast(error.message || '保存配置失败', 'error')
      console.error(error)
      return false
    }
  }

  const pending = settingsSaveChain.then(run, run)
  settingsSaveChain = pending.then(
    () => undefined,
    () => undefined
  )
  return pending
}

const onEnabledChange = async (value) => {
  webhookConfig.value.enabled = value
  const ok = await saveWebhookConfig({ silent: true })
  if (!ok) {
    webhookConfig.value.enabled = !value
  }
}

const onNotificationTypeChange = async (type, value) => {
  const previous = webhookConfig.value.notificationTypes[type]
  webhookConfig.value.notificationTypes[type] = value
  const ok = await saveWebhookConfig({ silent: true })
  if (!ok) {
    webhookConfig.value.notificationTypes[type] = previous
  }
}

const onRetrySettingsChange = async () => {
  const previous = { ...(webhookConfig.value.retrySettings || {}) }
  const ok = await saveWebhookConfig({ silent: true })
  if (!ok) {
    webhookConfig.value.retrySettings = previous
  }
}

const openAddPlatform = () => {
  editingPlatform.value = null
  platformForm.value = emptyPlatformForm()
  urlError.value = false
  urlValid.value = false
  showPlatformModal.value = true
}

const editPlatform = (platform) => {
  editingPlatform.value = platform
  platformForm.value = {
    type: platform.type || 'wechat_work',
    name: platform.name || '',
    url: platform.url || '',
    enableSign: platform.enableSign || false,
    secret: platform.secret || '',
    botToken: platform.botToken || '',
    chatId: platform.chatId || '',
    apiBaseUrl: platform.apiBaseUrl || '',
    proxyUrl: platform.proxyUrl || '',
    deviceKey: platform.deviceKey || '',
    serverUrl: platform.serverUrl || '',
    level: platform.level || '',
    sound: platform.sound || '',
    group: platform.group || '',
    host: platform.host || '',
    port: platform.port ?? null,
    secure: platform.secure || false,
    user: platform.user || '',
    pass: platform.pass || '',
    from: platform.from || '',
    to: Array.isArray(platform.to) ? platform.to.join(', ') : platform.to || '',
    timeout: platform.timeout ?? null,
    ignoreTLS: platform.ignoreTLS || false
  }
  urlError.value = false
  urlValid.value = false
  if (platformForm.value.url) validateUrl()
  showPlatformModal.value = true
}

const closePlatformModal = () => {
  if (!isMounted.value) return
  showPlatformModal.value = false
  setTimeout(() => {
    if (!isMounted.value) return
    editingPlatform.value = null
    platformForm.value = emptyPlatformForm()
    urlError.value = false
    urlValid.value = false
    testingConnection.value = false
    savingPlatform.value = false
  }, 0)
}

const validateUrl = () => {
  if (['bark', 'smtp', 'telegram'].includes(platformForm.value.type)) {
    urlError.value = false
    urlValid.value = false
    return
  }
  const url = platformForm.value.url
  if (!url) {
    urlError.value = false
    urlValid.value = false
    return
  }
  try {
    new URL(url)
    if (url.startsWith('http://') || url.startsWith('https://')) {
      urlError.value = false
      urlValid.value = true
    } else {
      urlError.value = true
      urlValid.value = false
    }
  } catch {
    urlError.value = true
    urlValid.value = false
  }
}

const validatePlatformForm = () => {
  if (platformForm.value.type === 'bark') {
    if (!platformForm.value.deviceKey) {
      showToast('请输入 Bark 设备密钥', 'error')
      return false
    }
  } else if (platformForm.value.type === 'telegram') {
    if (!platformForm.value.botToken) {
      showToast('请输入 Telegram Bot Token', 'error')
      return false
    }
    if (!platformForm.value.chatId) {
      showToast('请输入 Telegram Chat ID', 'error')
      return false
    }
    if (platformForm.value.apiBaseUrl) {
      try {
        const parsed = new URL(platformForm.value.apiBaseUrl)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          showToast('Telegram API 基础地址仅支持 http 或 https', 'error')
          return false
        }
      } catch (error) {
        showToast('请输入有效的 Telegram API 基础地址', 'error')
        console.error(error)
        return false
      }
    }
    if (platformForm.value.proxyUrl) {
      try {
        const parsed = new URL(platformForm.value.proxyUrl)
        const supportedProtocols = ['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:']
        if (!supportedProtocols.includes(parsed.protocol)) {
          showToast('Telegram 代理仅支持 http/https/socks', 'error')
          return false
        }
      } catch (error) {
        showToast('请输入有效的 Telegram 代理地址', 'error')
        console.error(error)
        return false
      }
    }
  } else if (platformForm.value.type === 'smtp') {
    const requiredFields = [
      { field: 'host', message: 'SMTP 服务器' },
      { field: 'user', message: '用户名' },
      { field: 'pass', message: '密码' },
      { field: 'to', message: '收件人邮箱' }
    ]
    for (const { field, message } of requiredFields) {
      if (!platformForm.value[field]) {
        showToast(`请输入${message}`, 'error')
        return false
      }
    }
  } else {
    if (!platformForm.value.url) {
      showToast('请输入 Webhook URL', 'error')
      return false
    }
    if (urlError.value) {
      showToast('请输入有效的 Webhook URL', 'error')
      return false
    }
  }
  return true
}

const savePlatform = async () => {
  if (!isMounted.value) return
  if (!validatePlatformForm()) return
  savingPlatform.value = true
  try {
    let response
    if (editingPlatform.value) {
      response = await httpApis.updateWebhookPlatformApi(
        editingPlatform.value.id,
        platformForm.value,
        { signal: abortController.value.signal }
      )
    } else {
      response = await httpApis.createWebhookPlatformApi(platformForm.value, {
        signal: abortController.value.signal
      })
    }
    if (!isMounted.value) return
    if (isOk(response)) {
      showToast(editingPlatform.value ? '渠道已更新' : '渠道已添加', 'success')
      await loadWebhookConfig()
      closePlatformModal()
    } else {
      showToast(msgOf(response, editingPlatform.value ? '更新渠道失败' : '添加渠道失败'), 'error')
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    showToast(error.message || '操作失败', 'error')
    console.error(error)
  } finally {
    if (isMounted.value) savingPlatform.value = false
  }
}

const deletePlatform = async (id) => {
  if (!isMounted.value) return
  if (!(await showConfirm('删除渠道', '确定删除这个通知渠道？', '删除', '取消', 'danger'))) {
    return
  }
  try {
    const response = await httpApis.deleteWebhookPlatformApi(id, {
      signal: abortController.value.signal
    })
    if (!isMounted.value) return
    if (isOk(response)) {
      showToast('渠道已删除', 'success')
      await loadWebhookConfig()
    } else {
      showToast(msgOf(response, '删除失败'), 'error')
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    showToast('删除失败', 'error')
    console.error(error)
  }
}

const togglePlatform = async (id) => {
  if (!isMounted.value) return
  try {
    const response = await httpApis.toggleWebhookPlatformApi(id, {
      signal: abortController.value.signal
    })
    if (!isMounted.value) return
    if (isOk(response)) {
      await loadWebhookConfig()
    } else {
      showToast(msgOf(response, '切换渠道状态失败'), 'error')
      await loadWebhookConfig()
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    showToast('操作失败', 'error')
    console.error(error)
    await loadWebhookConfig()
  }
}

const buildTestPayload = (source) => {
  const testData = {
    type: source.type,
    secret: source.secret,
    enableSign: source.enableSign
  }
  if (source.type === 'bark') {
    testData.deviceKey = source.deviceKey
    testData.serverUrl = source.serverUrl
    testData.level = source.level
    testData.sound = source.sound
    testData.group = source.group
  } else if (source.type === 'smtp') {
    testData.host = source.host
    testData.port = source.port
    testData.secure = source.secure
    testData.user = source.user
    testData.pass = source.pass
    testData.from = source.from
    testData.to = source.to
    testData.ignoreTLS = source.ignoreTLS
  } else if (source.type === 'telegram') {
    testData.botToken = source.botToken
    testData.chatId = source.chatId
    testData.apiBaseUrl = source.apiBaseUrl
    testData.proxyUrl = source.proxyUrl
  } else {
    testData.url = source.url
  }
  return testData
}

const testPlatform = async (platform) => {
  if (!isMounted.value) return
  try {
    const response = await httpApis.testWebhookApi(buildTestPayload(platform), {
      signal: abortController.value.signal
    })
    if (!isMounted.value) return
    if (isOk(response)) {
      showToast('测试成功', 'success')
    } else {
      showToast(msgOf(response, '测试失败'), 'error')
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    showToast(error.error || error.message || '测试失败', 'error')
    console.error(error)
  }
}

const testPlatformForm = async () => {
  if (!isMounted.value) return
  if (!validatePlatformForm()) return
  testingConnection.value = true
  try {
    const response = await httpApis.testWebhookApi(platformForm.value, {
      signal: abortController.value.signal
    })
    if (!isMounted.value) return
    if (isOk(response)) {
      showToast('测试成功', 'success')
    } else {
      showToast(msgOf(response, '测试失败'), 'error')
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    showToast(error.error || error.message || '测试失败', 'error')
    console.error(error)
  } finally {
    if (isMounted.value) testingConnection.value = false
  }
}

const sendTestNotification = async () => {
  if (!isMounted.value) return
  try {
    const response = await httpApis.testWebhookNotificationApi({
      signal: abortController.value.signal
    })
    if (!isMounted.value) return
    if (isOk(response)) {
      showToast('测试通知已发送', 'success')
    } else {
      showToast(msgOf(response, '发送失败'), 'error')
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (!isMounted.value) return
    showToast(error?.message || '发送失败', 'error')
    console.error(error)
  }
}

const clearTypeSpecificFields = (newType) => {
  if (newType === 'bark') {
    platformForm.value.url = ''
    platformForm.value.enableSign = false
    platformForm.value.secret = ''
    platformForm.value.botToken = ''
    platformForm.value.chatId = ''
    platformForm.value.apiBaseUrl = ''
    platformForm.value.proxyUrl = ''
    platformForm.value.host = ''
    platformForm.value.port = null
    platformForm.value.secure = false
    platformForm.value.user = ''
    platformForm.value.pass = ''
    platformForm.value.from = ''
    platformForm.value.to = ''
    platformForm.value.timeout = null
    platformForm.value.ignoreTLS = false
  } else if (newType === 'smtp') {
    platformForm.value.url = ''
    platformForm.value.enableSign = false
    platformForm.value.secret = ''
    platformForm.value.deviceKey = ''
    platformForm.value.serverUrl = ''
    platformForm.value.level = ''
    platformForm.value.sound = ''
    platformForm.value.group = ''
    platformForm.value.botToken = ''
    platformForm.value.chatId = ''
    platformForm.value.apiBaseUrl = ''
    platformForm.value.proxyUrl = ''
  } else if (newType === 'telegram') {
    platformForm.value.url = ''
    platformForm.value.enableSign = false
    platformForm.value.secret = ''
    platformForm.value.deviceKey = ''
    platformForm.value.serverUrl = ''
    platformForm.value.level = ''
    platformForm.value.sound = ''
    platformForm.value.group = ''
    platformForm.value.host = ''
    platformForm.value.port = null
    platformForm.value.secure = false
    platformForm.value.user = ''
    platformForm.value.pass = ''
    platformForm.value.from = ''
    platformForm.value.to = ''
    platformForm.value.timeout = null
    platformForm.value.ignoreTLS = false
  } else {
    platformForm.value.deviceKey = ''
    platformForm.value.serverUrl = ''
    platformForm.value.level = ''
    platformForm.value.sound = ''
    platformForm.value.group = ''
    platformForm.value.host = ''
    platformForm.value.port = null
    platformForm.value.secure = false
    platformForm.value.user = ''
    platformForm.value.pass = ''
    platformForm.value.from = ''
    platformForm.value.to = ''
    platformForm.value.timeout = null
    platformForm.value.ignoreTLS = false
    platformForm.value.botToken = ''
    platformForm.value.chatId = ''
    platformForm.value.apiBaseUrl = ''
    platformForm.value.proxyUrl = ''
  }
}

const platformTypeWatcher = watch(
  () => platformForm.value.type,
  (newType) => {
    urlError.value = false
    urlValid.value = false
    if (!editingPlatform.value) {
      clearTypeSpecificFields(newType)
    }
  }
)

onMounted(async () => {
  loading.value = true
  try {
    await loadWebhookConfig()
  } finally {
    if (isMounted.value) loading.value = false
  }
})

onBeforeUnmount(() => {
  isMounted.value = false
  if (abortController.value) abortController.value.abort()
  if (platformTypeWatcher) platformTypeWatcher()
  showPlatformModal.value = false
  editingPlatform.value = null
})
</script>

<style scoped>
.wh-section {
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid var(--divider-color);
}

.wh-section__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.wh-section__head--btn {
  width: 100%;
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
  text-align: left;
}

.wh-section__title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--text-primary);
}

.wh-section__desc {
  margin: 0.15rem 0 0;
  font-size: 0.875rem;
  line-height: 1.4;
  color: var(--text-secondary);
}

.wh-type-list,
.wh-platform-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--divider-color);
  border-radius: 0.5rem;
  overflow: hidden;
}

.wh-type-row,
.wh-platform-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border-bottom: 1px solid var(--divider-color);
  background: transparent;
}

.wh-type-row:last-child,
.wh-platform-row:last-child {
  border-bottom: 0;
}

.wh-type-row:hover,
.wh-platform-row:hover {
  background: color-mix(in srgb, var(--text-primary) 3%, transparent);
}

.wh-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--divider-color);
  border-radius: 0.5rem;
  padding: 1.5rem 1rem;
}

.wh-advanced-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
}

@media (min-width: 640px) {
  .wh-advanced-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.wh-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.wh-field__label {
  font-size: 0.875rem;
  color: var(--text-secondary);
}
</style>
