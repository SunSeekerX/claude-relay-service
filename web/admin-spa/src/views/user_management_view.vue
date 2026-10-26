<template>
  <div class="user-management-view admin-list-page space-y-3">
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div class="stat-card">
        <p class="admin-inline-label">用户总数</p>
        <strong>{{ userStats?.totalUsers ?? 0 }}</strong>
      </div>
      <div class="stat-card">
        <p class="admin-inline-label">启用用户</p>
        <strong class="text-green-600 dark:text-green-400">{{
          userStats?.activeUsers ?? 0
        }}</strong>
      </div>
      <div class="stat-card">
        <p class="admin-inline-label">API Key 总数</p>
        <strong>{{ userStats?.totalApiKeys ?? 0 }}</strong>
      </div>
      <div class="stat-card">
        <p class="admin-inline-label">累计费用</p>
        <strong>${{ (userStats?.totalUsage?.totalCost ?? 0).toFixed(4) }}</strong>
      </div>
    </div>
    <div class="admin-toolbar">
      <div class="admin-filter-group">
        <div class="toolbar-search-wrap">
          <i class="input-affix-icon input-affix-icon--left i-lucide-search" /><input
            v-model="searchQuery"
            aria-label="搜索用户"
            class="toolbar-search-input"
            placeholder="搜索姓名、用户名或邮箱"
            type="search"
          />
        </div>
        <div class="w-40">
          <CustomDropdown
            v-model="selectedRole"
            :options="roleFilterOptions"
            placeholder="全部角色"
            size="sm"
            @change="loadUsers"
          />
        </div>
        <div class="w-40">
          <CustomDropdown
            v-model="selectedStatus"
            :options="statusFilterOptions"
            placeholder="全部状态"
            size="sm"
            @change="loadUsers"
          />
        </div>
      </div>
      <div class="admin-actions">
        <button class="btn btn-secondary" type="button" @click="clearUserFilters">
          <i class="i-lucide-rotate-ccw" />重置筛选</button
        ><button class="btn btn-secondary" :disabled="loading" type="button" @click="loadUsers">
          <i :class="loading ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw'" />刷新
        </button>
      </div>
    </div>
    <section aria-label="用户列表" class="user-list">
      <header class="user-list-heading">
        <h2>用户列表</h2>
        <span class="admin-result-count"
          >显示 {{ filteredUsers.length }} / {{ users.length }} 位用户</span
        >
      </header>
      <div v-if="loading" class="admin-empty-state">
        <i class="i-lucide-loader-circle animate-spin" />正在加载用户...
      </div>
      <div v-else-if="!filteredUsers.length" class="admin-empty-state">
        {{
          searchQuery || selectedRole || selectedStatus
            ? '没有匹配的用户，请调整筛选条件'
            : '暂无用户'
        }}
      </div>
      <div v-else>
        <article v-for="user in filteredUsers" :key="user.id" class="user-list-row">
          <div class="user-identity">
            <div class="user-name">
              <strong>{{ user.displayName || user.username }}</strong
              ><span
                :class="
                  user.isActive
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                "
                >{{ user.isActive ? '启用' : '停用' }}</span
              ><span class="user-role">{{ roleLabel(user.role) }}</span>
            </div>
            <div class="user-meta">
              <span>@{{ user.username }}</span
              ><span>{{ user.email || '未设置邮箱' }}</span>
            </div>
          </div>
          <dl class="user-row-metrics">
            <div>
              <dt>Key</dt>
              <dd>{{ user.apiKeyCount ?? 0 }} 个</dd>
            </div>
            <div>
              <dt>请求</dt>
              <dd>{{ formatNumber(user.totalUsage?.requests ?? 0) }}</dd>
            </div>
            <div>
              <dt>费用</dt>
              <dd>${{ (user.totalUsage?.totalCost ?? 0).toFixed(4) }}</dd>
            </div>
            <div class="user-login">
              <dt>最近登录</dt>
              <dd>{{ user.lastLoginAt ? formatDate(user.lastLoginAt) : '从未登录' }}</dd>
            </div>
          </dl>
          <div class="admin-row-actions">
            <button class="btn btn-secondary" type="button" @click="changeUserRole(user)">
              <i class="i-lucide-user-round-cog" />修改角色</button
            ><button class="btn btn-secondary" type="button" @click="viewUserStats(user)">
              <i class="i-lucide-chart-column" />使用统计</button
            ><button
              class="btn btn-secondary"
              :class="{ 'admin-danger': user.isActive }"
              type="button"
              @click="toggleUserStatus(user)"
            >
              {{ user.isActive ? '停用用户' : '启用用户' }}</button
            ><button
              class="btn btn-secondary admin-danger"
              :disabled="!user.apiKeyCount"
              type="button"
              @click="disableUserApiKeys(user)"
            >
              停用全部 Key
            </button>
          </div>
        </article>
      </div>
    </section>
    <UserUsageStatsModal
      :show="showStatsModal"
      :user="selectedUser"
      @close="showStatsModal = false"
    />
    <ConfirmModal
      :confirm-class="confirmAction.confirmClass"
      :confirm-text="confirmAction.confirmText"
      :message="confirmAction.message"
      :show="showConfirmModal"
      :title="confirmAction.title"
      @cancel="showConfirmModal = false"
      @confirm="handleConfirmAction"
    />
    <ChangeRoleModal
      :show="showRoleModal"
      :user="selectedUser"
      @close="showRoleModal = false"
      @updated="handleUserUpdated"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

import * as httpApis from '@/libs/http_apis'
import { isOk, msgOf, dataOf } from '@/libs/http_envelope'
import { showToast, formatNumber, formatDate } from '@/libs/tools'
import CustomDropdown from '@/components/common/custom_dropdown.vue'
import UserUsageStatsModal from '@/components/admin/user_usage_stats_modal.vue'
import ChangeRoleModal from '@/components/admin/change_role_modal.vue'
import ConfirmModal from '@/components/common/confirm_modal.vue'

const loading = ref(true)
const users = ref([])
const userStats = ref(null)
const searchQuery = ref('')
const selectedRole = ref('')
const selectedStatus = ref('')
const roleFilterOptions = [
  { value: '', label: '全部角色' },
  { value: 'user', label: '普通用户' },
  { value: 'admin', label: '管理员' }
]
const statusFilterOptions = [
  { value: '', label: '全部状态' },
  { value: 'true', label: '启用' },
  { value: 'false', label: '停用' }
]

const showStatsModal = ref(false)
const showConfirmModal = ref(false)
const showRoleModal = ref(false)
const selectedUser = ref(null)

const confirmAction = ref({
  title: '',
  message: '',
  confirmText: '',
  confirmClass: '',
  action: null
})

const filteredUsers = computed(() => {
  let filtered = users.value

  // Apply search filter
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    filtered = filtered.filter(
      (user) =>
        user.username.toLowerCase().includes(query) ||
        user.displayName?.toLowerCase().includes(query) ||
        user.email?.toLowerCase().includes(query)
    )
  }

  // Apply role filter
  if (selectedRole.value) {
    filtered = filtered.filter((user) => user.role === selectedRole.value)
  }

  // Apply status filter
  if (selectedStatus.value !== '') {
    const isActive = selectedStatus.value === 'true'
    filtered = filtered.filter((user) => user.isActive === isActive)
  }

  return filtered
})

const loadUsers = async () => {
  loading.value = true
  try {
    // Build params object, only including parameters with actual values
    const params = {}
    if (selectedRole.value && selectedRole.value.trim() !== '') {
      params.role = selectedRole.value
    }
    if (selectedStatus.value !== '') {
      params.isActive = selectedStatus.value
    }

    const [usersResponse, statsResponse] = await Promise.all([
      httpApis.getFrontUsersApi(params),
      httpApis.getFrontUsersStatsOverviewApi()
    ])

    if (isOk(usersResponse)) {
      users.value = dataOf(usersResponse)?.users || []
    } else {
      showToast(msgOf(usersResponse, '加载用户失败'), 'error')
    }

    if (isOk(statsResponse)) {
      userStats.value = dataOf(statsResponse)?.stats
    } else {
      showToast(msgOf(statsResponse, 'Failed to load user stats'), 'error')
    }
  } catch (error) {
    console.error('加载用户失败:', error)
    showToast('加载用户失败', 'error')
  } finally {
    loading.value = false
  }
}

const clearUserFilters = () => {
  searchQuery.value = ''
  selectedRole.value = ''
  selectedStatus.value = ''
  loadUsers()
}
const roleLabel = (role) => ({ admin: '管理员', user: '普通用户' })[role] ?? role

const viewUserStats = (user) => {
  selectedUser.value = user
  showStatsModal.value = true
}

const toggleUserStatus = (user) => {
  selectedUser.value = user
  confirmAction.value = {
    title: user.isActive ? '停用用户' : '启用用户',
    message: user.isActive
      ? `确定停用用户“${user.displayName || user.username}”？停用后将无法登录。`
      : `确定启用用户“${user.displayName || user.username}”？`,
    confirmText: user.isActive ? '停用' : '启用',
    confirmClass: user.isActive ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700',
    action: 'toggleStatus'
  }
  showConfirmModal.value = true
}

const disableUserApiKeys = (user) => {
  if (user.apiKeyCount === 0) return

  selectedUser.value = user
  confirmAction.value = {
    title: '停用全部 Key',
    message: `确定停用“${user.displayName || user.username}”的全部 ${user.apiKeyCount} 个 Key？这些 Key 将无法继续调用服务。`,
    confirmText: '停用 Key',
    confirmClass: 'bg-red-600 hover:bg-red-700',
    action: 'disableKeys'
  }
  showConfirmModal.value = true
}

const changeUserRole = (user) => {
  selectedUser.value = user
  showRoleModal.value = true
}

const handleConfirmAction = async () => {
  const user = selectedUser.value
  const action = confirmAction.value.action

  try {
    if (action === 'toggleStatus') {
      const response = await httpApis.updateFrontUserStatusApi(user.id, {
        isActive: !user.isActive
      })

      if (isOk(response)) {
        const userIndex = users.value.findIndex((u) => u.id === user.id)
        if (userIndex !== -1) {
          users.value[userIndex].isActive = !user.isActive
        }
        showToast(user.isActive ? '用户已启用' : '用户已停用', 'success')
        await loadUsers()
      } else {
        showToast(msgOf(response, '操作失败，请重试'), 'error')
      }
    } else if (action === 'disableKeys') {
      const response = await httpApis.disableFrontUserKeysApi(user.id)

      if (isOk(response)) {
        showToast(`已停用 ${dataOf(response)?.disabledCount ?? 0} 个 Key`, 'success')
        await loadUsers() // Refresh to get updated counts
      } else {
        showToast(msgOf(response, '操作失败，请重试'), 'error')
      }
    }
  } catch (error) {
    console.error(`Failed to ${action}:`, error)
    showToast('操作失败，请重试', 'error')
  } finally {
    showConfirmModal.value = false
    selectedUser.value = null
  }
}

const handleUserUpdated = (closeAfter, role) => {
  selectedUser.value = { ...selectedUser.value, role }
  if (closeAfter) {
    showRoleModal.value = false
    selectedUser.value = null
  }
  loadUsers()
}

onMounted(() => {
  loadUsers()
})
</script>

<style scoped>
.stat-card p {
  margin: 0 0 5px;
}
.stat-card > strong {
  font-size: 22px;
  font-weight: 600;
}
.user-list {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.user-list-heading {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--surface-muted);
}
.user-list-heading h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}
.user-list-row {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(230px, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 13px 12px;
  border-top: 1px solid var(--divider-color);
}
.user-identity {
  min-width: 0;
}
.user-name,
.user-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 10px;
  font-size: 14px;
}
.user-meta {
  margin-top: 6px;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.user-role {
  padding: 2px 6px;
  background: var(--surface-muted);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
}
.user-row-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 0;
  font-size: 14px;
}
.user-row-metrics > div {
  display: flex;
  gap: 6px;
}
.user-row-metrics dt {
  color: var(--text-secondary);
}
.user-row-metrics dd {
  margin: 0;
}
.user-login {
  width: 100%;
}
@media (max-width: 1279px) {
  .user-list-row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .user-list-row .admin-row-actions {
    grid-column: 1 / -1;
  }
}
@media (max-width: 639px) {
  .user-list-row {
    grid-template-columns: 1fr;
    gap: 10px;
  }
}
</style>
