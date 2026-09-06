<template>
  <div class="request-details-container flex h-full min-h-0 flex-col overflow-hidden">
    <!-- 去掉内层 .card：外层 MainLayout 已是卡片，避免卡片套卡片 -->
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="mb-2 flex shrink-0 flex-col gap-2 sm:gap-2.5">
        <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <!-- 页面标题「请求明细」与主 Tab 重复，已移除；保留采集状态/保留时长徽章 -->
            <div class="flex flex-wrap items-center gap-2 sm:gap-3">
              <span
                :class="[
                  'inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold',
                  captureEnabled
                    ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                    : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                ]"
              >
                <span
                  :class="[
                    'mr-2 h-2 w-2 rounded-full',
                    captureEnabled ? 'bg-green-500' : 'bg-gray-400'
                  ]"
                />
                {{ captureEnabled ? '采集已开启' : '采集已关闭' }}
              </span>
              <span
                class="inline-flex items-center rounded-full bg-blue-100 px-3 py-1 text-sm font-semibold text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
              >
                <span class="mr-2 h-2 w-2 rounded-full bg-blue-500" />
                {{ formatRetentionHours(retentionHours) }}
              </span>
            </div>
            <p class="mt-1 text-sm text-gray-600 dark:text-gray-400 sm:text-base">
              {{ pageDescription }}
            </p>
          </div>
        </div>

        <div
          v-if="!captureEnabled && !loading && records.length === 0 && !hasActiveFilters"
          class="rounded-2xl border border-dashed border-gray-300 bg-gray-50/80 p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800/50 sm:p-4"
        >
          <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">
                请求明细采集尚未开启
              </h3>
              <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
                到「系统设置 → 转发配置」开启“请求明细采集”后，后台会开始记录新的请求摘要。历史请求不会回填。
              </p>
            </div>
            <div class="flex flex-col gap-2 sm:flex-row">
              <button
                class="group relative inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-all duration-200 hover:border-gray-300 hover:shadow-md dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500"
                @click="goToSettings"
              >
                <span
                  class="absolute -inset-0.5 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-500 opacity-0 blur transition duration-300 group-hover:opacity-20"
                ></span>
                <i class="i-lucide-settings relative text-blue-500" />
                <span class="relative">前往系统设置</span>
              </button>
              <AppTooltip placement="top">
                <template #content>
                  <div class="max-w-xs text-sm leading-relaxed">
                    清理所有已保存的历史请求体预览数据；仅影响历史预览，不影响当前请求体预览开关设置
                  </div>
                </template>
                <button
                  class="group relative inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-all duration-200 hover:border-gray-300 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500"
                  :disabled="requestDetailBodyPreviewPurging"
                  @click="handleRequestDetailBodyPreviewPurge"
                >
                  <span
                    class="absolute -inset-0.5 rounded-lg bg-gradient-to-r from-red-500 to-orange-500 opacity-0 blur transition duration-300 group-hover:opacity-20"
                  ></span>
                  <i
                    :class="[
                      'relative text-red-500',
                      requestDetailBodyPreviewPurging ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-trash-2'
                    ]"
                  />
                  <span class="relative">清理历史预览</span>
                </button>
              </AppTooltip>
            </div>
          </div>
        </div>

        <template v-else>
          <div
            v-if="!captureEnabled"
            class="rounded-xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
          >
            请求明细采集已关闭，当前展示的是仍在保留期内的历史记录；不会继续写入新的请求明细。
          </div>

          <div
            class="rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm dark:border-gray-700 dark:bg-gray-900"
          >
            <div
              class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-400"
            >
              <span class="inline-flex items-center gap-1 whitespace-nowrap">
                <span>总请求:</span>
                <span class="font-semibold text-gray-900 dark:text-gray-100">{{
                  formatNumber(summary.totalRequests)
                }}</span>
              </span>
              <span class="inline-flex items-center gap-1 whitespace-nowrap">
                <span>输入:</span>
                <span class="font-semibold text-blue-600 dark:text-blue-400">{{
                  formatNumber(summary.inputTokens)
                }}</span>
              </span>
              <span class="inline-flex items-center gap-1 whitespace-nowrap">
                <span>输出:</span>
                <span class="font-semibold text-green-600 dark:text-green-400">{{
                  formatNumber(summary.outputTokens)
                }}</span>
              </span>
              <span class="inline-flex items-center gap-1 whitespace-nowrap" :title="`读 / (输入 + 读 + 建)：${formatNumber(summary.cacheHitNumerator)} / ${formatNumber(summary.cacheHitDenominator)}`">
                <span>缓存命中:</span>
                <span class="font-semibold text-cyan-600 dark:text-cyan-400">{{
                  formatPercent(summary.cacheHitRate)
                }}</span>
              </span>
              <span class="inline-flex items-center gap-1 whitespace-nowrap">
                <span>总费用:</span>
                <span class="font-semibold text-amber-600 dark:text-amber-400">{{
                  formatCost(summary.totalCost)
                }}</span>
              </span>
              <span class="inline-flex items-center gap-1 whitespace-nowrap">
                <span>平均耗时:</span>
                <span class="font-semibold text-gray-900 dark:text-gray-100">{{
                  formatDuration(summary.avgDurationMs)
                }}</span>
                <template v-if="summary.avgFirstTokenMs != null">
                  <span class="text-gray-400">·</span>
                  <span>首字</span>
                  <span class="font-semibold text-gray-900 dark:text-gray-100">{{
                    formatDuration(summary.avgFirstTokenMs)
                  }}</span>
                </template>
              </span>
            </div>
          </div>

          <div
            class="rounded-xl border border-gray-200 bg-gray-50/70 p-2.5 dark:border-gray-700 dark:bg-gray-800/40"
          >
            <div class="request-toolbar">
              <div class="request-filters">
                <!-- 一行 flex 换行：按内容定宽，搜索框可伸但封顶 -->
                <div class="request-filter-row">
                  <div class="toolbar-control toolbar-control--date group">
                    <div
                      class="toolbar-control-glow bg-gradient-to-r from-blue-500 to-purple-500"
                    ></div>
                    <AppDateRangePicker
                      v-model="filters.dateRange"
                      class="toolbar-element min-w-0"
                      clearable
                      presets="filter"
                    />
                  </div>

                  <div class="toolbar-control toolbar-control--search group">
                    <div
                      class="toolbar-control-glow bg-gradient-to-r from-cyan-500 to-teal-500"
                    ></div>
                    <div class="toolbar-search-wrap toolbar-element">
                      <i class="input-affix-icon input-affix-icon--left i-lucide-search text-cyan-500" />
                      <input
                        v-model="filters.keyword"
                        class="toolbar-search-input"
                        placeholder="搜索 Request ID / API Key / 账户 / 模型 / 接口"
                        type="text"
                      />
                    </div>
                  </div>

                  <div class="toolbar-control toolbar-control--dd">
                    <CustomDropdown
                      v-model="filters.apiKeyId"
                      accent="indigo"
                      clearable
                      icon="i-lucide-key"
                      :options="apiKeyDropdownOptions"
                      placeholder="所有 API Key"
                      searchable
                      size="sm"
                    />
                  </div>

                  <div class="toolbar-control toolbar-control--dd">
                    <CustomDropdown
                      v-model="filters.accountId"
                      accent="purple"
                      clearable
                      icon="i-lucide-server"
                      :options="accountDropdownOptions"
                      placeholder="所有账户"
                      searchable
                      size="sm"
                    />
                  </div>

                  <div class="toolbar-control toolbar-control--dd">
                    <CustomDropdown
                      v-model="filters.model"
                      accent="green"
                      clearable
                      icon="i-lucide-box"
                      :options="modelDropdownOptions"
                      placeholder="所有模型"
                      searchable
                      size="sm"
                    />
                  </div>

                  <div class="toolbar-control toolbar-control--dd">
                    <CustomDropdown
                      v-model="filters.endpoint"
                      accent="orange"
                      clearable
                      icon="i-lucide-link"
                      :options="endpointDropdownOptions"
                      placeholder="所有接口"
                      searchable
                      size="sm"
                    />
                  </div>

                  <div class="toolbar-control toolbar-control--sort">
                    <CustomDropdown
                      v-model="filters.sortOrder"
                      accent="gray"
                      icon="i-lucide-arrow-down-wide-narrow"
                      :options="sortOrderOptions"
                      placeholder="时间排序"
                      size="sm"
                    />
                  </div>
                </div>
              </div>

              <div class="request-toolbar-actions">
                <button
                  class="toolbar-action-button group relative inline-flex items-center justify-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-sm font-medium text-gray-700 shadow-sm transition hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500"
                  :disabled="loading"
                  @click="refreshRecords"
                >
                  <span
                    class="absolute -inset-0.5 rounded-lg bg-gradient-to-r from-green-500 to-teal-500 opacity-0 blur transition duration-300 group-hover:opacity-20"
                  ></span>
                  <i
                    :class="[
                      'relative text-green-500',
                      loading ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw'
                    ]"
                  />
                  <span class="relative">刷新</span>
                </button>

                <button
                  class="toolbar-action-button group relative inline-flex items-center justify-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-sm font-medium text-gray-700 shadow-sm transition hover:border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500"
                  @click="resetFilters"
                >
                  <span
                    class="absolute -inset-0.5 rounded-lg bg-gradient-to-r from-gray-400 to-gray-500 opacity-0 blur transition duration-300 group-hover:opacity-20"
                  ></span>
                  <i class="i-lucide-undo-2 relative text-gray-500" />
                  <span class="relative">重置筛选</span>
                </button>

                <button
                  class="toolbar-action-button group relative inline-flex items-center justify-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-sm font-medium text-gray-700 shadow-sm transition hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500"
                  :disabled="exporting"
                  @click="exportCsv"
                >
                  <span
                    class="absolute -inset-0.5 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-500 opacity-0 blur transition duration-300 group-hover:opacity-20"
                  ></span>
                  <i
                    :class="[
                      'relative text-blue-500',
                      exporting ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-file-output'
                    ]"
                  />
                  <span class="relative">导出 CSV</span>
                </button>

                <AppTooltip placement="top">
                  <template #content>
                    <div class="max-w-xs text-sm leading-relaxed">
                      清理所有已保存的历史请求体预览数据；仅影响历史预览，不影响当前请求体预览开关设置
                    </div>
                  </template>
                  <button
                    class="toolbar-action-button group relative inline-flex items-center justify-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-sm font-medium text-gray-700 shadow-sm transition hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500"
                    :disabled="requestDetailBodyPreviewPurging"
                    @click="handleRequestDetailBodyPreviewPurge"
                  >
                    <span
                      class="absolute -inset-0.5 rounded-lg bg-gradient-to-r from-red-500 to-orange-500 opacity-0 blur transition duration-300 group-hover:opacity-20"
                    ></span>
                    <i
                      :class="[
                        'relative text-red-500',
                        requestDetailBodyPreviewPurging ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-trash-2'
                      ]"
                    />
                    <span class="relative">清理历史预览</span>
                  </button>
                </AppTooltip>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div class="table-wrapper flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          v-if="loading"
          class="flex flex-1 items-center justify-center p-12 text-gray-500 dark:text-gray-400"
        >
          <i class="i-lucide-loader-circle animate-spin mr-2" />加载中...
        </div>

        <div
          v-else-if="records.length === 0"
          class="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center text-gray-500 dark:text-gray-400"
        >
          <i class="i-lucide-inbox text-2xl text-cyan-500" />
          <p class="text-base font-semibold text-gray-700 dark:text-gray-200">暂无请求明细</p>
          <p class="max-w-xl text-sm">
            {{ emptyHint }}
          </p>
        </div>

        <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <!-- 桌面：表体内滚动，表头 sticky -->
          <div class="table-container hidden min-h-0 flex-1 md:block">
            <table class="request-table w-full table-fixed divide-y divide-gray-200 dark:divide-gray-700">
              <colgroup>
                <col class="w-[14%]" />
                <col class="w-[18%]" />
                <col class="w-[24%]" />
                <col class="w-[26%]" />
                <col class="w-[12%]" />
                <col class="w-[6%]" />
              </colgroup>
              <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-gray-800">
                <tr class="text-left text-sm font-medium text-gray-500 dark:text-gray-400">
                  <th class="px-2 py-2">时间</th>
                  <th class="px-2 py-2">Key / 账户</th>
                  <th class="px-2 py-2">模型 / 接口</th>
                  <th class="px-2 py-2">Token</th>
                  <th class="px-2 py-2">费用 / 耗时</th>
                  <th class="px-2 py-2 text-right"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-900">
                <tr
                  v-for="record in records"
                  :key="record.requestId"
                  class="hover:bg-gray-50 dark:hover:bg-gray-800/70"
                >
                  <td class="table-cell align-top">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span
                        class="inline-flex rounded px-1.5 py-0.5 text-sm font-semibold text-white"
                        :class="statusBadgeClass(record.statusCode)"
                        :title="statusTitle(record)"
                      >
                        {{ formatStatusCode(record.statusCode) }}
                      </span>
                      <div
                        class="cursor-pointer font-medium text-gray-900 hover:text-blue-600 dark:text-gray-100 dark:hover:text-blue-400"
                        title="点击复制时间"
                        @click="copyText(formatDate(record.timestamp), '时间')"
                      >
                        {{ formatDate(record.timestamp) }}
                      </div>
                    </div>
                    <div
                      class="cursor-pointer truncate text-sm text-gray-400 hover:text-blue-500"
                      :title="`点击复制 Request ID：${record.requestId || ''}`"
                      @click="copyText(record.requestId, 'Request ID')"
                    >
                      {{ shortId(record.requestId) }}
                    </div>
                    <div
                      v-if="record.upstreamRequestId"
                      class="cursor-pointer truncate text-sm text-gray-400 hover:text-blue-500"
                      :title="`点击复制上游ID：${record.upstreamRequestId}`"
                      @click="copyText(record.upstreamRequestId, '上游ID')"
                    >
                      上游 {{ shortId(record.upstreamRequestId) }}
                    </div>
                    <div
                      v-if="record.errorMessage"
                      class="mt-0.5 truncate text-sm text-red-600 dark:text-red-400"
                      :title="record.errorMessage"
                    >
                      {{ record.errorMessage }}
                    </div>
                  </td>
                  <td class="table-cell align-top">
                    <div
                      class="cursor-pointer truncate font-medium text-gray-900 hover:text-blue-600 dark:text-gray-100 dark:hover:text-blue-400"
                      :title="`点击复制 API Key：${record.apiKeyName || record.apiKeyId || ''}`"
                      @click="copyText(record.apiKeyName || record.apiKeyId, 'API Key')"
                    >
                      {{ record.apiKeyName || record.apiKeyId || '-' }}
                    </div>
                    <div
                      class="cursor-pointer truncate text-sm text-gray-500 hover:text-blue-500 dark:text-gray-400"
                      :title="`点击复制账户：${record.accountName || record.accountId || ''}`"
                      @click="copyText(record.accountName || record.accountId, '账户')"
                    >
                      {{ record.accountName || record.accountId || '-' }}
                      <template v-if="record.accountTypeName || record.accountType">
                        · {{ record.accountTypeName || record.accountType }}
                      </template>
                    </div>
                  </td>
                  <td class="table-cell align-top">
                    <div
                      class="cursor-pointer truncate font-medium text-gray-900 hover:text-blue-600 dark:text-gray-100 dark:hover:text-blue-400"
                      :title="`点击复制模型：${record.model || ''}`"
                      @click="copyText(record.model, '模型')"
                    >
                      {{ record.model || '-' }}
                      <span
                        v-if="formatReasoning(record.reasoningDisplay) !== '-'"
                        class="ml-1 font-normal text-violet-600 dark:text-violet-400"
                        :title="`点击复制推理：${formatReasoning(record.reasoningDisplay)}`"
                        @click.stop="copyText(formatReasoning(record.reasoningDisplay), '推理')"
                      >{{ formatReasoning(record.reasoningDisplay) }}</span>
                    </div>
                    <div
                      class="cursor-pointer truncate text-sm text-gray-500 hover:text-blue-500 dark:text-gray-400"
                      :title="`点击复制接口：${record.endpoint || ''}`"
                      @click="copyText(record.endpoint, '接口')"
                    >
                      <span class="text-gray-400">{{ record.method || 'POST' }}</span>
                      {{ shortEndpoint(record.endpoint) }}
                      <template v-if="record.isLongContextRequest">
                        · <span class="text-amber-600 dark:text-amber-400">长上下文</span>
                      </template>
                    </div>
                  </td>
                  <td class="table-cell align-top">
                    <div class="flex flex-wrap gap-x-2 gap-y-0.5 text-sm leading-5">
                      <span>
                        <span class="text-gray-400">入</span>
                        <span class="font-medium text-blue-600 dark:text-blue-400">{{
                          formatNumber(record.inputTokens)
                        }}</span>
                      </span>
                      <span>
                        <span class="text-gray-400">出</span>
                        <span class="font-medium text-green-600 dark:text-green-400">{{
                          formatNumber(record.outputTokens)
                        }}</span>
                      </span>
                      <span>
                        <span class="text-gray-400">读</span>
                        <span class="font-medium text-cyan-600 dark:text-cyan-400">{{
                          formatNumber(record.cacheReadTokens)
                        }}</span>
                      </span>
                      <span>
                        <span class="text-gray-400">建</span>
                        <span class="font-medium text-purple-600 dark:text-purple-400">{{
                          formatCacheCreate(
                            record.cacheCreateTokens,
                            record.cacheCreateNotApplicable
                          )
                        }}</span>
                      </span>
                      <span class="text-gray-500 dark:text-gray-400">
                        命中 {{ formatPercent(record.cacheHitRate) }}
                      </span>
                    </div>
                  </td>
                  <td class="table-cell align-top">
                    <div class="font-semibold text-amber-600 dark:text-amber-400">
                      {{ formatCost(record.cost) }}
                      <span
                        v-if="formatServiceTier(record.serviceTier)"
                        class="ml-1 inline-flex rounded-full px-1.5 py-0.5 text-sm font-medium"
                        :class="serviceTierClass(record.serviceTier)"
                        :title="record.serviceTier"
                      >
                        {{ formatServiceTier(record.serviceTier) }}
                      </span>
                    </div>
                    <div class="text-sm text-gray-500 dark:text-gray-400">
                      {{ formatDuration(record.durationMs) }}
                      <template v-if="record.firstTokenMs != null">
                        · 首字 {{ formatDuration(record.firstTokenMs) }}
                      </template>
                    </div>
                  </td>
                  <td class="table-cell align-top text-right">
                    <button
                      class="rounded border border-gray-200 px-1.5 py-0.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                      type="button"
                      @click="openDetail(record.requestId)"
                    >
                      详情
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 小屏卡片：区域内滚动 -->
          <div class="min-h-0 flex-1 space-y-2 overflow-y-auto md:hidden">
            <div
              v-for="record in records"
              :key="record.requestId"
              class="w-full rounded-lg border border-gray-200 bg-white p-2.5 text-left dark:border-gray-700 dark:bg-gray-900"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <p
                    class="cursor-pointer truncate text-sm font-semibold text-gray-900 hover:text-blue-600 dark:text-gray-100"
                    @click="copyText(record.model, '模型')"
                  >
                    {{ record.model || '-' }}
                    <span
                      v-if="formatReasoning(record.reasoningDisplay) !== '-'"
                      class="font-normal text-violet-600 dark:text-violet-400"
                    >· {{ formatReasoning(record.reasoningDisplay) }}</span>
                  </p>
                  <p
                    class="cursor-pointer text-sm text-gray-500 dark:text-gray-400"
                    @click="copyText(record.requestId, 'Request ID')"
                  >
                    {{ formatDate(record.timestamp) }} · {{ shortId(record.requestId) }}
                  </p>
                </div>
                <div class="flex shrink-0 flex-col items-end gap-1">
                  <span
                    class="inline-flex rounded px-1.5 py-0.5 text-sm font-semibold text-white"
                    :class="statusBadgeClass(record.statusCode)"
                    :title="statusTitle(record)"
                  >
                    {{ formatStatusCode(record.statusCode) }}
                  </span>
                  <p class="text-sm font-semibold text-amber-600 dark:text-amber-400">
                    {{ formatCost(record.cost) }}
                    <span
                      v-if="formatServiceTier(record.serviceTier)"
                      class="ml-1 inline-flex rounded-full px-1.5 py-0.5 text-sm font-medium"
                      :class="serviceTierClass(record.serviceTier)"
                    >
                      {{ formatServiceTier(record.serviceTier) }}
                    </span>
                  </p>
                  <p class="text-sm text-gray-500">
                    {{ formatDuration(record.durationMs) }}
                    <template v-if="record.firstTokenMs != null">
                      · 首字 {{ formatDuration(record.firstTokenMs) }}
                    </template>
                  </p>
                  <p
                    v-if="record.errorMessage"
                    class="max-w-[12rem] truncate text-sm text-red-600 dark:text-red-400"
                    :title="record.errorMessage"
                  >
                    {{ record.errorMessage }}
                  </p>
                  <button
                    class="rounded border border-gray-200 px-1.5 py-0.5 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-300"
                    type="button"
                    @click="openDetail(record.requestId)"
                  >
                    详情
                  </button>
                </div>
              </div>
              <p
                class="mt-1 cursor-pointer truncate text-sm text-gray-600 hover:text-blue-600 dark:text-gray-300"
                @click="copyText(record.apiKeyName || record.apiKeyId, 'API Key')"
              >
                {{ record.apiKeyName || record.apiKeyId || '-' }}
                · {{ record.accountName || record.accountId || '-' }}
              </p>
              <p class="mt-1 text-sm text-gray-600 dark:text-gray-300">
                入 {{ formatNumber(record.inputTokens) }}
                · 出 {{ formatNumber(record.outputTokens) }}
                · 读 {{ formatNumber(record.cacheReadTokens) }}
                · 建
                {{
                  formatCacheCreate(record.cacheCreateTokens, record.cacheCreateNotApplicable)
                }}
                · 命中 {{ formatPercent(record.cacheHitRate) }}
              </p>
            </div>
          </div>

          <div class="shrink-0 border-t border-gray-200 px-2 pb-2 pt-2 dark:border-gray-700">
            <AppPagination
              v-model:current-page="pagination.currentPage"
              v-model:page-size="pagination.pageSize"
              :page-sizes="[20, 50, 100, 200]"
              :total="pagination.totalRecords"
              @current-change="handlePageChange"
              @size-change="handleSizeChange"
            />
          </div>
        </div>
      </div>

      <RequestDetailModal
        :request-id="activeRequestId"
        :show="detailVisible"
        @close="closeDetail"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { useRouter } from 'vue-router'
import {
  getRequestDetailsApi,
  getRequestDetailBodyPreviewStatsApi,
  purgeRequestDetailBodyPreviewApi
} from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast, formatDate, formatNumber, debounce } from '@/libs/tools'
import RequestDetailModal from '@/components/admin/request_detail_modal.vue'
import AppTooltip from '@/components/common/app_tooltip.vue'
import AppDateRangePicker from '@/components/common/app_date_range_picker.vue'
import AppPagination from '@/components/common/app_pagination.vue'

const router = useRouter()

let fetchVersion = 0
const loading = ref(false)
const exporting = ref(false)
const requestDetailBodyPreviewPurging = ref(false)
const detailVisible = ref(false)
const activeRequestId = ref('')
const activeSnapshotId = ref(null)
const captureEnabled = ref(false)
const retentionHours = ref(6)
const bodyPreviewEnabled = ref(false)
const records = ref([])
const availableApiKeys = ref([])
const availableAccounts = ref([])
const availableModels = ref([])
const availableEndpoints = ref([])

const apiKeyDropdownOptions = computed(() =>
  availableApiKeys.value.map((item) => ({ value: item.id, label: item.name }))
)
const accountDropdownOptions = computed(() =>
  availableAccounts.value.map((item) => ({
    value: item.id,
    label: `${item.name}（${item.accountTypeName}）`
  }))
)
const modelDropdownOptions = computed(() =>
  availableModels.value.map((item) => ({ value: item, label: item }))
)
const endpointDropdownOptions = computed(() =>
  availableEndpoints.value.map((item) => ({ value: item, label: item }))
)
const sortOrderOptions = [
  { value: 'desc', label: '时间降序' },
  { value: 'asc', label: '时间升序' }
]

const pagination = reactive({
  currentPage: 1,
  pageSize: 50,
  totalRecords: 0
})

const filters = reactive({
  dateRange: null,
  keyword: '',
  apiKeyId: '',
  accountId: '',
  model: '',
  endpoint: '',
  sortOrder: 'desc'
})

const hasActiveFilters = computed(() => {
  return !!(
    filters.keyword ||
    filters.apiKeyId ||
    filters.accountId ||
    filters.model ||
    filters.endpoint ||
    (filters.dateRange && filters.dateRange.length === 2)
  )
})

const summary = reactive({
  totalRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  totalCost: 0,
  avgDurationMs: 0,
  avgFirstTokenMs: null,
  cacheHitRate: 0,
  cacheHitNumerator: 0,
  cacheHitDenominator: 0,
  cacheHitFormula: 'cacheReadTokens / (inputTokens + cacheReadTokens + cacheCreateTokens)',
  cacheCreateNotApplicable: false
})

const pageDescription = computed(() =>
  bodyPreviewEnabled.value
    ? '搜索每次请求的 API Key、使用账户、模型、接口、Token、费用、耗时与脱敏后的请求快照'
    : '搜索每次请求的 API Key、使用账户、模型、接口、Token、费用、耗时与请求摘要'
)

const emptyHint = computed(() => {
  if (
    filters.keyword ||
    filters.apiKeyId ||
    filters.accountId ||
    filters.model ||
    filters.endpoint
  ) {
    return '当前筛选条件下没有结果，请尝试放宽搜索条件。'
  }
  return '这里只展示开启请求明细采集之后的新请求记录。'
})

const toPickerDate = (value) => {
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.toDate() : null
}

const getDateRangeTimestamp = (value) => {
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.valueOf() : null
}

const areDateRangesEqual = (currentRange = [], nextRange = []) => {
  if (!Array.isArray(currentRange) || !Array.isArray(nextRange)) {
    return false
  }

  if (currentRange.length !== nextRange.length) {
    return false
  }

  return currentRange.every(
    (value, index) => getDateRangeTimestamp(value) === getDateRangeTimestamp(nextRange[index])
  )
}

const buildParams = (page, snapshotId = activeSnapshotId.value) => {
  const params = {
    page,
    pageSize: pagination.pageSize,
    sortOrder: filters.sortOrder
  }

  if (filters.keyword) params.keyword = filters.keyword
  if (filters.apiKeyId) params.apiKeyId = filters.apiKeyId
  if (filters.accountId) params.accountId = filters.accountId
  if (filters.model) params.model = filters.model
  if (filters.endpoint) params.endpoint = filters.endpoint
  if (filters.dateRange && filters.dateRange.length === 2) {
    const [startDate, endDate] = filters.dateRange
    const parsedStart = dayjs(startDate)
    const parsedEnd = dayjs(endDate)

    if (parsedStart.isValid() && parsedEnd.isValid()) {
      params.startDate = parsedStart.toISOString()
      params.endDate = parsedEnd.toISOString()
    }
  }

  if (snapshotId) params.snapshotId = snapshotId

  return params
}

const syncResponseState = (data) => {
  captureEnabled.value = data.captureEnabled === true
  retentionHours.value = data.retentionHours || 6
  bodyPreviewEnabled.value = data.bodyPreviewEnabled === true
  activeSnapshotId.value = data.snapshotId || null
  records.value = data.records || []

  const pageInfo = data.pagination || {}
  pagination.currentPage = pageInfo.currentPage || 1
  pagination.pageSize = pageInfo.pageSize || pagination.pageSize
  pagination.totalRecords = pageInfo.totalRecords || 0

  const filterEcho = data.filters || {}
  // keyword 不回写：用户可能正在输入，回写会覆盖用户当前的输入
  filters.apiKeyId = filterEcho.apiKeyId || ''
  filters.accountId = filterEcho.accountId || ''
  filters.model = filterEcho.model || ''
  filters.endpoint = filterEcho.endpoint || ''
  filters.sortOrder = filterEcho.sortOrder || 'desc'
  if (filterEcho.startDate && filterEcho.endDate) {
    const nextRange = [toPickerDate(filterEcho.startDate), toPickerDate(filterEcho.endDate)]
    if (
      filterEcho.hasCustomDateRange &&
      nextRange.every(Boolean) &&
      !areDateRangesEqual(filters.dateRange || [], nextRange)
    ) {
      suppressDateRangeWatch = true
      filters.dateRange = nextRange
    }
  }

  availableApiKeys.value = data.availableFilters?.apiKeys || []
  availableAccounts.value = data.availableFilters?.accounts || []
  availableModels.value = data.availableFilters?.models || []
  availableEndpoints.value = data.availableFilters?.endpoints || []

  const summaryData = data.summary || {}
  summary.totalRequests = summaryData.totalRequests || 0
  summary.inputTokens = summaryData.inputTokens || 0
  summary.outputTokens = summaryData.outputTokens || 0
  summary.cacheReadTokens = summaryData.cacheReadTokens || 0
  summary.cacheCreateTokens = summaryData.cacheCreateTokens || 0
  summary.totalCost = summaryData.totalCost || 0
  summary.avgDurationMs = summaryData.avgDurationMs || 0
  summary.avgFirstTokenMs =
    summaryData.avgFirstTokenMs === null || summaryData.avgFirstTokenMs === undefined
      ? null
      : summaryData.avgFirstTokenMs
  summary.cacheHitRate = summaryData.cacheHitRate || 0
  summary.cacheHitNumerator = summaryData.cacheHitNumerator || 0
  summary.cacheHitDenominator = summaryData.cacheHitDenominator || 0
  summary.cacheHitFormula =
    summaryData.cacheHitFormula ||
    'cacheReadTokens / (inputTokens + cacheReadTokens + cacheCreateTokens)'
  summary.cacheCreateNotApplicable = summaryData.cacheCreateNotApplicable === true
}

let suppressDateRangeWatch = false

const invalidateSnapshot = () => {
  activeSnapshotId.value = null
}

const fetchRecords = async (page = pagination.currentPage) => {
  debouncedKeywordFetch.cancel()
  const version = ++fetchVersion
  loading.value = true
  try {
    const response = await getRequestDetailsApi(buildParams(page))
    if (version !== fetchVersion) return
    if (!isOk(response)) {
      showToast(msgOf(response, '加载请求明细失败'), 'error')
      return
    }
    syncResponseState(response.data || {})
  } catch (error) {
    if (version !== fetchVersion) return
    showToast(`加载请求明细失败：${error.message || '未知错误'}`, 'error')
  } finally {
    if (version === fetchVersion) {
      loading.value = false
    }
  }
}

const handlePageChange = (page) => {
  pagination.currentPage = page
  fetchRecords(page)
}

const handleSizeChange = (size) => {
  pagination.pageSize = size
  pagination.currentPage = 1
  fetchRecords(1)
}

const refreshRecords = () => {
  invalidateSnapshot()
  fetchRecords(pagination.currentPage)
}

const resetFilters = () => {
  invalidateSnapshot()
  filters.dateRange = null
  filters.keyword = ''
  filters.apiKeyId = ''
  filters.accountId = ''
  filters.model = ''
  filters.endpoint = ''
  filters.sortOrder = 'desc'
  pagination.currentPage = 1
  fetchRecords(1)
  // resetFilters 同步写 filters.keyword = '' 会触发 keyword watcher 排一个新 debounce，
  // 需要在 watcher 执行后（nextTick）取消它，避免多余请求和 loading 闪烁
  nextTick(() => debouncedKeywordFetch.cancel())
}

const handleRequestDetailBodyPreviewPurge = async () => {
  if (requestDetailBodyPreviewPurging.value) return

  try {
    const statsResponse = await getRequestDetailBodyPreviewStatsApi()

    if (!isOk(statsResponse)) {
      showToast(msgOf(statsResponse, '检查历史请求体预览失败'), 'error')
      return
    }

    const snapshotCount = Number(statsResponse?.data?.snapshotCount || 0)
    if (snapshotCount <= 0) {
      showToast('暂无历史请求体预览需要清理', 'success')
      return
    }

    const confirmed = window.confirm(
      `检测到当前仍有 ${snapshotCount} 条请求明细保存了请求体预览。\n清理后将仅移除历史请求体预览，保留请求明细摘要字段。\n\n是否继续？`
    )
    if (!confirmed) return

    requestDetailBodyPreviewPurging.value = true
    const purgeResponse = await purgeRequestDetailBodyPreviewApi()

    if (!isOk(purgeResponse)) {
      showToast(msgOf(purgeResponse, '清理历史请求体预览失败'), 'error')
      return
    }

    showToast(msgOf(purgeResponse, '清理完毕'), 'success')
  } catch (error) {
    showToast('清理历史请求体预览失败', 'error')
    console.error(error)
  } finally {
    requestDetailBodyPreviewPurging.value = false
  }
}

const goToSettings = () => router.push('/settings/claude')
const openDetail = (requestId) => {
  activeRequestId.value = requestId
  detailVisible.value = true
}
const closeDetail = () => {
  detailVisible.value = false
  activeRequestId.value = ''
}

const exportCsv = async () => {
  if (exporting.value) return
  exporting.value = true
  try {
    const aggregated = []
    let page = 1
    let totalPages = 1
    let totalRecords = 0
    let snapshotId = activeSnapshotId.value
    const maxPages = 100

    while (page <= totalPages && page <= maxPages) {
      const response = await getRequestDetailsApi({
        ...buildParams(page, snapshotId),
        pageSize: 200
      })
      const payload = response.data || {}
      snapshotId = payload.snapshotId || null
      aggregated.push(...(payload.records || []))
      totalPages = payload.pagination?.totalPages || 1
      if (page === 1) {
        totalRecords = payload.pagination?.totalRecords || 0
      }
      page += 1
    }

    if (totalPages > maxPages) {
      showToast(
        `数据量超过导出上限（已导出 ${aggregated.length} 条，共 ${totalRecords} 条），建议缩小筛选范围后重试`,
        'warning'
      )
    }

    if (aggregated.length === 0) {
      showToast('没有可导出的记录', 'info')
      return
    }

    const headers = [
      '统计时间',
      'Request ID',
      '上游ID',
      '状态码',
      '结果',
      '错误码',
      '错误信息',
      'API Key',
      '使用账户',
      '消费类型',
      '模型',
      '档位',
      '推理',
      '接口',
      '输入',
      '输出',
      '缓存读取',
      '缓存创建',
      '缓存命中率',
      '费用',
      '耗时(ms)',
      '首字(ms)'
    ]

    const rows = [headers.join(',')]
    // CSV 公式注入防护：以 = + - @ 开头的单元格前加 '
    const escapeCsvCell = (value) => {
      let text = String(value ?? '')
      if (/^[=+\-@]/.test(text)) {
        text = `'${text}`
      }
      return `"${text.replace(/"/g, '""')}"`
    }
    aggregated.forEach((record) => {
      const statusCode = formatStatusCode(record.statusCode)
      const resultLabel = Number(statusCode) >= 400 ? '失败' : '成功'
      const row = [
        formatDate(record.timestamp),
        record.requestId || '',
        record.upstreamRequestId || '',
        statusCode,
        resultLabel,
        record.errorCode || '',
        record.errorMessage || '',
        record.apiKeyName || record.apiKeyId || '',
        record.accountName || record.accountId || '',
        record.accountTypeName || record.accountType || '',
        record.model || '',
        formatServiceTier(record.serviceTier) || record.serviceTier || '',
        formatReasoning(record.reasoningDisplay),
        record.endpoint || '',
        record.inputTokens || 0,
        record.outputTokens || 0,
        record.cacheReadTokens || 0,
        formatCacheCreate(record.cacheCreateTokens, record.cacheCreateNotApplicable),
        formatPercent(record.cacheHitRate),
        formatCost(record.cost),
        record.durationMs || 0,
        record.firstTokenMs != null ? record.firstTokenMs : ''
      ]
      rows.push(row.map((cell) => escapeCsvCell(cell)).join(','))
    })

    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'request-details.csv'
    link.click()
    URL.revokeObjectURL(url)
    showToast('导出 CSV 成功', 'success')
  } catch (error) {
    showToast(`导出失败：${error.message || '未知错误'}`, 'error')
  } finally {
    exporting.value = false
  }
}

const formatCost = (value) => {
  const num = Number(value || 0)
  if (num >= 1) return `$${num.toFixed(2)}`
  if (num >= 0.001) return `$${num.toFixed(4)}`
  return `$${num.toFixed(6)}`
}
const formatCacheCreate = (value, notApplicable = false) =>
  notApplicable ? '-' : formatNumber(value)
const formatRetentionHours = (value) => {
  const totalHours = Number(value || 0)
  if (totalHours <= 0) return '保留 6 小时'

  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24

  if (days > 0 && hours > 0) {
    return `保留 ${days} 天 ${hours} 小时`
  }

  if (days > 0) {
    return `保留 ${days} 天`
  }

  return `保留 ${hours} 小时`
}
const copyText = async (value, label = '内容') => {
  const text = String(value ?? '').trim()
  if (!text || text === '-') {
    showToast(`没有可复制的${label}`, 'info')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    showToast(`已复制${label}`, 'success')
  } catch (_error) {
    showToast('复制失败，请手动复制', 'error')
  }
}

const shortId = (value) => {
  const text = String(value || '').trim()
  if (!text) return '-'
  if (text.length <= 12) return text
  return `${text.slice(0, 6)}…${text.slice(-4)}`
}

const formatStatusCode = (statusCode) => {
  const code = Number(statusCode)
  if (!Number.isFinite(code) || code <= 0) return '200'
  return String(Math.trunc(code))
}

const statusBadgeClass = (statusCode) => {
  const code = Number(statusCode)
  if (code >= 500) return 'bg-red-600'
  if (code >= 400) return 'bg-amber-500'
  if (code >= 200 && code < 300) return 'bg-green-600'
  return 'bg-gray-500'
}

const statusTitle = (record) => {
  const code = formatStatusCode(record?.statusCode)
  if (record?.errorMessage) {
    return `${code} ${record.errorMessage}`
  }
  if (Number(code) >= 400) {
    return `${code} 失败`
  }
  return `${code} 成功`
}

const shortEndpoint = (value) => {
  const text = String(value || '').trim()
  if (!text) return '-'
  // 过长路径只留末两段，完整路径 hover title
  const parts = text.split('/').filter(Boolean)
  if (parts.length <= 3 && text.length <= 36) return text
  if (parts.length >= 2) return `…/${parts.slice(-2).join('/')}`
  return text.length > 36 ? `…${text.slice(-32)}` : text
}

const formatDuration = (value) => `${Number(value || 0)}ms`
const formatPercent = (value) => `${Number(value || 0).toFixed(2)}%`
const formatReasoning = (value) => value || '-'
// OpenAI service_tier：fast/priority 同溢价档
const formatServiceTier = (tier) => {
  if (typeof tier !== 'string' || !tier.trim()) return ''
  const normalized = tier.trim().toLowerCase()
  if (normalized === 'fast' || normalized === 'priority') return 'Fast'
  if (normalized === 'ultrafast') return 'Ultrafast'
  if (normalized === 'flex') return 'Flex'
  if (normalized === 'default' || normalized === 'auto') return 'Default'
  return tier
}
const serviceTierClass = (tier) => {
  const normalized = typeof tier === 'string' ? tier.trim().toLowerCase() : ''
  if (normalized === 'fast' || normalized === 'priority' || normalized === 'ultrafast') {
    return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
  }
  if (normalized === 'flex') {
    return 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300'
  }
  return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
}

const debouncedKeywordFetch = debounce(() => {
  pagination.currentPage = 1
  invalidateSnapshot()
  fetchRecords(1)
}, 300)

watch(
  () => filters.keyword,
  () => {
    debouncedKeywordFetch()
  }
)

watch(
  () => [filters.apiKeyId, filters.accountId, filters.model, filters.endpoint, filters.sortOrder],
  () => {
    debouncedKeywordFetch.cancel()
    pagination.currentPage = 1
    invalidateSnapshot()
    fetchRecords(1)
  }
)

watch(
  () => filters.dateRange,
  () => {
    if (suppressDateRangeWatch) {
      suppressDateRangeWatch = false
      return
    }
    pagination.currentPage = 1
    invalidateSnapshot()
    fetchRecords(1)
  },
  { deep: true }
)

onMounted(() => {
  fetchRecords()
})
</script>

<style scoped>

.request-toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.request-filters {
  min-width: 0;
  flex: 1 1 auto;
}

.request-filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.toolbar-control {
  position: relative;
  min-width: 0;
  flex: 0 0 auto;
}

/* 日期：内容宽，上限约 20rem */
.toolbar-control--date {
  width: auto;
  max-width: min(20rem, 100%);
}

/* 搜索：宽度交给全局 .toolbar-search-wrap（18rem） */
.toolbar-control--search {
  flex: 0 0 auto;
  width: auto;
  max-width: 100%;
}

/* 筛选下拉：固定可读宽度 */
.toolbar-control--dd {
  width: 10.5rem;
}

.toolbar-control--sort {
  width: 8.5rem;
}

.toolbar-control--dd :deep(.cute-dropdown),
.toolbar-control--sort :deep(.cute-dropdown) {
  width: 100%;
}

.toolbar-control--date :deep(.adr) {
  width: auto;
  max-width: 100%;
}


.toolbar-control-glow {
  position: absolute;
  inset: -2px;
  border-radius: 12px;
  opacity: 0;
  filter: blur(10px);
  transition: opacity 0.3s ease;
}

.toolbar-control:hover .toolbar-control-glow {
  opacity: 0.16;
}





.request-toolbar-actions {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  align-content: flex-start;
  gap: 6px;
}

.toolbar-action-button {
  min-width: 0;
  height: 2rem; /* 32px，与紧凑筛选控件同高，禁止被 stretch 拉高 */
  min-height: 2rem;
  max-height: 2rem;
  padding: 0 0.625rem !important;
  white-space: nowrap;
  flex: 0 0 auto;
  align-self: center;
}

.table-cell {
  padding: 8px 8px;
  font-size: 14px;
  color: rgb(31 41 55);
  vertical-align: top;
  text-align: left;
}

.dark .table-cell {
  color: rgb(226 232 240);
}

.table-wrapper {
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  width: 100%;
  position: relative;
  /* 占满标题/筛选下方剩余高度，由表体内滚动 */
  min-height: 0;
}

.dark .table-wrapper {
  border-color: rgba(255, 255, 255, 0.1);
}

.table-container {
  overflow-x: hidden;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  max-width: 100%;
  width: 100%;
  min-height: 0;
  /* 兜底：父级 flex 未生效时仍限制高度 */
  max-height: min(70vh, calc(100vh - 22rem));
}

.table-container table,
.request-table {
  width: 100%;
  min-width: 0;
  /* separate 才能稳定 sticky thead；collapse 下部分浏览器表头滚动会跟着跑 */
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
}

.table-container thead th {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgb(249 250 251);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.06);
}

:global(.dark) .table-container thead th,
.dark .table-container thead th {
  background: rgb(31 41 55);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.06);
}

.request-table tbody tr:nth-child(even) {
  background: rgba(249, 250, 251, 0.65);
}

.dark .request-table tbody tr:nth-child(even) {
  background: rgba(31, 41, 55, 0.55);
}

@media (min-width: 768px) {
  .request-toolbar-actions {
    flex-direction: row;
    flex-wrap: wrap;
  }
}

@media (min-width: 1280px) {
  .request-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 16px;
  }

  .request-toolbar-actions {
    align-self: start;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
}
</style>
