<template>
  <AccountUsageRecordsPanel
    :account-id="accountId"
    :platform="platform"
    show-back
    show-header
    @back="goBack"
  />
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AccountUsageRecordsPanel from '@/components/accounts/account_usage_records_panel.vue'

const route = useRoute()
const router = useRouter()

const accountId = computed(() => String(route.params.accountId || ''))
const platform = computed(() => String(route.query.platform || ''))

const goBack = () => {
  router.push('/accounts')
}
</script>
