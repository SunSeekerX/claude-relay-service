import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { APP_CONFIG, showToast } from '@/libs/tools'

// 路由懒加载
const LoginView = () => import('@/views/login_view.vue')
const UserLoginView = () => import('@/views/user_login_view.vue')
const UserDashboardView = () => import('@/views/user_dashboard_view.vue')
const UserManagementView = () => import('@/views/user_management_view.vue')
const MainLayout = () => import('@/components/layout/main_layout.vue')
const DashboardView = () => import('@/views/dashboard_view.vue')
const ApiKeysView = () => import('@/views/api_keys_view.vue')
const ApiKeyUsageRecordsView = () => import('@/views/api_key_usage_records_view.vue')
const AccountsView = () => import('@/views/accounts_view.vue')
const AccountUsageRecordsView = () => import('@/views/account_usage_records_view.vue')
const SettingsView = () => import('@/views/settings_view.vue')
const ApiStatsView = () => import('@/views/api_stats_view.vue')
const ApiStatsQueryTab = () => import('@/views/api_stats/stats_tab.vue')
const ApiStatsQuotaTab = () => import('@/views/api_stats/quota_tab.vue')
const ApiStatsRechargeTab = () => import('@/views/api_stats/recharge_tab.vue')
const ApiStatsPricingTab = () => import('@/views/api_stats/pricing_tab.vue')
const ApiStatsTutorialTab = () => import('@/views/api_stats/tutorial_tab.vue')
const QuotaCardsView = () => import('@/views/quota_cards_view.vue')
const RequestDetailsView = () => import('@/views/request_details_view.vue')
const ProxyPoolView = () => import('@/views/proxy_pool_view.vue')

const routes = [
  {
    path: '/',
    redirect: () => {
      // 智能重定向：避免循环
      const currentPath = window.location.pathname
      const basePath = APP_CONFIG.basePath.replace(/\/$/, '') // 移除末尾斜杠

      // 如果当前路径已经是 basePath 或 basePath/，重定向到 api-stats
      if (currentPath === basePath || currentPath === basePath + '/') {
        return '/api-stats'
      }

      // 否则保持默认重定向
      return '/api-stats'
    }
  },
  {
    path: '/login',
    name: 'Login',
    component: LoginView,
    meta: { requiresAuth: false }
  },
  {
    path: '/admin-login',
    redirect: '/login'
  },
  {
    path: '/user-login',
    name: 'UserLogin',
    component: UserLoginView,
    meta: { requiresAuth: false, userAuth: true }
  },
  {
    path: '/user-dashboard',
    name: 'UserDashboard',
    component: UserDashboardView,
    meta: { requiresUserAuth: true }
  },
  {
    path: '/api-stats',
    component: ApiStatsView,
    meta: { requiresAuth: false },
    children: [
      {
        path: '',
        redirect: (to) => ({ name: 'ApiStatsQuery', query: to.query })
      },
      {
        path: 'stats',
        name: 'ApiStatsQuery',
        component: ApiStatsQueryTab,
        meta: { requiresAuth: false, tab: 'stats', subtitle: 'API Key 使用统计' }
      },
      {
        path: 'quota',
        name: 'ApiStatsQuota',
        component: ApiStatsQuotaTab,
        meta: {
          requiresAuth: false,
          tab: 'quota',
          subtitle: '额度卡',
          quotaSubTab: 'redeem'
        }
      },
      {
        path: 'quota/history',
        name: 'ApiStatsQuotaHistory',
        component: ApiStatsQuotaTab,
        meta: {
          requiresAuth: false,
          tab: 'quota',
          subtitle: '额度卡',
          quotaSubTab: 'history'
        }
      },
      {
        path: 'recharge',
        name: 'ApiStatsRecharge',
        component: ApiStatsRechargeTab,
        meta: { requiresAuth: false, tab: 'recharge', subtitle: '充值' }
      },
      {
        path: 'pricing',
        name: 'ApiStatsPricing',
        component: ApiStatsPricingTab,
        meta: { requiresAuth: false, tab: 'pricing', subtitle: '模型价格' }
      },
      {
        path: 'tutorial',
        name: 'ApiStatsTutorial',
        component: ApiStatsTutorialTab,
        meta: { requiresAuth: false, tab: 'tutorial', subtitle: '使用教程' }
      }
    ]
  },
  {
    path: '/dashboard',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'Dashboard',
        component: DashboardView
      }
    ]
  },
  {
    path: '/api-keys',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'ApiKeys',
        component: ApiKeysView
      }
    ]
  },
  {
    path: '/api-keys/:keyId/usage-records',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'ApiKeyUsageRecords',
        component: ApiKeyUsageRecordsView
      }
    ]
  },
  {
    path: '/accounts',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'Accounts',
        component: AccountsView
      }
    ]
  },
  {
    path: '/accounts/:accountId/usage-records',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'AccountUsageRecords',
        component: AccountUsageRecordsView
      }
    ]
  },
  {
    path: '/settings',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        redirect: (to) => ({
          name: 'Settings',
          params: { section: 'branding' },
          query: to.query
        })
      },
      {
        path: ':section',
        name: 'Settings',
        component: SettingsView,
        meta: { requiresAuth: true }
      }
    ]
  },
  {
    path: '/user-management',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'UserManagement',
        component: UserManagementView
      }
    ]
  },
  {
    path: '/quota-cards',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'QuotaCards',
        component: QuotaCardsView
      }
    ]
  },
  {
    path: '/payment-manage',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'PaymentManage',
        component: () => import('@/views/payment_manage_view.vue')
      }
    ]
  },
  {
    path: '/request-details',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'RequestDetails',
        component: RequestDetailsView
      }
    ]
  },
  {
    path: '/proxy-pool',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'ProxyPool',
        component: ProxyPoolView
      }
    ]
  },
  // 捕获所有未匹配的路由
  {
    path: '/:pathMatch(.*)*',
    redirect: '/api-stats'
  }
]

const router = createRouter({
  history: createWebHistory(APP_CONFIG.basePath),
  routes
})

// 路由守卫（Vue Router 5：用 return 代替 next()）
router.beforeEach(async (to, from) => {
  const authStore = useAuthStore()
  const userStore = useUserStore()

  console.log('路由导航:', {
    to: to.path,
    from: from.path,
    fullPath: to.fullPath,
    requiresAuth: to.meta.requiresAuth,
    requiresUserAuth: to.meta.requiresUserAuth,
    isAuthenticated: authStore.isAuthenticated,
    isUserAuthenticated: userStore.isAuthenticated
  })

  // 防止重定向循环：如果已经在目标路径，直接放行
  if (to.path === from.path && to.fullPath === from.fullPath) {
    return true
  }

  // 检查用户认证状态
  if (to.meta.requiresUserAuth) {
    if (!userStore.isAuthenticated) {
      // 尝试检查本地存储的认证信息
      try {
        const isUserLoggedIn = await userStore.checkAuth()
        if (!isUserLoggedIn) {
          return '/user-login'
        }
      } catch (error) {
        // If the error is about disabled account, redirect to login with error
        if (error.message && error.message.includes('disabled')) {
          showToast(error.message, 'error')
        }
        return '/user-login'
      }
    }
    return true
  }

  // API Stats 页面不需要认证，直接放行
  if (to.path === '/api-stats' || to.path.startsWith('/api-stats')) {
    return true
  }
  if (to.path === '/user-login') {
    // 如果已经是用户登录状态，重定向到用户仪表板
    return userStore.isAuthenticated ? '/user-dashboard' : true
  }

  // 管理端：进入需登录页或登录页前，先恢复并校验 localStorage 中的 token
  // 否则刷新后 isLoggedIn 仍为 false，有效会话也会停在 /login 或被踢回
  if (to.meta.requiresAuth || to.path === '/login') {
    if (!authStore.isAuthenticated && (authStore.authToken || localStorage.getItem('authToken'))) {
      await authStore.checkAuth()
    }
  }

  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    return '/login'
  }
  if (to.path === '/login' && authStore.isAuthenticated) {
    return '/dashboard'
  }
  return true
})

export default router
