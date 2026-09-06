<template>
  <!-- 不挂 tab-content：MainLayout 已包一层进场动画，重复挂会双重 translateY 致高度连跳 -->
  <div class="quota-cards-view">
    <!-- 去掉内层 .card：外层 MainLayout 已是卡片，避免卡片套卡片 -->
    <!-- transition-none：盖掉全局 div{transition:all}，否则 height 像素校正会被做成 0.3s 动画（看起来像抖动） -->
    <div
      ref="cardRef"
      class="relative flex flex-col overflow-y-auto px-3 sm:px-4 transition-none"
      :style="cardStyle"
    >
      <!-- Header（紧凑，固定不滚动） -->
      <div class="mb-3 flex flex-none flex-col gap-3 sm:mb-4">
        <!-- Stats Cards -->
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-6">
          <div class="stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-semibold text-gray-600 dark:text-gray-400">总卡片数</p>
                <p class="text-lg font-bold text-gray-900 dark:text-gray-100 ">
                  {{ stats.total }}
                </p>
              </div>
              <div class="stat-icon flex-shrink-0 bg-gradient-to-br from-blue-500 to-blue-600">
                <i class="i-lucide-ticket" />
              </div>
            </div>
          </div>

          <div class="stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-semibold text-gray-600 dark:text-gray-400">未使用</p>
                <p class="text-lg font-bold text-green-600 dark:text-green-400 ">
                  {{ stats.unused }}
                </p>
              </div>
              <div class="stat-icon flex-shrink-0 bg-gradient-to-br from-green-500 to-green-600">
                <i class="i-lucide-circle-check" />
              </div>
            </div>
          </div>

          <div class="stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-semibold text-gray-600 dark:text-gray-400">已核销</p>
                <p class="text-lg font-bold text-purple-600 dark:text-purple-400 ">
                  {{ stats.redeemed }}
                </p>
              </div>
              <div class="stat-icon flex-shrink-0 bg-gradient-to-br from-purple-500 to-purple-600">
                <i class="i-lucide-arrow-left-right" />
              </div>
            </div>
          </div>

          <div class="stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-semibold text-gray-600 dark:text-gray-400">已撤销</p>
                <p class="text-lg font-bold text-red-600 dark:text-red-400 ">
                  {{ stats.revoked }}
                </p>
              </div>
              <div class="stat-icon flex-shrink-0 bg-gradient-to-br from-red-500 to-red-600">
                <i class="i-lucide-ban" />
              </div>
            </div>
          </div>

          <div class="stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-semibold text-gray-600 dark:text-gray-400">已过期</p>
                <p class="text-lg font-bold text-amber-600 dark:text-amber-400 ">
                  {{ stats.expired || 0 }}
                </p>
              </div>
              <div class="stat-icon flex-shrink-0 bg-gradient-to-br from-amber-500 to-amber-600">
                <i class="i-lucide-hourglass" />
              </div>
            </div>
          </div>

          <div class="stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-semibold text-gray-600 dark:text-gray-400">已禁用</p>
                <p class="text-lg font-bold text-gray-600 dark:text-gray-400 ">
                  {{ stats.disabled || 0 }}
                </p>
              </div>
              <div class="stat-icon flex-shrink-0 bg-gradient-to-br from-gray-400 to-gray-500">
                <i class="i-lucide-circle-pause" />
              </div>
            </div>
          </div>
        </div>

        <!-- Tab Navigation -->
        <SegmentedTabs v-model="activeTab" variant="underline" :tabs="tabs" />
      </div>

      <!-- Cards Tab -->
      <div v-if="activeTab === 'cards'" class="flex flex-col md:min-h-0 md:flex-1">
        <!-- 查询栏：筛选贴搜索；创建卡片在列表上方右侧 -->
        <div class="mb-3 flex flex-none flex-wrap items-center gap-2 px-0.5">
          <div class="toolbar-search-wrap">
            <i class="input-affix-icon input-affix-icon--left i-lucide-search" />
            <input
              v-model="cardSearch"
              class="toolbar-search-input"
              placeholder="搜索卡号 / 备注 / 核销用户"
              type="text"
              @keyup.enter="applyCardFilters"
            />
          </div>
          <div class="w-[140px] shrink-0">
            <CustomDropdown
              v-model="cardTypeFilter"
              accent="blue"
              icon="i-lucide-ticket"
              :options="cardTypeFilterOptions"
              placeholder="全部类型"
              @change="applyCardFilters"
            />
          </div>
          <div class="w-[140px] shrink-0">
            <CustomDropdown
              v-model="cardStatusFilter"
              accent="indigo"
              icon="i-lucide-filter"
              :options="cardStatusFilterOptions"
              placeholder="全部状态"
              @change="applyCardFilters"
            />
          </div>
          <button
            class="toolbar-btn"
            type="button"
            @click="applyCardFilters"
          >
            <i class="i-lucide-search mr-1.5" />查询
          </button>
          <button
            v-if="cardSearch || cardTypeFilter || cardStatusFilter"
            class="toolbar-btn"
            type="button"
            @click="resetCardFilters"
          >
            重置
          </button>
          <div class="ml-auto flex shrink-0 items-center gap-2">
            <button
              class="btn btn-primary toolbar-btn-primary"
              type="button"
              @click="showCreateModal = true"
            >
              <i class="i-lucide-plus" />
              创建卡片
            </button>
          <button
            class="toolbar-btn"
            type="button"
            @click="openLimitsModal"
          >
            <i class="i-lucide-shield" />
            上限保护
            <span
              v-if="limitsStatus === 'loaded'"
              class="toolbar-btn__badge"
              :class="limitsConfig.enabled ? 'is-on' : 'is-off'"
            >
              {{ limitsConfig.enabled ? '已开启' : '已关闭' }}
            </span>
            <span v-else-if="limitsStatus === 'loading'" class="text-sm text-gray-400">加载中</span>
            <span v-else class="text-sm text-red-500">加载失败</span>
          </button>
          <button
            class="toolbar-btn"
            type="button"
            @click="openRedeemLocksModal"
          >
            <i class="i-lucide-lock-keyhole" />
            兑换失败锁
            <span
              v-if="redeemLocksBadgeCount > 0"
              class="toolbar-btn__badge is-on"
            >
              {{ redeemLocksBadgeCount }}
            </span>
          </button>
          </div>
        </div>


        <!-- Table（内部滚动，表头吸顶） -->
        <div
          class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 md:min-h-0 md:flex-1 md:overflow-auto"
        >
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="sticky top-0 z-10 bg-gray-100 dark:bg-gray-700">
              <tr>
                <th class="w-10 px-4 py-3">
                  <input
                    :checked="isAllSelected"
                    class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                    :indeterminate="isIndeterminate"
                    type="checkbox"
                    @change="toggleSelectAll"
                  />
                </th>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  卡号
                </th>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  类型
                </th>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  额度/时间
                </th>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  状态
                </th>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  核销用户
                </th>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  创建时间
                </th>
                <th
                  class="px-4 py-3 text-right text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  操作
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-800">
              <tr v-if="loading">
                <td
                  class="px-4 py-5 text-center text-sm text-gray-500 dark:text-gray-400"
                  colspan="8"
                >
                  <i class="i-lucide-loader-circle animate-spin mr-2 text-blue-500" />加载中...
                </td>
              </tr>
              <template v-else>
                <tr
                  v-for="card in cards"
                  :key="card.id"
                  :class="[ 'hover:bg-gray-50 dark:hover:bg-gray-700/50', selectedCards.includes(card.id) ? 'bg-blue-50 dark:bg-blue-900/10' : '' ]"
                >
                  <td class="whitespace-nowrap px-4 py-3">
                    <input
                      v-if="card.status === 'unused'"
                      :checked="selectedCards.includes(card.id)"
                      class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                      type="checkbox"
                      @change="toggleSelectCard(card.id)"
                    />
                  </td>
                  <td class="whitespace-nowrap px-4 py-3">
                    <code
                      class="cursor-pointer rounded bg-gray-100 px-2 py-1 font-mono text-sm hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600"
                      title="点击复制"
                      @click="copyText(card.code)"
                    >
                      {{ card.code }}
                    </code>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3">
                    <span
                      :class="[ 'inline-flex rounded-full px-2 py-1 text-sm font-medium', card.type === 'quota' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' : card.type === 'time' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' : 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300' ]"
                    >
                      {{
                        card.type === 'quota'
                          ? '额度卡'
                          : card.type === 'time'
                            ? '时间卡'
                            : '组合卡'
                      }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-900 dark:text-white">
                    <span v-if="card.type === 'quota' || card.type === 'combo'"
                      >${{ card.quotaAmount }}</span
                    >
                    <span v-if="card.type === 'combo'"> + </span>
                    <span v-if="card.type === 'time' || card.type === 'combo'">
                      {{ card.timeAmount }}
                      {{
                        card.timeUnit === 'hours' ? '小时' : card.timeUnit === 'days' ? '天' : '月'
                      }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3">
                    <span
                      :class="[ 'inline-flex rounded-full px-2 py-1 text-sm font-medium', card.status === 'unused' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' : card.status === 'redeemed' ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300' : card.status === 'disabled' ? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' ]"
                    >
                      {{ cardStatusLabel(card.status) }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {{ card.redeemedByUsername || '-' }}
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {{ formatDate(card.createdAt) }}
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-right">
                    <div class="flex flex-wrap items-center justify-end gap-1">
                      <button
                        v-if="card.status === 'unused'"
                        class="rounded px-2 py-1 text-sm font-medium text-orange-600 transition-colors hover:bg-orange-50 hover:text-orange-900 dark:text-orange-400 dark:hover:bg-orange-900/20"
                        title="禁用"
                        @click="toggleCardStatus(card)"
                      >
                        <i class="i-lucide-ban" />
                        <span class="ml-1">禁用</span>
                      </button>
                      <button
                        v-if="card.status === 'disabled'"
                        class="rounded px-2 py-1 text-sm font-medium text-green-600 transition-colors hover:bg-green-50 hover:text-green-900 dark:text-green-400 dark:hover:bg-green-900/20"
                        title="启用"
                        @click="toggleCardStatus(card)"
                      >
                        <i class="i-lucide-circle-check" />
                        <span class="ml-1">启用</span>
                      </button>
                      <button
                        v-if="card.status === 'unused' || card.status === 'disabled'"
                        class="rounded px-2 py-1 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
                        title="删除"
                        @click="deleteCard(card)"
                      >
                        <i class="i-lucide-trash-2" />
                        <span class="ml-1">删除</span>
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="cards.length === 0">
                  <td
                    class="px-4 py-5 text-center text-sm text-gray-500 dark:text-gray-400"
                    colspan="8"
                  >
                    暂无卡片数据
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <!-- 分页 -->
        <div
          v-if="totalCards > 0"
          class="flex flex-none flex-col items-center justify-between gap-3 border-t border-gray-200 px-1 pt-3 dark:border-gray-700 sm:flex-row"
        >
          <div class="flex items-center gap-4">
            <span class="text-sm text-gray-600 dark:text-gray-400">
              共 {{ totalCards }} 条记录
            </span>
            <div class="flex items-center gap-2">
              <span class="text-sm text-gray-600 dark:text-gray-400">每页</span>
              <div class="w-[90px]">
                <CustomDropdown
                  v-model="cardPageSize"
                  accent="gray"
                  :options="pageSizeDropdownOptions"
                  placeholder="每页"
                  size="sm"
                  @change="changeCardPageSize"
                />
              </div>
              <span class="text-sm text-gray-600 dark:text-gray-400">条</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              :disabled="cardCurrentPage === 1"
              @click="changeCardPage(cardCurrentPage - 1)"
            >
              <i class="i-lucide-chevron-left" />
            </button>
            <span class="text-sm text-gray-600 dark:text-gray-400">
              {{ cardCurrentPage }} / {{ cardTotalPages }}
            </span>
            <button
              class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              :disabled="cardCurrentPage >= cardTotalPages"
              @click="changeCardPage(cardCurrentPage + 1)"
            >
              <i class="i-lucide-chevron-right" />
            </button>
          </div>
        </div>
      </div>

      <!-- Redemptions Tab -->
      <div v-else-if="activeTab === 'redemptions'" class="flex flex-col md:min-h-0 md:flex-1">
        <!-- 查询栏 -->
        <div class="mb-3 flex flex-none flex-wrap items-center gap-2 px-0.5">
          <div class="toolbar-search-wrap">
            <i
              class="input-affix-icon input-affix-icon--left i-lucide-search"
            />
            <input
              v-model="redemptionSearch"
              class="toolbar-search-input"
              placeholder="搜索卡号 / 用户 / API Key"
              type="text"
              @keyup.enter="applyRedemptionFilters"
            />
          </div>
          <button
            class="btn btn-primary toolbar-btn-primary"
            @click="applyRedemptionFilters"
          >
            <i class="i-lucide-search mr-1.5" />查询
          </button>
          <button
            v-if="redemptionSearch"
            class="toolbar-btn"
            type="button"
            @click="resetRedemptionFilters"
          >
            重置
          </button>
          <div class="ml-auto flex shrink-0 items-center gap-2">
          <button
            class="toolbar-btn"
            type="button"
            @click="openLimitsModal"
          >
            <i class="i-lucide-shield" />
            上限保护
            <span
              v-if="limitsStatus === 'loaded'"
              class="toolbar-btn__badge"
              :class="limitsConfig.enabled ? 'is-on' : 'is-off'"
            >
              {{ limitsConfig.enabled ? '已开启' : '已关闭' }}
            </span>
            <span v-else-if="limitsStatus === 'loading'" class="text-sm text-gray-400">加载中</span>
            <span v-else class="text-sm text-red-500">加载失败</span>
          </button>
          <button
            class="toolbar-btn"
            type="button"
            @click="openRedeemLocksModal"
          >
            <i class="i-lucide-lock-keyhole" />
            兑换失败锁
            <span
              v-if="redeemLocksBadgeCount > 0"
              class="toolbar-btn__badge is-on"
            >
              {{ redeemLocksBadgeCount }}
            </span>
          </button>
          </div>
        </div>

        <!-- Table（内部滚动，表头吸顶） -->
        <div
          class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 md:min-h-0 md:flex-1 md:overflow-auto"
        >
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="sticky top-0 z-10 bg-gray-100 dark:bg-gray-700">
              <tr>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  卡号
                </th>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  用户
                </th>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  API Key
                </th>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  增加额度
                </th>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  状态
                </th>
                <th
                  class="px-4 py-3 text-left text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  核销时间
                </th>
                <th
                  class="px-4 py-3 text-right text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300"
                >
                  操作
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-800">
              <tr v-if="redemptionLoading">
                <td
                  class="px-4 py-5 text-center text-sm text-gray-500 dark:text-gray-400"
                  colspan="7"
                >
                  <i class="i-lucide-loader-circle animate-spin mr-2 text-blue-500" />加载中...
                </td>
              </tr>
              <template v-else>
                <tr
                  v-for="redemption in redemptions"
                  :key="redemption.id"
                  class="hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <td class="whitespace-nowrap px-4 py-3">
                    <code
                      class="cursor-pointer rounded bg-gray-100 px-2 py-1 font-mono text-sm hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600"
                      title="点击复制"
                      @click="copyText(redemption.cardCode)"
                    >
                      {{ redemption.cardCode }}
                    </code>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3">
                    <span
                      class="cursor-pointer text-sm text-gray-900 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
                      title="点击复制"
                      @click="copyText(redemption.username || redemption.userId)"
                    >
                      {{ redemption.username || redemption.userId }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3">
                    <span
                      class="cursor-pointer text-sm text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400"
                      title="点击复制"
                      @click="copyText(redemption.apiKeyName || redemption.apiKeyId)"
                    >
                      {{ redemption.apiKeyName || redemption.apiKeyId }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-900 dark:text-white">
                    <span v-if="redemption.quotaAdded > 0">${{ redemption.quotaAdded }}</span>
                    <span v-if="redemption.quotaAdded > 0 && redemption.timeAdded > 0"> + </span>
                    <span v-if="redemption.timeAdded > 0">
                      {{ redemption.timeAdded }}
                      {{
                        redemption.timeUnit === 'hours'
                          ? '小时'
                          : redemption.timeUnit === 'days'
                            ? '天'
                            : '月'
                      }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3">
                    <span
                      :class="[ 'inline-flex rounded-full px-2 py-1 text-sm font-medium', redemption.status === 'active' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' ]"
                    >
                      {{ redemption.status === 'active' ? '有效' : '已撤销' }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {{ formatDate(redemption.timestamp) }}
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-right">
                    <button
                      v-if="redemption.status === 'active'"
                      class="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300"
                      title="撤销核销"
                      @click="revokeRedemption(redemption)"
                    >
                      <i class="i-lucide-undo-2" />
                    </button>
                  </td>
                </tr>
                <tr v-if="redemptions.length === 0">
                  <td
                    class="px-4 py-5 text-center text-sm text-gray-500 dark:text-gray-400"
                    colspan="7"
                  >
                    暂无核销记录
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <!-- 分页 -->
        <div
          v-if="totalRedemptions > 0"
          class="flex flex-none flex-col items-center justify-between gap-3 border-t border-gray-200 px-1 pt-3 dark:border-gray-700 sm:flex-row"
        >
          <div class="flex items-center gap-4">
            <span class="text-sm text-gray-600 dark:text-gray-400">
              共 {{ totalRedemptions }} 条记录
            </span>
            <div class="flex items-center gap-2">
              <span class="text-sm text-gray-600 dark:text-gray-400">每页</span>
              <div class="w-[90px]">
                <CustomDropdown
                  v-model="redemptionPageSize"
                  accent="gray"
                  :options="pageSizeDropdownOptions"
                  placeholder="每页"
                  size="sm"
                  @change="changeRedemptionPageSize"
                />
              </div>
              <span class="text-sm text-gray-600 dark:text-gray-400">条</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              :disabled="redemptionCurrentPage === 1"
              @click="changeRedemptionPage(redemptionCurrentPage - 1)"
            >
              <i class="i-lucide-chevron-left" />
            </button>
            <span class="text-sm text-gray-600 dark:text-gray-400">
              {{ redemptionCurrentPage }} / {{ redemptionTotalPages }}
            </span>
            <button
              class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              :disabled="redemptionCurrentPage >= redemptionTotalPages"
              @click="changeRedemptionPage(redemptionCurrentPage + 1)"
            >
              <i class="i-lucide-chevron-right" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Card Modal -->
    <ModalTransition>
      <div
        v-if="showCreateModal"
        class="modal fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div class="modal-content mx-auto max-h-[90vh] w-full max-w-lg overflow-y-auto p-3 sm:p-4">
          <!-- Header -->
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div
                class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600"
              >
                <i class="i-lucide-ticket text-white" />
              </div>
              <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">创建额度卡</h3>
            </div>
            <button
              class="p-1 text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              @click="showCreateModal = false"
            >
              <i class="i-lucide-x text-xl" />
            </button>
          </div>

          <!-- Form -->
          <div class="space-y-4">
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >卡片类型</label
              >
              <CustomDropdown
                v-model="newCard.type"
                accent="blue"
                icon="i-lucide-ticket"
                :options="cardTypeOptions"
                placeholder="选择卡片类型"
              />
            </div>

            <div v-if="newCard.type === 'quota' || newCard.type === 'combo'">
              <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >额度数量 (美元)</label
              >
              <input
                v-model.number="newCard.quotaAmount"
                class="form-input w-full"
                min="0"
                step="0.1"
                type="number"
              />
            </div>

            <div v-if="newCard.type === 'time' || newCard.type === 'combo'">
              <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >时间数量</label
              >
              <div class="flex gap-2">
                <input
                  v-model.number="newCard.timeAmount"
                  class="form-input w-full"
                  min="1"
                  type="number"
                />
                <div class="w-[110px]">
                  <CustomDropdown
                    v-model="newCard.timeUnit"
                    accent="blue"
                    :options="timeUnitOptions"
                    placeholder="单位"
                  />
                </div>
              </div>
            </div>

            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >批量生成数量</label
              >
              <input
                v-model.number="newCard.count"
                class="form-input w-full"
                min="1"
                type="number"
              />
            </div>

            <!-- 卡号前缀 -->
            <div>
              <div class="mb-1 flex items-center justify-between">
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >卡号前缀</label
                >
                <label
                  class="flex cursor-pointer items-center gap-2 text-sm text-gray-600 dark:text-gray-400"
                >
                  <input
                    v-model="newCard.usePrefix"
                    class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                    type="checkbox"
                  />
                  使用前缀
                </label>
              </div>
              <input
                v-model="newCard.codePrefix"
                class="form-input w-full"
                :disabled="!newCard.usePrefix"
                maxlength="16"
                placeholder="如 CC、VIP（仅字母数字，自动转大写）"
                type="text"
              />
              <p class="mt-1 text-sm text-gray-400">卡号示例：{{ cardCodeExample }}</p>
            </div>

            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >备注（可选）</label
              >
              <input
                v-model="newCard.note"
                class="form-input w-full"
                placeholder="例如：新年促销卡"
                type="text"
              />
            </div>
          </div>

          <!-- Footer -->
          <div class="mt-6 flex gap-3">
            <button
              class="toolbar-btn h-10 flex-1 px-4 text-sm font-medium"
              type="button"
              @click="showCreateModal = false"
            >
              取消
            </button>
            <button
              class="btn btn-primary h-10 flex-1 px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="creating"
              type="button"
              @click="createCard"
            >
              <i v-if="creating" class="i-lucide-loader-circle animate-spin mr-2" />
              {{ creating ? '创建中...' : '创建' }}
            </button>
          </div>
        </div>
      </div>
    </ModalTransition>

    <!-- Limits Config Modal -->
    <ModalTransition>
      <div
        v-if="showLimitsModal"
        class="modal fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div class="modal-content mx-auto max-h-[90vh] w-full max-w-md overflow-y-auto p-3 sm:p-4">
          <!-- Header -->
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div
                class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600"
              >
                <i class="i-lucide-shield text-white" />
              </div>
              <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">兑换上限保护</h3>
            </div>
            <button
              class="p-1 text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              @click="showLimitsModal = false"
            >
              <i class="i-lucide-x text-xl" />
            </button>
          </div>

          <p class="mb-4 text-sm text-gray-500 dark:text-gray-400">
            开启后，创建额度卡时的额度与有效期不能超过以下上限，防止误操作生成超大额度卡。
          </p>

          <!-- 加载状态 -->
          <p v-if="limitsStatus === 'loading'" class="text-sm text-gray-400">上限配置加载中...</p>
          <p v-else-if="limitsStatus === 'error'" class="text-sm text-red-500">
            上限配置加载失败，已禁用编辑以防覆盖服务器配置，请刷新页面重试
          </p>

          <!-- Form -->
          <div v-else class="space-y-4">
            <!-- 启用开关 -->
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-gray-700 dark:text-gray-300">启用上限保护</span>
              <label class="relative inline-flex cursor-pointer items-center">
                <input v-model="limitsForm.enabled" class="peer sr-only" type="checkbox" />
                <div class="app-toggle-track" />
              </label>
            </div>

            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >最大额度 (美元)</label
              >
              <input
                v-model.number="limitsForm.maxTotalCostLimit"
                class="form-input w-full"
                :disabled="!limitsForm.enabled"
                min="0"
                type="number"
              />
            </div>

            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >最大有效期 (天)</label
              >
              <input
                v-model.number="limitsForm.maxExpiryDays"
                class="form-input w-full"
                :disabled="!limitsForm.enabled"
                min="0"
                type="number"
              />
            </div>
          </div>

          <!-- Footer -->
          <div class="mt-6 flex gap-3">
            <button
              class="toolbar-btn h-10 flex-1 px-4 text-sm font-medium"
              type="button"
              @click="showLimitsModal = false"
            >
              取消
            </button>
            <button
              class="btn btn-primary h-10 flex-1 px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="savingLimits || limitsStatus !== 'loaded'"
              type="button"
              @click="saveLimits"
            >
              <i v-if="savingLimits" class="i-lucide-loader-circle animate-spin mr-2" />
              {{ savingLimits ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </ModalTransition>

    <!-- 兑换失败锁管理 -->
    <ModalTransition>
      <div
        v-if="showRedeemLocksModal"
        class="modal fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div class="modal-content mx-auto flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden p-3 sm:p-4">
          <div class="mb-3 flex shrink-0 items-center justify-between">
            <div class="flex items-center gap-3">
              <div
                class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-red-500 to-orange-600"
              >
                <i class="i-lucide-lock-keyhole text-white" />
              </div>
              <div>
                <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">兑换失败锁</h3>
                <p class="text-sm text-gray-500 dark:text-gray-400">
                  公开兑换页错码累计达 {{ redeemLocksMeta.threshold || 5 }} 次会锁 IP
                  {{ Math.round((redeemLocksMeta.windowSeconds || 3600) / 3600) }} 小时
                </p>
              </div>
            </div>
            <button
              class="p-1 text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              type="button"
              @click="showRedeemLocksModal = false"
            >
              <i class="i-lucide-x text-xl" />
            </button>
          </div>

          <div class="mb-3 flex shrink-0 flex-wrap items-center gap-2">
            <button
              class="toolbar-btn"
              :disabled="redeemLocksLoading"
              type="button"
              @click="loadRedeemLocks"
            >
              <i
                :class="[
                  redeemLocksLoading ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw',
                  'mr-1'
                ]"
              />
              刷新
            </button>
            <button
              class="toolbar-btn text-red-600 dark:text-red-400"
              :disabled="redeemLocksLoading || redeemLocks.length === 0 || redeemLocksClearing"
              type="button"
              @click="clearAllRedeemLocks"
            >
              <i
                :class="[
                  redeemLocksClearing ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-trash-2',
                  'mr-1'
                ]"
              />
              全部解锁
            </button>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto">
            <p
              v-if="redeemLocksLoading && redeemLocks.length === 0"
              class="py-8 text-center text-sm text-gray-500"
            >
              加载中...
            </p>
            <p
              v-else-if="!redeemLocksLoading && redeemLocks.length === 0"
              class="py-8 text-center text-sm text-gray-500"
            >
              当前没有兑换失败锁
            </p>
            <table
              v-else
              class="min-w-full divide-y divide-gray-200 dark:divide-gray-700"
            >
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr class="text-left text-sm text-gray-500 dark:text-gray-400">
                  <th class="px-3 py-2">IP</th>
                  <th class="px-3 py-2">失败次数</th>
                  <th class="px-3 py-2">状态</th>
                  <th class="px-3 py-2">剩余 TTL</th>
                  <th class="px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                <tr
                  v-for="row in redeemLocks"
                  :key="row.ip"
                  class="text-sm"
                >
                  <td class="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">
                    {{ row.ip }}
                  </td>
                  <td class="px-3 py-2 text-gray-700 dark:text-gray-300">
                    {{ row.failCount }} / {{ row.threshold || redeemLocksMeta.threshold || 5 }}
                  </td>
                  <td class="px-3 py-2">
                    <span
                      class="inline-flex rounded-full px-2 py-0.5 text-sm font-medium"
                      :class="
                        row.locked
                          ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                      "
                    >
                      {{ row.locked ? '已锁定' : '计数中' }}
                    </span>
                  </td>
                  <td class="px-3 py-2 text-gray-600 dark:text-gray-400">
                    {{ formatRedeemLockTtl(row.ttlSeconds) }}
                  </td>
                  <td class="px-3 py-2 text-right">
                    <button
                      class="rounded border border-gray-200 px-2 py-1 text-sm text-blue-600 hover:bg-gray-50 dark:border-gray-600 dark:text-blue-400 dark:hover:bg-gray-800"
                      :disabled="redeemLocksUnlockingIp === row.ip"
                      type="button"
                      @click="unlockRedeemLock(row.ip)"
                    >
                      {{ redeemLocksUnlockingIp === row.ip ? '解锁中...' : '解锁' }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </ModalTransition>

    <!-- Result Modal -->
    <ModalTransition>
      <div
        v-if="showResultModal"
        class="modal fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div class="modal-content mx-auto w-full max-w-lg p-3 sm:p-4">
          <!-- Header -->
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div
                class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-green-500 to-green-600"
              >
                <i class="i-lucide-check text-white" />
              </div>
              <div>
                <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">创建成功</h3>
                <p class="text-sm text-gray-500 dark:text-gray-400">
                  已创建 {{ createdCards.length }} 张卡片
                </p>
              </div>
            </div>
            <button
              class="p-1 text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              @click="showResultModal = false"
            >
              <i class="i-lucide-x text-xl" />
            </button>
          </div>

          <!-- Card List -->
          <div class="mb-4 max-h-60 overflow-y-auto rounded-lg bg-gray-50 p-3 dark:bg-gray-700/50">
            <div
              v-for="(card, index) in createdCards"
              :key="card.id"
              class="flex items-center justify-between border-b border-gray-200 py-2 last:border-0 dark:border-gray-600"
            >
              <div class="flex items-center gap-2">
                <span class="text-sm text-gray-400">{{ index + 1 }}.</span>
                <code class="font-mono text-sm text-gray-900 dark:text-white">{{ card.code }}</code>
              </div>
              <span class="text-sm text-gray-500 dark:text-gray-400">
                <template v-if="card.type === 'quota' || card.type === 'combo'">
                  ${{ card.quotaAmount }}
                </template>
                <template v-if="card.type === 'combo'"> + </template>
                <template v-if="card.type === 'time' || card.type === 'combo'">
                  {{ card.timeAmount }}
                  {{ card.timeUnit === 'hours' ? '小时' : card.timeUnit === 'days' ? '天' : '月' }}
                </template>
              </span>
            </div>
          </div>

          <!-- Warning -->
          <div
            class="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-700 dark:bg-yellow-900/20"
          >
            <div class="flex items-start gap-2">
              <i class="i-lucide-triangle-alert mt-0.5 text-yellow-500" />
              <p class="text-sm text-yellow-700 dark:text-yellow-300">
                请立即下载或复制卡号，关闭后将无法再次查看完整卡号列表。
              </p>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex gap-3">
            <button
              class="btn btn-primary h-10 flex-1 px-4 text-sm font-medium"
              type="button"
              @click="downloadCards"
            >
              <i class="i-lucide-download mr-2" />
              下载 TXT
            </button>
            <button
              class="toolbar-btn h-10 flex-1 px-4 text-sm font-medium"
              type="button"
              @click="copyAllCards"
            >
              <i class="i-lucide-copy mr-2" />
              复制全部
            </button>
          </div>
        </div>
      </div>
    </ModalTransition>
    <!-- Revoke Modal -->
    <ModalTransition>
      <div
        v-if="showRevokeModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
        @click.self="showRevokeModal = false"
      >
        <div
          class="modal-panel w-full max-w-md rounded-2xl bg-white p-4 shadow-2xl dark:bg-gray-800"
        >
          <h3 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">撤销核销</h3>
          <div class="mb-4">
            <label class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              撤销原因（可选）
            </label>
            <input
              v-model="revokeReason"
              class="form-input w-full"
              placeholder="请输入撤销原因"
              type="text"
            />
          </div>
          <div class="flex shrink-0 items-center justify-end gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
            <button
              class="inline-flex h-10 items-center justify-center rounded-lg bg-gray-100 px-4 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              type="button"
              @click="showRevokeModal = false"
            >
              取消
            </button>
            <button
              class="inline-flex h-10 items-center justify-center rounded-lg bg-red-500 px-4 text-sm font-medium text-white hover:bg-red-600"
              type="button"
              @click="executeRevoke"
            >
              确认撤销
            </button>
          </div>
        </div>
      </div>
    </ModalTransition>

    <!-- Confirm Modal -->
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

    <!-- 批量操作：底部浮动，不挤占列表高度 -->
    <Teleport to="body">
      <div
        v-if="activeTab === 'cards' && selectedCards.length > 0"
        class="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-3"
      >
        <div
          class="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-2xl border border-blue-200/80 bg-white/95 px-3 py-2 shadow-xl backdrop-blur dark:border-blue-800/60 dark:bg-gray-900/95"
        >
          <span class="whitespace-nowrap text-sm font-medium text-blue-700 dark:text-blue-300">
            已选择 {{ selectedCards.length }} 张
          </span>
          <button
            class="whitespace-nowrap rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600"
            type="button"
            @click="deleteSelectedCards"
          >
            <i class="i-lucide-trash-2 mr-1" />
            批量删除
          </button>
          <button
            class="whitespace-nowrap rounded-lg bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            type="button"
            @click="selectedCards = []"
          >
            取消选择
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import SegmentedTabs from '@/components/common/segmented_tabs.vue'
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import ConfirmModal from '@/components/common/confirm_modal.vue'
import ModalTransition from '@/components/common/modal_transition.vue'

import * as httpApis from '@/libs/http_apis'
import { isOk, msgOf, dataOf } from '@/libs/http_envelope'
import { showToast, copyText, formatDate, calcViewportBottomReserve } from '@/libs/tools'

const loading = ref(false)
const redemptionLoading = ref(false)
const creating = ref(false)
const showCreateModal = ref(false)
const showLimitsModal = ref(false)
const savingLimits = ref(false)
const showRedeemLocksModal = ref(false)
const redeemLocksLoading = ref(false)
const redeemLocksClearing = ref(false)
const redeemLocksUnlockingIp = ref('')
const redeemLocks = ref([])
const redeemLocksMeta = ref({ threshold: 5, windowSeconds: 3600 })
const redeemLocksBadgeCount = computed(
  () => redeemLocks.value.filter((row) => row.locked).length
)
const showResultModal = ref(false)
const showConfirmModal = ref(false)
const confirmModalConfig = ref({
  title: '',
  message: '',
  type: 'primary',
  confirmText: '确认',
  cancelText: '取消'
})
const confirmResolve = ref(null)
const createdCards = ref([])
const showRevokeModal = ref(false)
const revokeReason = ref('')
const revokingRedemption = ref(null)
const activeTab = ref('cards')
const selectedCards = ref([])

const pageSizeDropdownOptions = [
  { value: 20, label: '20' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
  { value: 200, label: '200' }
]

const cardTypeFilterOptions = [
  { value: '', label: '全部类型' },
  { value: 'quota', label: '额度卡' },
  { value: 'time', label: '时间卡' },
  { value: 'combo', label: '组合卡' }
]

const cardStatusFilterOptions = [
  { value: '', label: '全部状态' },
  { value: 'unused', label: '未使用' },
  { value: 'redeemed', label: '已核销' },
  { value: 'revoked', label: '已撤销' },
  { value: 'expired', label: '已过期' },
  { value: 'disabled', label: '已禁用' }
]

const cardTypeOptions = [
  { value: 'quota', label: '额度卡' },
  { value: 'time', label: '时间卡' },
  { value: 'combo', label: '组合卡' }
]

const timeUnitOptions = [
  { value: 'hours', label: '小时' },
  { value: 'days', label: '天' },
  { value: 'months', label: '月' }
]

// 卡片查询/分页
const cardSearch = ref('')
const cardTypeFilter = ref('')
const cardStatusFilter = ref('')
const cardCurrentPage = ref(1)
const cardPageSize = ref(100)
const totalCards = ref(0)

// 核销查询/分页
const redemptionSearch = ref('')
const redemptionCurrentPage = ref(1)
const redemptionPageSize = ref(100)
const totalRedemptions = ref(0)

const tabs = [
  { id: 'cards', name: '卡片列表' },
  { id: 'redemptions', name: '核销记录' }
]

const stats = ref({
  total: 0,
  unused: 0,
  redeemed: 0,
  revoked: 0,
  expired: 0
})

const limitsConfig = ref({
  enabled: true,
  maxExpiryDays: 90,
  maxTotalCostLimit: 1000
})
// 上限配置加载状态：loading（加载中）| loaded（成功）| error（失败）
// 仅 loaded 时允许编辑/保存，避免用默认值覆盖真实配置；区分 loading 与 error 防止首屏误报失败
const limitsStatus = ref('loading')
// dialog 内编辑的工作副本，打开时从 limitsConfig 拷贝，保存成功后回写，取消则丢弃
const limitsForm = ref({
  enabled: true,
  maxExpiryDays: 90,
  maxTotalCostLimit: 1000
})

const cards = ref([])
const redemptions = ref([])

// 可选择的卡片（只有未使用的才能选择）
const selectableCards = computed(() => cards.value.filter((c) => c.status === 'unused'))

// 是否全选
const isAllSelected = computed(
  () =>
    selectableCards.value.length > 0 && selectedCards.value.length === selectableCards.value.length
)

// 是否部分选中
const isIndeterminate = computed(
  () => selectedCards.value.length > 0 && selectedCards.value.length < selectableCards.value.length
)

// 切换全选
const toggleSelectAll = () => {
  if (isAllSelected.value) {
    selectedCards.value = []
  } else {
    selectedCards.value = selectableCards.value.map((c) => c.id)
  }
}

// 切换单个选择
const toggleSelectCard = (cardId) => {
  const index = selectedCards.value.indexOf(cardId)
  if (index === -1) {
    selectedCards.value.push(cardId)
  } else {
    selectedCards.value.splice(index, 1)
  }
}

const newCard = ref({
  type: 'quota',
  quotaAmount: 10,
  timeAmount: 30,
  timeUnit: 'days',
  count: 1,
  note: '',
  usePrefix: true,
  codePrefix: 'CC'
})

// 卡号示例（与后端清洗规则一致）
const cardCodeExample = computed(() => {
  const prefix = newCard.value.usePrefix
    ? newCard.value.codePrefix
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 16)
    : ''
  return prefix ? `${prefix}_A2B3_C4D5_E6F7` : 'A2B3_C4D5_E6F7'
})

const showConfirm = (
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  type = 'primary'
) => {
  return new Promise((resolve) => {
    confirmModalConfig.value = { title, message, confirmText, cancelText, type }
    confirmResolve.value = resolve
    showConfirmModal.value = true
  })
}
const handleConfirmModal = () => {
  showConfirmModal.value = false
  confirmResolve.value?.(true)
}
const handleCancelModal = () => {
  showConfirmModal.value = false
  confirmResolve.value?.(false)
}

// 加载卡片列表 + 统计
const loadCards = async () => {
  loading.value = true
  try {
    const offset = (cardCurrentPage.value - 1) * cardPageSize.value
    const [cardsData, statsData] = await Promise.all([
      httpApis.getQuotaCardsWithParamsApi({
        limit: cardPageSize.value,
        offset,
        search: cardSearch.value || undefined,
        type: cardTypeFilter.value || undefined,
        status: cardStatusFilter.value || undefined
      }),
      httpApis.getQuotaCardsStatsApi()
    ])
    if (!isOk(cardsData)) {
      showToast(msgOf(cardsData, '加载卡片列表失败'), 'error')
    } else {
      cards.value = cardsData.data?.cards || []
      totalCards.value = cardsData.data?.total || 0
    }
    if (isOk(statsData)) {
      stats.value = statsData.data || stats.value
    } else {
      showToast(msgOf(statsData, '加载统计失败'), 'error')
    }
  } catch (error) {
    console.error('加载卡片列表异常:', error)
    showToast('加载卡片列表失败', 'error')
  } finally {
    loading.value = false
  }
}

// 加载核销记录
const loadRedemptions = async () => {
  redemptionLoading.value = true
  try {
    const offset = (redemptionCurrentPage.value - 1) * redemptionPageSize.value
    const data = await httpApis.getRedemptionsApi({
      limit: redemptionPageSize.value,
      offset,
      search: redemptionSearch.value || undefined
    })
    if (!isOk(data)) {
      showToast(msgOf(data, '加载核销记录失败'), 'error')
      return
    }
    redemptions.value = data.data?.redemptions || []
    totalRedemptions.value = data.data?.total || 0
  } catch (error) {
    console.error('加载核销记录异常:', error)
    showToast('加载核销记录失败', 'error')
  } finally {
    redemptionLoading.value = false
  }
}

// 加载上限配置
const loadLimits = async () => {
  limitsStatus.value = 'loading'
  try {
    const result = await httpApis.getQuotaCardLimitsApi()
    if (isOk(result)) {
      if (result.data) {
        limitsConfig.value = result.data
      }
      limitsStatus.value = 'loaded'
    } else {
      limitsStatus.value = 'error'
      showToast(msgOf(result, '加载上限配置失败'), 'error')
    }
  } catch (error) {
    limitsStatus.value = 'error'
    console.error('加载上限配置异常:', error)
    showToast('加载上限配置失败', 'error')
  }
}

const openLimitsModal = () => {
  limitsForm.value = { ...limitsConfig.value }
  showLimitsModal.value = true
}

const formatRedeemLockTtl = (ttlSeconds) => {
  const seconds = Number(ttlSeconds) || 0
  if (seconds <= 0) return '-'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
}

const loadRedeemLocks = async () => {
  redeemLocksLoading.value = true
  try {
    const result = await httpApis.getRedeemCardLocksApi()
    if (!isOk(result)) {
      showToast(msgOf(result, '加载兑换失败锁失败'), 'error')
      return
    }
    const payload = dataOf(result, {}) || {}
    redeemLocks.value = Array.isArray(payload.locks) ? payload.locks : []
    redeemLocksMeta.value = {
      threshold: payload.threshold || 5,
      windowSeconds: payload.windowSeconds || 3600
    }
  } catch (_error) {
    showToast('加载兑换失败锁失败', 'error')
  } finally {
    redeemLocksLoading.value = false
  }
}

const openRedeemLocksModal = async () => {
  showRedeemLocksModal.value = true
  await loadRedeemLocks()
}

const unlockRedeemLock = async (ip) => {
  if (!ip) return
  redeemLocksUnlockingIp.value = ip
  try {
    const result = await httpApis.unlockRedeemCardLockApi(ip)
    if (!isOk(result)) {
      showToast(msgOf(result, '解锁失败'), 'error')
      return
    }
    showToast(`已解锁 ${ip}`, 'success')
    await loadRedeemLocks()
  } catch (_error) {
    showToast('解锁失败', 'error')
  } finally {
    redeemLocksUnlockingIp.value = ''
  }
}

const clearAllRedeemLocks = async () => {
  if (redeemLocks.value.length === 0) return
  const confirmed = await showConfirm(
    '全部解锁',
    `确定清空当前 ${redeemLocks.value.length} 条兑换失败锁吗？`,
    '全部解锁',
    '取消',
    'danger'
  )
  if (!confirmed) return
  redeemLocksClearing.value = true
  try {
    const result = await httpApis.clearAllRedeemCardLocksApi()
    if (!isOk(result)) {
      showToast(msgOf(result, '清空失败'), 'error')
      return
    }
    const payload = dataOf(result, {}) || {}
    showToast(`已解锁 ${payload.unlocked || 0} 条`, 'success')
    await loadRedeemLocks()
  } catch (_error) {
    showToast('清空失败', 'error')
  } finally {
    redeemLocksClearing.value = false
  }
}

const saveLimits = async () => {
  if (limitsStatus.value !== 'loaded') {
    showToast('上限配置尚未加载成功，无法保存', 'error')
    return
  }
  savingLimits.value = true
  try {
    const result = await httpApis.updateQuotaCardLimitsApi(limitsForm.value)
    if (isOk(result)) {
      limitsConfig.value = { ...limitsForm.value }
      showLimitsModal.value = false
      showToast('配置已保存', 'success')
    } else {
      showToast(msgOf(result, '配置保存失败'), 'error')
    }
  } catch (error) {
    console.error('保存上限配置异常:', error)
    showToast('配置保存失败', 'error')
  } finally {
    savingLimits.value = false
  }
}

// 弹窗在配置加载完成前被打开时，limitsForm 是默认值快照；待 loadLimits 完成（limitsConfig 已更新、
// 状态转 loaded）后用真实配置刷新表单，避免把默认值当成真实值保存而覆盖服务器配置。
// 加载中表单字段不渲染（仅 loaded 分支显示）、保存按钮禁用，故此刷新不会覆盖用户编辑
watch(limitsStatus, (status) => {
  if (status === 'loaded' && showLimitsModal.value) {
    limitsForm.value = { ...limitsConfig.value }
  }
})

// 卡片分页
const cardTotalPages = computed(() => Math.max(1, Math.ceil(totalCards.value / cardPageSize.value)))

const applyCardFilters = () => {
  cardCurrentPage.value = 1
  selectedCards.value = []
  loadCards()
}

const resetCardFilters = () => {
  cardSearch.value = ''
  cardTypeFilter.value = ''
  cardStatusFilter.value = ''
  applyCardFilters()
}

const changeCardPage = (page) => {
  if (page < 1 || page > cardTotalPages.value) {
    return
  }
  cardCurrentPage.value = page
  selectedCards.value = []
  loadCards()
}

const changeCardPageSize = () => {
  cardCurrentPage.value = 1
  selectedCards.value = []
  loadCards()
}

// 核销分页
const redemptionTotalPages = computed(() =>
  Math.max(1, Math.ceil(totalRedemptions.value / redemptionPageSize.value))
)

const applyRedemptionFilters = () => {
  redemptionCurrentPage.value = 1
  loadRedemptions()
}

const resetRedemptionFilters = () => {
  redemptionSearch.value = ''
  applyRedemptionFilters()
}

const changeRedemptionPage = (page) => {
  if (page < 1 || page > redemptionTotalPages.value) {
    return
  }
  redemptionCurrentPage.value = page
  loadRedemptions()
}

const changeRedemptionPageSize = () => {
  redemptionCurrentPage.value = 1
  loadRedemptions()
}

const createCard = async () => {
  if (newCard.value.usePrefix && !newCard.value.codePrefix.trim()) {
    showToast('请输入卡号前缀，或关闭"使用前缀"', 'error')
    return
  }
  creating.value = true
  try {
    const payload = {
      ...newCard.value,
      codePrefix: newCard.value.usePrefix ? newCard.value.codePrefix.trim() : ''
    }
    const result = await httpApis.createQuotaCardApi(payload)
    if (isOk(result)) {
      showCreateModal.value = false

      // 处理返回的卡片数据
      const data = result.data
      if (Array.isArray(data)) {
        createdCards.value = data
      } else if (data) {
        createdCards.value = [data]
      } else {
        createdCards.value = []
      }

      // 显示结果弹窗
      if (createdCards.value.length > 0) {
        showResultModal.value = true
      }

      showToast(`成功创建 ${createdCards.value.length} 张卡片`, 'success')
      applyCardFilters()
    } else {
      showToast(msgOf(result, '创建卡片失败'), 'error')
    }
  } catch (error) {
    console.error('创建卡片异常:', error)
    showToast('创建卡片失败', 'error')
  } finally {
    creating.value = false
  }
}

// 下载卡片
const downloadCards = () => {
  if (createdCards.value.length === 0) return

  const content = createdCards.value
    .map((card) => {
      let label = ''
      if (card.type === 'quota' || card.type === 'combo') {
        label += `$${card.quotaAmount}`
      }
      if (card.type === 'combo') {
        label += '_'
      }
      if (card.type === 'time' || card.type === 'combo') {
        const unitMap = { hours: 'h', days: 'd', months: 'm' }
        label += `${card.timeAmount}${unitMap[card.timeUnit] || card.timeUnit}`
      }
      return `${label} ${card.code}`
    })
    .join('\n')

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
  link.download = `quota-cards-${timestamp}.txt`

  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)

  showToast('卡片文件已下载', 'success')
}

// 复制所有卡号
const copyAllCards = async () => {
  if (createdCards.value.length === 0) return

  const content = createdCards.value.map((card) => card.code).join('\n')

  try {
    await navigator.clipboard.writeText(content)
    showToast('已复制所有卡号', 'success')
  } catch (error) {
    console.error('Failed to copy:', error)
    showToast('复制失败', 'error')
  }
}

const cardStatusLabel = (status) => {
  const map = {
    unused: '未使用',
    redeemed: '已核销',
    expired: '已过期',
    revoked: '已撤销',
    disabled: '已禁用'
  }
  return map[status] || status
}

const toggleCardStatus = async (card) => {
  const enabled = card.status === 'disabled'
  const result = await httpApis.toggleQuotaCardApi(card.id, enabled)
  if (!isOk(result)) {
    // 404 卡已不存在 / 409 状态已变更：均说明本地列表已过时，提示后刷新与服务端对齐
    if (result.httpStatus === 404) {
      showToast('卡片不存在，可能已被删除', 'error')
      loadCards()
    } else if (result.httpStatus === 409) {
      showToast(msgOf(result, '卡片状态已变更，无法执行该操作'), 'warning')
      loadCards()
    } else {
      showToast(msgOf(result, '操作失败'), 'error')
    }
    return
  }
  showToast(enabled ? '卡片已启用' : '卡片已禁用', 'success')
  loadCards()
}

const deleteCard = async (card) => {
  const confirmed = await showConfirm(
    '删除卡片',
    `确定删除卡片 ${card.code}？`,
    '确定删除',
    '取消',
    'danger'
  )
  if (!confirmed) return

  const result = await httpApis.deleteQuotaCardApi(card.id)
  if (!isOk(result)) {
    // 404 卡已不存在：等价于删除目的已达成，提示并刷新与服务端对齐；409 状态冲突单独提示
    if (result.httpStatus === 404) {
      showToast('卡片不存在，可能已被删除', 'warning')
      loadCards()
      return
    }
    if (result.httpStatus === 409) {
      showToast(msgOf(result, '该状态的卡片无法删除'), 'warning')
      loadCards()
      return
    }
    showToast(msgOf(result, '删除卡片失败'), 'error')
    return
  }
  showToast('卡片已删除', 'success')
  loadCards()
}

const deleteSelectedCards = async () => {
  const confirmed = await showConfirm(
    '批量删除',
    `确定删除选中的 ${selectedCards.value.length} 张卡片？`,
    '确定删除',
    '取消',
    'danger'
  )
  if (!confirmed) return

  const results = await Promise.all(
    selectedCards.value.map((id) => httpApis.deleteQuotaCardApi(id))
  )
  // 按 httpStatus 分类汇总，与单条删除语义对齐：404（卡已不存在）视作删除目的已达成
  let ok = 0
  let conflict = 0
  let failed = 0
  for (const r of results) {
    if (isOk(r) || r.httpStatus === 404) ok += 1
    else if (r.httpStatus === 409) conflict += 1
    else failed += 1
  }
  if (failed > 0 || conflict > 0) {
    const parts = [`成功 ${ok} 张`]
    if (conflict > 0) parts.push(`状态不允许 ${conflict} 张`)
    if (failed > 0) parts.push(`失败 ${failed} 张`)
    showToast(parts.join('，'), ok > 0 ? 'warning' : 'error')
  } else {
    showToast(`已删除 ${ok} 张卡片`, 'success')
  }
  selectedCards.value = []
  loadCards()
}

const revokeRedemption = (redemption) => {
  revokingRedemption.value = redemption
  revokeReason.value = ''
  showRevokeModal.value = true
}

const executeRevoke = async () => {
  if (!revokingRedemption.value) return
  const result = await httpApis.revokeRedemptionApi(revokingRedemption.value.id, {
    reason: revokeReason.value
  })
  if (!isOk(result)) {
    showToast(msgOf(result, '撤销失败'), 'error')
    return
  }
  showToast('核销已撤销', 'success')
  showRevokeModal.value = false
  revokingRedemption.value = null
  // 撤销会同时影响卡片状态、核销记录与统计
  loadRedemptions()
  loadCards()
}

// 让卡片填满 AppHeader 以下的剩余视口空间（动态测量，避免魔数与双滚动）
// 两个分支统一用 height（保留卡片铺满视口的设计）；极矮视口下头部 flex-none 撑破 N 时，
// 由容器自身的 overflow-y-auto 内部滚动兜底，页面始终不溢出
const cardRef = ref(null)
const cardHeight = ref(null)
// 移动端（< md 768px）不锁高度：让容器自然撑开、整页滚动，避免 header 占满后剩余空间被压到接近 0
// 桌面端保留动态测量铺满视口 + 内部滚动
const MOBILE_BREAKPOINT = 768
const isMobile = ref(typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT)

// 扣除 .tab-content 进场动画的 translateY：getBoundingClientRect 含 transform，
// 动画期间 raw top 会偏大 → 算出的 height 偏小，动画结束后再校正就会「高度抖动」
const getStableTop = (el) => {
  let top = el.getBoundingClientRect().top
  let node = el.parentElement
  while (node && node !== document.documentElement) {
    if (node.classList?.contains('tab-content')) {
      const transform = getComputedStyle(node).transform
      if (transform && transform !== 'none') {
        try {
          top -= new DOMMatrixReadOnly(transform).m42
        } catch {
          // DOMMatrixReadOnly 不可用时忽略，退回 raw top
        }
      }
    }
    node = node.parentElement
  }
  return top
}

const cardStyle = computed(() => {
  if (isMobile.value) {
    return {}
  }
  // 统一走像素高度，避免 calc(100dvh-220px) 与实测两套算法切换时跳变
  if (cardHeight.value != null) {
    return { height: `${cardHeight.value}px` }
  }
  if (typeof window === 'undefined') {
    return {}
  }
  return { height: `${Math.max(0, window.innerHeight - 220)}px` }
})

const updateCardHeight = () => {
  const el = cardRef.value
  if (!el) {
    return
  }
  isMobile.value = window.innerWidth < MOBILE_BREAKPOINT
  // 移动端不测量、不锁高度，交给自然流 + 整页滚动
  if (isMobile.value) {
    cardHeight.value = null
    return
  }
  const top = getStableTop(el)
  // 系统化扣除 card 底边到视口底的固定占用（外层 glass/页面的 padding/border 等），不写死魔数；
  // 不设固定下限——下限会在剩余空间小于它时把卡片强行撑高反而溢出（旧的 360 即此 bug）
  const next = Math.max(0, Math.floor(window.innerHeight - top - calcViewportBottomReserve(el)))
  // 忽略 1px 级抖动（亚像素/滚动条），避免无意义回写触发布局
  if (cardHeight.value == null || Math.abs(next - cardHeight.value) > 1) {
    cardHeight.value = next
  }
}

// 用 rAF 合并同一帧内的多次触发
let cardHeightRaf = 0
const scheduleUpdateCardHeight = () => {
  if (cardHeightRaf) {
    return
  }
  cardHeightRaf = window.requestAnimationFrame(() => {
    cardHeightRaf = 0
    updateCardHeight()
  })
}

let cardResizeObserver = null
let cardAnimationTarget = null

// 观察会推动 card 位置的元素：祖先链 + 各祖先的前置兄弟（含 AppHeader、TabBar）
// 不 observe card 自身——自身 height 写入会触发 ResizeObserver，徒增一轮空转
const observeLayoutTargets = () => {
  if (!cardResizeObserver || !cardRef.value) {
    return
  }
  let node = cardRef.value.parentElement
  while (node && node !== document.documentElement) {
    cardResizeObserver.observe(node)
    let sibling = node.previousElementSibling
    while (sibling) {
      cardResizeObserver.observe(sibling)
      sibling = sibling.previousElementSibling
    }
    node = node.parentElement
  }
}

onMounted(() => {
  loadLimits()
  loadCards()
  loadRedemptions()
  // 角标：静默拉失败锁数量（失败不影响主流程）
  loadRedeemLocks().catch(() => {})
  window.addEventListener('resize', scheduleUpdateCardHeight)
  if (typeof ResizeObserver !== 'undefined') {
    cardResizeObserver = new ResizeObserver(scheduleUpdateCardHeight)
  }
  // 同步首测（含 transform 补偿），尽量在首帧就落到最终高度
  updateCardHeight()
  // 仍监听 animationend 作兜底（补偿失效或浏览器差异时校正一次）
  cardAnimationTarget = cardRef.value?.closest('.tab-content') || null
  if (cardAnimationTarget) {
    cardAnimationTarget.addEventListener('animationend', scheduleUpdateCardHeight)
  }
  nextTick(() => {
    updateCardHeight()
    observeLayoutTargets()
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleUpdateCardHeight)
  if (cardAnimationTarget) {
    cardAnimationTarget.removeEventListener('animationend', scheduleUpdateCardHeight)
    cardAnimationTarget = null
  }
  if (cardResizeObserver) {
    cardResizeObserver.disconnect()
    cardResizeObserver = null
  }
  if (cardHeightRaf) {
    window.cancelAnimationFrame(cardHeightRaf)
    cardHeightRaf = 0
  }
})
</script>

<style scoped>
/* 统计卡片尺寸走全局 .stat-card / .stat-icon */

/* 盖掉 main.css 全局 div{transition:all}，高度锁定容器禁止参与过渡 */
.transition-none {
  transition: none !important;
}

/* 表格：上下居中、内容居左；操作列横排 */
.table-container td,
.table-container th,
table td,
table th {
  vertical-align: middle !important;
  text-align: left !important;
}
.table-container td.text-right,
.table-container th.text-right,
table td.text-right,
table th.text-right {
  text-align: right !important;
}
.table-container td.operations-column,
.table-container th.operations-column,
table td.operations-column,
.operations-cell {
  text-align: left !important;
}
.table-container td.operations-column > .flex,
.operations-column > .flex,
.operations-cell > .flex {
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: flex-start;
  align-items: center;
  gap: 0.375rem;
}
.table-container td > .flex:not(.flex-col),
table td > .flex:not(.flex-col) {
  align-items: center;
  justify-content: flex-start;
}
.table-container td.text-right > .flex:not(.flex-col),
table td.text-right > .flex:not(.flex-col) {
  justify-content: flex-end;
}
</style>
