<template>
  <AppDialog
    :closable="!loading"
    :close-on-mask="!loading"
    icon="i-lucide-user-round-cog"
    :model-value="show"
    size="lg"
    title="修改用户角色"
    @close="emit('close')"
  >
    <form v-if="user" id="change-user-role" class="space-y-4" @submit.prevent="handleSubmit(false)">
      <div class="rounded-lg p-3 t-surface-muted">
        <strong>{{ user.displayName || user.username }}</strong>
        <p class="mt-1 text-sm t-text-secondary">
          @{{ user.username }} · 当前角色：{{ user.role === 'admin' ? '管理员' : '普通用户' }}
        </p>
      </div>
      <CuteOptionCards v-model="selectedRole" :disabled="loading" :options="roleOptions" />
      <div
        v-if="selectedRole !== user.role"
        class="rounded-lg p-3 text-sm text-amber-700 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-300"
      >
        <strong>角色变更影响</strong>
        <p class="mt-1">
          {{
            selectedRole === 'admin'
              ? '授予管理员权限后，该用户可以管理其他用户、API Key 和系统配置。'
              : '移除管理员权限后，该用户只能管理自己的 API Key 和查看自身使用统计。'
          }}
        </p>
      </div>
      <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>
    </form>
    <template #footer>
      <DialogSaveActions
        class="w-full"
        :disabled="!user"
        form="change-user-role"
        :loading="loading"
        @cancel="emit('close')"
        @save="handleSubmit"
      />
    </template>
  </AppDialog>
</template>

<script setup>
import { ref, watch } from 'vue'

import AppDialog from '@/components/common/app_dialog.vue'
import CuteOptionCards from '@/components/common/cute_option_cards.vue'
import { updateFrontUserRoleApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast } from '@/libs/tools'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  user: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['close', 'updated'])

const loading = ref(false)
const error = ref('')
const selectedRole = ref('')

const roleOptions = [
  {
    value: 'user',
    label: '普通用户',
    description: '管理自己的 Key 和使用统计',
    icon: 'i-lucide-user'
  },
  {
    value: 'admin',
    label: '管理员',
    description: '可以管理用户及系统设置',
    icon: 'i-lucide-shield-check'
  }
]

const handleSubmit = async (closeAfter = false) => {
  if (!props.user) {
    return
  }

  loading.value = true
  error.value = ''
  const submittedRole = selectedRole.value

  try {
    const response = await updateFrontUserRoleApi(props.user.id, {
      role: submittedRole
    })

    if (isOk(response)) {
      showToast(
        `用户角色已修改为${submittedRole === 'admin' ? '管理员' : '普通用户'}`,
        'success'
      )
      emit('updated', closeAfter, submittedRole)
    } else {
      error.value = msgOf(response, '修改用户角色失败')
    }
  } catch (err) {
    console.error('Update user role error:', err)
    error.value = err.response?.data?.message || err.message || '修改用户角色失败'
  } finally {
    loading.value = false
  }
}

// Reset form when modal is shown
watch([() => props.show, () => props.user], ([show, user]) => {
  if (show && user) {
    selectedRole.value = user.role
    error.value = ''
    loading.value = false
  }
})
</script>
