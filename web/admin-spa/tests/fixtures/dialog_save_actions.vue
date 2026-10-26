<template>
  <ProxyPoolView v-if="scenario === 'proxy'" />
  <AccountsView v-else-if="scenario === 'accounts'" />
  <ApiKeysView v-else-if="scenario === 'keys'" />
  <QuotaCardsView v-else-if="scenario === 'cards'" />
  <AppHeader v-else-if="scenario === 'header'" />
  <PaymentManageView v-else-if="scenario === 'payment'" />
  <ThemeSettings v-else-if="scenario === 'theme'" />
  <LayoutSettings v-else-if="scenario === 'layout'" />
  <GroupManagementModal v-else-if="scenario === 'groups'" />
  <CcrAccountForm
    v-else-if="scenario === 'ccr' && open"
    :account="createdAccount"
    @close="open = false"
    @success="accountSaved"
  />
  <BatchEditApiKeyModal
    v-else-if="scenario === 'batch' && open"
    :selected-keys="['key-1', 'key-2']"
    @close="open = false"
  />
  <QuickAdjustModal
    v-else-if="scenario === 'quick' && open"
    :api-key="{ id: 'key-1', name: '测试 Key', totalCostLimit: 10 }"
    @close="open = false"
  />
  <UserCreateApiKeyModal v-else-if="scenario === 'user-key'" :show="open" @close="open = false" />
  <InternalModelEditor
    v-else-if="scenario === 'model'"
    :is-create="true"
    :show="open"
    @close="open = false"
  />
  <ChangeRoleModal
    v-else-if="scenario === 'role'"
    :show="open"
    :user="user"
    @close="open = false"
    @updated="roleSaved"
  />
  <AccountScheduledTestModal
    v-else-if="scenario === 'scheduled'"
    :account="{ id: 'account-1', platform: 'claude', name: '测试账户' }"
    :show="open"
    @close="open = false"
  />
  <CreateApiKeyModal v-else-if="scenario === 'create-key' && open" @close="open = false" />
  <form v-else-if="scenario === 'form' && open" @submit.prevent="save(false)">
    <input v-model="name" aria-label="名称" required />
    <DialogSaveActions :loading="loading" @cancel="open = false" @save="save" />
    <output>{{ saved }}</output>
  </form>
  <output v-if="!open">已关闭</output>
</template>

<script setup>
import { ref } from 'vue'
import ProxyPoolView from '@/views/proxy_pool_view.vue'
import AccountsView from '@/views/accounts_view.vue'
import ApiKeysView from '@/views/api_keys_view.vue'
import QuotaCardsView from '@/views/quota_cards_view.vue'
import AppHeader from '@/components/layout/app_header.vue'
import PaymentManageView from '@/views/payment_manage_view.vue'
import InternalModelEditor from '@/components/settings/internal_model_editor.vue'
import ChangeRoleModal from '@/components/admin/change_role_modal.vue'
import AccountScheduledTestModal from '@/components/accounts/account_scheduled_test_modal.vue'
import CreateApiKeyModal from '@/components/api_keys/create_api_key_modal.vue'
import GroupManagementModal from '@/components/accounts/group_management_modal.vue'
import CcrAccountForm from '@/components/accounts/ccr_account_form.vue'
import BatchEditApiKeyModal from '@/components/api_keys/batch_edit_api_key_modal.vue'
import QuickAdjustModal from '@/components/api_keys/quick_adjust_modal.vue'
import UserCreateApiKeyModal from '@/components/user/create_api_key_modal.vue'
import ThemeSettings from '@/components/common/theme_settings.vue'
import LayoutSettings from '@/components/common/layout_settings.vue'
import { useThemeStore } from '@/stores/theme'

const scenario = new URLSearchParams(location.search).get('case')
const open = ref(true)
const name = ref('')
const saved = ref(0)
const loading = ref(false)
const user = ref({ id: 'user-1', username: 'tester', role: 'user' })
const createdAccount = ref(null)
const theme = useThemeStore()
theme.settingsOpen = scenario === 'theme'
theme.layoutSettingsOpen = scenario === 'layout'
const accountSaved = (result, closeAfter) => {
  if (result) createdAccount.value = result.data
  if (closeAfter) open.value = false
}
const roleSaved = (closeAfter, role) => {
  user.value = { ...user.value, role }
  if (closeAfter) open.value = false
}
const save = async (closeAfter) => {
  loading.value = true
  await new Promise((resolve) => setTimeout(resolve, 150))
  saved.value += 1
  if (closeAfter) open.value = false
  loading.value = false
}
</script>
