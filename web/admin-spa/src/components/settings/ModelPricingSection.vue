<template>
  <div>
    <!-- 顶栏：tab 左 + 状态右 -->
    <div class="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div
        v-if="!readonly"
        class="flex min-w-0 shrink-0 gap-1 overflow-x-auto rounded-lg bg-gray-100 p-1 dark:bg-gray-700"
      >
        <button
          v-for="tab in sectionTabs"
          :key="tab.key"
          :class="[
            'whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            activeTab === tab.key
              ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-800'
              : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100'
          ]"
          @click="switchTab(tab.key)"
        >
          <i :class="['fas', tab.icon, 'mr-1.5']" />
          {{ tab.label }}
        </button>
      </div>

      <div
        class="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50 px-3 py-2 dark:border-gray-700 dark:from-blue-900/20 dark:to-indigo-900/20"
      >
        <div class="flex items-center gap-2">
          <div
            class="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400"
          >
            <i class="fas fa-coins" />
          </div>
          <div class="leading-tight">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-300">
              显示
              <span class="font-bold text-blue-600 dark:text-blue-400">{{
                sortedModels.length
              }}</span>
              /
              <span class="font-bold text-blue-600 dark:text-blue-400">{{ modelCount }}</span>
            </p>
            <p class="text-sm text-gray-500 dark:text-gray-400">上次更新: {{ lastUpdated }}</p>
          </div>
        </div>
        <button
          v-if="!readonly"
          :class="[
            'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium shadow-sm transition',
            refreshing
              ? 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-gray-700 dark:text-gray-500'
              : 'bg-blue-500 text-white hover:bg-blue-600 hover:shadow-md'
          ]"
          :disabled="refreshing"
          @click="handleRefresh"
        >
          <i :class="['fas', refreshing ? 'fa-spinner fa-spin' : 'fa-sync-alt']" />
          {{ refreshing ? '刷新中...' : '立即刷新' }}
        </button>
      </div>
    </div>

    <!-- 价格表筛选条：独立整行，避免被 tab/状态挤没 -->
    <div
      v-show="readonly || activeTab === 'table'"
      class="mb-3 flex flex-col gap-2 rounded-xl border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-800 sm:flex-row sm:items-center"
    >
      <div class="relative min-w-0 flex-1">
        <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          v-model="searchQuery"
          class="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm text-gray-700 placeholder-gray-400 transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
          placeholder="模糊搜索模型名 / 供应商（空格多关键词）"
          type="text"
        />
      </div>
      <div class="w-full shrink-0 sm:w-44">
        <CustomDropdown
          v-model="activeProvider"
          accent="blue"
          clearable
          icon="fa-server"
          :options="providerDropdownOptions"
          placeholder="全部供应商"
          searchable
          search-placeholder="搜索供应商..."
        />
      </div>
    </div>
    <p v-if="readonly" class="mb-4 text-sm text-gray-500 dark:text-gray-400">
      以下为官方参考单价（$/百万 tokens）。实际扣费可能叠加服务倍率与 API Key 倍率。
    </p>

    <!-- 数据源配置（管理端可改，改完点“拉取最新价格”即时生效，无需重启） -->
    <div
      v-if="!readonly"
      v-show="activeTab === 'source'"
      class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
    >
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <i class="fas fa-cloud-download-alt text-blue-500" />
          <span class="text-sm font-semibold text-gray-700 dark:text-gray-200">模型定价数据源</span>
          <span
            v-if="pricingStatus.source"
            :class="[
              'rounded px-2 py-0.5 text-sm',
              pricingStatus.source.custom
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
            ]"
          >
            {{ pricingStatus.source.custom ? '自定义' : '默认' }}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            :disabled="savingSource || importing"
            @click="handleResetSource"
          >
            恢复默认
          </button>
          <button
            class="rounded-lg bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            :disabled="savingSource || importing"
            @click="handleSaveSource"
          >
            <i :class="['fas mr-1', savingSource ? 'fa-spinner fa-spin' : 'fa-save']" />
            保存
          </button>
          <button
            class="rounded-lg bg-blue-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="savingSource || importing"
            @click="handleImport"
          >
            <i :class="['fas mr-1', importing ? 'fa-spinner fa-spin' : 'fa-download']" />
            {{ importing ? '拉取中...' : '拉取最新价格' }}
          </button>
        </div>
      </div>
      <div class="mb-3 rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900/50">
        <p class="break-all text-sm text-gray-600 dark:text-gray-400">
          当前生效：<span class="font-mono">{{ pricingStatus.source?.pricingUrl || '-' }}</span>
        </p>
        <p class="mt-1 break-all text-sm text-gray-500 dark:text-gray-500">
          校验文件：<span class="font-mono">{{ pricingStatus.source?.hashUrl || '未配置' }}</span>
        </p>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="mb-1 block text-sm text-gray-600 dark:text-gray-400">
            定价 JSON 地址
          </label>
          <input
            v-model="sourceForm.pricingUrl"
            class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 placeholder-gray-400 transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            :placeholder="pricingStatus.source?.defaultPricingUrl || 'https://...'"
            type="text"
          />
        </div>
        <div>
          <label class="mb-1 block text-sm text-gray-600 dark:text-gray-400">
            sha256 校验地址（可留空）
          </label>
          <input
            v-model="sourceForm.hashUrl"
            class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 placeholder-gray-400 transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            :placeholder="pricingStatus.source?.defaultHashUrl || '留空则跳过哈希校验'"
            type="text"
          />
        </div>
      </div>
      <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
        上方“当前生效”只显示来源站点，路径与查询参数已隐去（它们加密存储，因为令牌既可能在
        <span class="font-mono">?token=</span>
        也可能在路径里），故不回填到输入框。填入新地址点保存即替换； 用“恢复默认”回到内置源。配了
        sha256 地址时系统每 10 分钟比对哈希、有变更自动拉取；留空则仅靠每 24
        小时定时更新与手动拉取。地址不得包含用户名/密码；保存时校验字面量，请求前还会校验域名的 DNS
        解析结果，指向回环/私网/链路本地的地址会被拒绝（含重定向目标）。
      </p>
    </div>

    <!-- 模型目录导入：把定价源里有、/v1/models 还没有的模型加进目录 -->
    <div
      v-if="!readonly"
      v-show="activeTab === 'catalog'"
      class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
    >
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <i class="fas fa-layer-group text-emerald-500" />
          <span class="text-sm font-semibold text-gray-700 dark:text-gray-200">内部计费模型</span>
          <span class="text-sm text-gray-500 dark:text-gray-400">
            已导入 {{ importedModels.length }} 个 · 可导入 {{ importableModels.length }} 个
          </span>
        </div>
        <button
          class="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          :disabled="modelsLoading"
          @click="loadModelCatalog"
        >
          <i :class="['fas mr-1', modelsLoading ? 'fa-spinner fa-spin' : 'fa-rotate']" />
          刷新列表
        </button>
      </div>

      <p class="mb-3 text-sm text-gray-500 dark:text-gray-400">
        从外部定价种子导入完整模型数据到内部；有内部模型时，计费与用户价表优先用内部。
        编辑是整模替换，不是字段覆盖。同时会进入
        <span class="font-mono">/v1/models</span>
        目录。
      </p>
      <div class="mb-3 flex flex-wrap gap-2">
        <button
          class="rounded-lg bg-blue-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-600"
          @click="openCreateInternal"
        >
          <i class="fas fa-plus mr-1" />
          新建内部模型
        </button>
      </div>

      <!-- 可导入 -->
      <div class="mb-4">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium text-gray-600 dark:text-gray-300">可导入</span>
          <div class="min-w-0 flex-1">
            <CustomDropdown
              v-model="selectedImportable"
              accent="green"
              clearable
              icon="fa-cube"
              multiple
              :options="importableDropdownOptions"
              placeholder="选择要导入的模型（可搜索）"
              searchable
              search-placeholder="搜索模型..."
            />
          </div>
          <button
            class="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="modelsLoading || selectedImportable.length === 0"
            @click="handleImportModels"
          >
            <i class="fas fa-plus mr-1" />
            导入 {{ selectedImportable.length || '' }}
          </button>
        </div>
        <p v-if="importableModels.length === 0" class="text-sm text-gray-500 dark:text-gray-400">
          定价源里没有目录之外的新模型。
        </p>
      </div>

      <!-- 已导入 -->
      <div>
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium text-gray-600 dark:text-gray-300">已导入</span>
          <div class="min-w-0 flex-1">
            <CustomDropdown
              v-model="selectedImported"
              accent="red"
              clearable
              icon="fa-layer-group"
              multiple
              :options="importedDropdownOptions"
              placeholder="选择要移除的内部模型"
              searchable
              search-placeholder="搜索模型..."
            />
          </div>
          <button
            class="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
            :disabled="modelsLoading || selectedImported.length === 0"
            @click="handleRemoveModels"
          >
            <i class="fas fa-minus mr-1" />
            移除 {{ selectedImported.length || '' }}
          </button>
        </div>
        <div
          v-if="importedModels.length"
          class="mt-3 max-h-80 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700"
        >
          <table class="min-w-full table-fixed text-sm">
            <colgroup>
              <col class="w-[36%]" />
              <col class="w-[12%]" />
              <col class="w-[12%]" />
              <col class="w-[12%]" />
              <col class="w-[12%]" />
              <col class="w-[16%]" />
            </colgroup>
            <thead class="sticky top-0 bg-gray-50 dark:bg-gray-900">
              <tr>
                <th class="px-3 py-2 text-left font-medium text-gray-500">模型</th>
                <th class="px-3 py-2 text-right font-medium text-green-700 dark:text-green-400">
                  输入 $/M
                </th>
                <th class="px-3 py-2 text-right font-medium text-red-600 dark:text-red-400">
                  输出 $/M
                </th>
                <th class="px-3 py-2 text-right font-medium text-amber-700 dark:text-amber-400">
                  缓存写
                </th>
                <th class="px-3 py-2 text-right font-medium text-sky-600 dark:text-sky-400">
                  缓存读
                </th>
                <th class="px-3 py-2 text-right font-medium text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
              <tr v-for="model in sortedImportedModels" :key="model.id">
                <td class="px-3 py-2 align-middle">
                  <div
                    class="cursor-pointer font-medium text-gray-900 hover:underline dark:text-gray-100"
                    title="点击复制"
                    @click="copyCell(model.id)"
                  >
                    {{ model.id }}
                  </div>
                  <div class="text-sm text-gray-500">
                    <span
                      class="cursor-pointer hover:underline"
                      title="点击复制"
                      @click="copyCell(model.provider)"
                      >{{ model.provider || '-' }}</span
                    >
                    <span
                      v-if="model.hasBilling"
                      class="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                      >计费</span
                    >
                    <span
                      v-else
                      class="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                      >仅目录</span
                    >
                  </div>
                </td>
                <td
                  class="px-3 py-2 text-right align-middle font-mono font-medium text-green-600 dark:text-green-400"
                >
                  <span
                    class="cursor-pointer hover:underline"
                    title="点击复制"
                    @click="copyCell(formatPrice(model.pricing?.input_per_million_tokens))"
                    >{{ formatPrice(model.pricing?.input_per_million_tokens) }}</span
                  >
                </td>
                <td
                  class="px-3 py-2 text-right align-middle font-mono font-medium text-red-500 dark:text-red-400"
                >
                  <span
                    class="cursor-pointer hover:underline"
                    title="点击复制"
                    @click="copyCell(formatPrice(model.pricing?.output_per_million_tokens))"
                    >{{ formatPrice(model.pricing?.output_per_million_tokens) }}</span
                  >
                </td>
                <td class="px-3 py-2 text-right align-middle font-mono text-amber-700 dark:text-amber-400">
                  <span
                    class="cursor-pointer hover:underline"
                    title="点击复制"
                    @click="copyCell(formatPrice(model.pricing?.cache_write_per_million_tokens))"
                    >{{ formatPrice(model.pricing?.cache_write_per_million_tokens) }}</span
                  >
                </td>
                <td class="px-3 py-2 text-right align-middle font-mono text-sky-600 dark:text-sky-400">
                  <span
                    class="cursor-pointer hover:underline"
                    title="点击复制"
                    @click="copyCell(formatPrice(model.pricing?.cache_read_per_million_tokens))"
                    >{{ formatPrice(model.pricing?.cache_read_per_million_tokens) }}</span
                  >
                </td>
                <td class="px-3 py-2 text-right align-middle">
                  <div class="inline-flex flex-wrap items-center justify-end gap-1">
                    <button
                      class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-gray-500 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                      title="复制为新的内部模型并编辑"
                      @click="copyToInternalEditor(model.id || model.name)"
                    >
                      <i class="fas fa-copy" />复制
                    </button>
                    <button
                      class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-blue-600 transition hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
                      @click="openEditInternalByName(model.id || model.name)"
                    >
                      <i class="fas fa-edit" />编辑
                    </button>
                    <button
                      class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-gray-500 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                      @click="showRawOne(model.id || model.name)"
                    >
                      <i class="fas fa-eye" />详情
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-sm text-gray-500 dark:text-gray-400">
          还没有内部计费模型。从上方种子导入，或点「新建内部模型」。
        </p>
      </div>
    </div>

    <InternalModelEditor
      v-if="editor.show"
      :show="true"
      :model="editor.model"
      :is-create="editor.isCreate"
      @close="editor.show = false"
      @saved="handleInternalSaved"
    />

    <!-- 价格表 tab -->
    <div v-show="readonly || activeTab === 'table'">
      <!-- 加载状态 -->
      <div v-if="loading" class="py-12 text-center">
        <i class="fas fa-spinner fa-spin mb-4 text-2xl text-blue-500" />
        <p class="text-gray-500 dark:text-gray-400">加载价格数据中...</p>
      </div>

      <!-- 表格 -->
      <div
        v-else
        ref="tableWrapper"
        class="overflow-auto rounded-lg border border-gray-200 dark:border-gray-700"
        :style="{ maxHeight: tableMaxHeight }"
      >
        <table class="min-w-full text-sm">
          <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-gray-800">
            <tr>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-3 text-left font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400"
                @click="toggleSort('name')"
              >
                模型名称
                <i
                  v-if="sortField === 'name'"
                  :class="['fas ml-1', sortAsc ? 'fa-sort-up' : 'fa-sort-down']"
                />
              </th>
              <th class="whitespace-nowrap px-3 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                供应商
              </th>
              <th class="whitespace-nowrap px-3 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                来源
              </th>
              <th class="whitespace-nowrap px-3 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                Mode
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-3 text-right font-medium text-green-700 hover:text-green-800 dark:text-green-400"
                @click="toggleSort('input')"
              >
                输入 $/M
                <i
                  v-if="sortField === 'input'"
                  :class="['fas ml-1', sortAsc ? 'fa-sort-up' : 'fa-sort-down']"
                />
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-3 text-right font-medium text-red-600 hover:text-red-700 dark:text-red-400"
                @click="toggleSort('output')"
              >
                输出 $/M
                <i
                  v-if="sortField === 'output'"
                  :class="['fas ml-1', sortAsc ? 'fa-sort-up' : 'fa-sort-down']"
                />
              </th>
              <th class="whitespace-nowrap px-3 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                缓存写5m
              </th>
              <th class="whitespace-nowrap px-3 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                缓存写1h
              </th>
              <th class="whitespace-nowrap px-3 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                缓存读
              </th>
              <th class="whitespace-nowrap px-3 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                最大输入
              </th>
              <th class="whitespace-nowrap px-3 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                最大输出
              </th>
              <th class="whitespace-nowrap px-3 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                能力
              </th>
              <th
                v-if="!readonly"
                class="whitespace-nowrap px-3 py-3 text-right font-medium text-gray-500 dark:text-gray-400"
              >
                <button
                  class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-blue-600 transition hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
                  @click="showRawAll"
                >
                  <i class="fas fa-list" />全部详情
                </button>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
            <tr
              v-for="model in sortedModels"
              :key="model.name"
              class="transition hover:bg-gray-50 dark:hover:bg-gray-800/50"
            >
              <td class="whitespace-nowrap px-3 py-2.5">
                <div
                  class="cursor-pointer font-semibold text-gray-900 hover:underline dark:text-gray-100"
                  title="点击复制"
                  @click="copyCell(model.name)"
                >
                  {{ model.name }}
                </div>
                <div v-if="model.deprecationDate" class="text-sm text-amber-600 dark:text-amber-400">
                  弃用 {{ model.deprecationDate }}
                </div>
              </td>
              <td class="whitespace-nowrap px-3 py-2.5 text-gray-600 dark:text-gray-300">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(model.provider)"
                  >{{ model.provider || '-' }}</span
                >
              </td>
              <td class="whitespace-nowrap px-3 py-2.5">
                <span
                  v-if="model.billingSource === 'internal'"
                  class="rounded bg-emerald-100 px-1.5 py-0.5 text-sm text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                  >内部</span
                >
                <span
                  v-else
                  class="rounded bg-gray-100 px-1.5 py-0.5 text-sm text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                  >种子</span
                >
              </td>
              <td class="whitespace-nowrap px-3 py-2.5 text-gray-600 dark:text-gray-300">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(model.mode)"
                  >{{ model.mode || '-' }}</span
                >
              </td>
              <!-- 价格语义色对齐 llysc：输入绿 / 输出红；点击复制 -->
              <td class="whitespace-nowrap px-3 py-2.5 text-right font-mono font-medium text-green-600 dark:text-green-400">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatPrice(model.inputCost))"
                  >{{ formatPrice(model.inputCost) }}</span
                >
              </td>
              <td class="whitespace-nowrap px-3 py-2.5 text-right font-mono font-medium text-red-500 dark:text-red-400">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatPrice(model.outputCost))"
                  >{{ formatPrice(model.outputCost) }}</span
                >
              </td>
              <td class="whitespace-nowrap px-3 py-2.5 text-right font-mono text-amber-700 dark:text-amber-400">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatPrice(model.cacheCreateCost))"
                  >{{ formatPrice(model.cacheCreateCost) }}</span
                >
              </td>
              <td class="whitespace-nowrap px-3 py-2.5 text-right font-mono text-amber-700 dark:text-amber-400">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatPrice(model.cacheCreate1hCost))"
                  >{{ formatPrice(model.cacheCreate1hCost) }}</span
                >
              </td>
              <td class="whitespace-nowrap px-3 py-2.5 text-right font-mono text-sky-600 dark:text-sky-400">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatPrice(model.cacheReadCost))"
                  >{{ formatPrice(model.cacheReadCost) }}</span
                >
              </td>
              <td class="whitespace-nowrap px-3 py-2.5 text-right text-gray-600 dark:text-gray-300">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatContext(model.maxInputTokens))"
                  >{{ formatContext(model.maxInputTokens) }}</span
                >
              </td>
              <td class="whitespace-nowrap px-3 py-2.5 text-right text-gray-600 dark:text-gray-300">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatContext(model.maxOutputTokens))"
                  >{{ formatContext(model.maxOutputTokens) }}</span
                >
              </td>
              <td class="px-3 py-2.5">
                <div class="flex max-w-[220px] flex-wrap gap-1">
                  <span
                    v-for="tag in model.capabilityTags"
                    :key="tag"
                    class="rounded bg-blue-50 px-1.5 py-0.5 text-sm text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                    >{{ tag }}</span
                  >
                  <span v-if="!model.capabilityTags.length" class="text-gray-400">-</span>
                </div>
              </td>
              <td v-if="!readonly" class="whitespace-nowrap px-3 py-2.5 text-right">
                <div class="inline-flex flex-wrap items-center justify-end gap-1">
                  <button
                    class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                    title="复制为新内部模型并打开编辑"
                    @click="copyToInternalEditor(model.name)"
                  >
                    <i class="fas fa-copy" />复制
                  </button>
                  <button
                    v-if="model.billingSource !== 'internal'"
                    class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-emerald-600 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-emerald-400 dark:hover:bg-emerald-900/20"
                    :disabled="addingInternalName === model.name"
                    title="打开编辑弹窗，保存后成为内部计费模型"
                    @click="addToInternal(model.name)"
                  >
                    <i
                      :class="[
                        'fas',
                        addingInternalName === model.name ? 'fa-spinner fa-spin' : 'fa-plus'
                      ]"
                    />
                    加入内部
                  </button>
                  <button
                    v-else
                    class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-blue-600 transition hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
                    title="编辑内部计费模型"
                    @click="openEditInternalByName(model.name)"
                  >
                    <i class="fas fa-edit" />编辑
                  </button>
                  <button
                    class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-gray-500 transition hover:bg-gray-100 hover:text-blue-600 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-blue-400"
                    @click="showRawOne(model.name)"
                  >
                    <i class="fas fa-eye" />详情
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="sortedModels.length === 0">
              <td
                class="px-3 py-8 text-center text-gray-500 dark:text-gray-400"
                :colspan="readonly ? 12 : 13"
              >
                <i class="fas fa-search mb-2 text-2xl text-gray-300 dark:text-gray-600" />
                <p>没有匹配的模型</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 模型数量统计 -->
      <div v-if="!loading" class="mt-3 text-right text-sm text-gray-400 dark:text-gray-500">
        显示 {{ sortedModels.length }} / {{ allModels.length }} 个模型
      </div>
    </div>

    <!-- 模型详情弹窗：友好视图 / JSON 切换 -->
    <ModalTransition>
      <div
        v-if="rawModal.show"
        class="modal fixed inset-0 z-50 flex items-center justify-center p-4"
        @click.self="rawModal.show = false"
      >
        <div
          class="modal-content flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-xl dark:bg-gray-800"
        >
          <div
            class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-5 py-4 dark:border-gray-700"
          >
            <div class="min-w-0">
              <h3 class="truncate text-base font-bold text-gray-900 dark:text-white">
                {{ rawModal.title }}
              </h3>
              <p v-if="rawModal.subtitle" class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                {{ rawModal.subtitle }}
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <div class="flex rounded-lg bg-gray-100 p-0.5 dark:bg-gray-700">
                <button
                  :class="[
                    'rounded-md px-3 py-1.5 text-sm font-medium transition',
                    rawModal.viewMode === 'friendly'
                      ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-800'
                      : 'text-gray-600 dark:text-gray-300'
                  ]"
                  @click="rawModal.viewMode = 'friendly'"
                >
                  友好
                </button>
                <button
                  :class="[
                    'rounded-md px-3 py-1.5 text-sm font-medium transition',
                    rawModal.viewMode === 'json'
                      ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-800'
                      : 'text-gray-600 dark:text-gray-300'
                  ]"
                  @click="rawModal.viewMode = 'json'"
                >
                  JSON
                </button>
              </div>
              <button
                v-if="rawModal.scope === 'one' && rawModal.modelName"
                class="inline-flex items-center gap-1 rounded-lg bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                @click="copyModelName(rawModal.modelName)"
              >
                <i class="fas fa-copy" />复制名
              </button>
              <button
                v-if="rawModal.scope === 'one' && rawModal.modelName && !rawModal.isInternal"
                class="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50 dark:bg-emerald-900/30 dark:text-emerald-300"
                :disabled="addingInternalName === rawModal.modelName"
                @click="addToInternal(rawModal.modelName)"
              >
                <i
                  :class="[
                    'fas',
                    addingInternalName === rawModal.modelName ? 'fa-spinner fa-spin' : 'fa-plus'
                  ]"
                />
                加入内部
              </button>
              <button
                v-if="rawModal.scope === 'one' && rawModal.modelName && rawModal.isInternal"
                class="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 transition hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300"
                @click="editFromDetail(rawModal.modelName)"
              >
                <i class="fas fa-edit" />编辑内部价
              </button>
              <button
                class="inline-flex items-center gap-1 rounded-lg bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                @click="copyRaw"
              >
                <i class="fas fa-copy" />复制{{ rawModal.viewMode === 'json' ? 'JSON' : '摘要' }}
              </button>
              <button
                class="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                @click="rawModal.show = false"
              >
                <i class="fas fa-times" />
              </button>
            </div>
          </div>

          <!-- 友好视图 -->
          <div
            v-if="rawModal.viewMode === 'friendly'"
            class="flex-1 space-y-4 overflow-auto px-5 py-4"
          >
            <template v-if="rawModal.scope === 'one' && rawModal.friendly">
              <section
                v-for="section in rawModal.friendly.sections"
                :key="section.title"
                class="rounded-xl border border-gray-200 p-3 dark:border-gray-700"
              >
                <h4 class="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                  {{ section.title }}
                </h4>
                <div class="grid gap-2 sm:grid-cols-2">
                  <div
                    v-for="row in section.rows"
                    :key="section.title + row.label"
                    class="flex items-start justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900/40"
                  >
                    <span class="text-sm text-gray-500 dark:text-gray-400">{{ row.label }}</span>
                    <span
                      class="cursor-pointer text-right text-sm font-medium hover:underline"
                      title="点击复制"
                      :class="[
                        row.mono ? 'font-mono' : '',
                        row.tone || 'text-gray-900 dark:text-gray-100'
                      ]"
                      @click="copyCell(row.value)"
                      >{{ row.value }}</span
                    >
                  </div>
                </div>
              </section>
              <section
                v-if="rawModal.friendly.tags?.length"
                class="rounded-xl border border-gray-200 p-3 dark:border-gray-700"
              >
                <h4 class="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">能力 / 标记</h4>
                <div class="flex flex-wrap gap-1.5">
                  <span
                    v-for="tag in rawModal.friendly.tags"
                    :key="tag"
                    class="rounded bg-blue-50 px-2 py-0.5 text-sm text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                    >{{ tag }}</span
                  >
                </div>
              </section>
              <section
                v-if="rawModal.friendly.extraKeys?.length"
                class="rounded-xl border border-gray-200 p-3 dark:border-gray-700"
              >
                <h4 class="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                  其它字段（{{ rawModal.friendly.extraKeys.length }}）
                </h4>
                <div class="max-h-48 space-y-1 overflow-auto">
                  <div
                    v-for="row in rawModal.friendly.extraKeys"
                    :key="row.label"
                    class="flex gap-3 border-b border-gray-100 py-1 text-sm last:border-0 dark:border-gray-800"
                  >
                    <span class="w-1/2 shrink-0 break-all font-mono text-gray-500">{{
                      row.label
                    }}</span>
                    <span class="w-1/2 break-all font-mono text-gray-800 dark:text-gray-200">{{
                      row.value
                    }}</span>
                  </div>
                </div>
              </section>
            </template>

            <template v-else-if="rawModal.scope === 'all' && rawModal.friendlyAll">
              <div class="grid gap-3 sm:grid-cols-3">
                <div
                  v-for="card in rawModal.friendlyAll.summary"
                  :key="card.label"
                  class="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 dark:border-gray-700 dark:bg-gray-900/40"
                >
                  <p class="text-sm text-gray-500 dark:text-gray-400">{{ card.label }}</p>
                  <p class="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">
                    {{ card.value }}
                  </p>
                </div>
              </div>
              <section class="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
                <h4 class="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                  供应商分布
                </h4>
                <div class="flex flex-wrap gap-2">
                  <span
                    v-for="item in rawModal.friendlyAll.providers"
                    :key="item.name"
                    class="rounded-lg bg-gray-100 px-2.5 py-1 text-sm text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                  >
                    {{ item.name }}
                    <span class="font-semibold text-blue-600 dark:text-blue-400">{{
                      item.count
                    }}</span>
                  </span>
                </div>
              </section>
              <p class="text-sm text-gray-500 dark:text-gray-400">
                全部模型明细请切换到 JSON，或在表格中点单行「查看详情」。
              </p>
            </template>
          </div>

          <!-- JSON 视图 -->
          <pre
            v-else
            class="flex-1 overflow-auto px-5 py-4 text-sm leading-relaxed text-gray-700 dark:text-gray-300"
            >{{ rawModal.content }}</pre
          >
        </div>
      </div>
    </ModalTransition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import ModalTransition from '@/components/common/ModalTransition.vue'
import CustomDropdown from '@/components/common/CustomDropdown.vue'
import InternalModelEditor from '@/components/settings/InternalModelEditor.vue'
import {
  getImportableModelsApi,
  getImportedModelsApi,
  buildInternalFromSeedApi,
  getInternalModelApi,
  getModelPricingApi,
  getModelPricingStatusApi,
  getPublicModelPricingApi,
  importModelsApi,
  pullModelPricingApi,
  refreshModelPricingApi,
  removeImportedModelsApi,
  updateModelPricingSourceApi
} from '@/utils/http_apis'
import { showToast, copyText } from '@/utils/tools'
import { formatLocalDateTime } from '@/utils/time'
import { compareModelsForDisplay, sortModelsForDisplay } from '@/utils/model_sort'

const props = defineProps({
  // 用户统计页只读模式：走公开接口，隐藏刷新与原始数据操作
  readonly: {
    type: Boolean,
    default: false
  }
})

// ========== 状态 ==========
// 二级 tab：三块内容原本纵向堆叠，配置卡片把表格挤到只剩几行高，改为分屏
const sectionTabs = [
  { key: 'table', label: '价格表', icon: 'fa-table' },
  { key: 'source', label: '定价数据源', icon: 'fa-cloud-download-alt' },
  { key: 'catalog', label: '内部计费模型', icon: 'fa-layer-group' }
]
const activeTab = ref('table')
const loading = ref(false)
const refreshing = ref(false)
const pricingData = ref({})
const pricingStatus = ref({})
const searchQuery = ref('')
const activeProvider = ref('')
const sortField = ref('display')
const sortAsc = ref(true)
const tableWrapper = ref(null)
const tableMaxHeight = ref('60vh')
const rawModal = ref({
  show: false,
  title: '',
  subtitle: '',
  content: '',
  viewMode: 'friendly', // friendly | json
  scope: 'one', // one | all
  friendly: null,
  friendlyAll: null,
  modelName: '',
  isInternal: false
})
const addingInternalName = ref('')
const savingSource = ref(false)
const importing = ref(false)
// 数据源表单:只回显自定义值,默认源走 placeholder 展示(留空保存 = 恢复默认)
const sourceForm = ref({ pricingUrl: '', hashUrl: '' })
// 模型目录
const modelsLoading = ref(false)
const importableModels = ref([])
const importedModels = ref([])
const selectedImportable = ref([])
const selectedImported = ref([])
const editor = ref({ show: false, model: null, isCreate: false })
let visibilityObserver = null
let layoutObserver = null

// ========== 计算属性 ==========
const modelCount = computed(() => Object.keys(pricingData.value).length)

const lastUpdated = computed(() => {
  if (!pricingStatus.value.lastUpdated) return '未知'
  return formatLocalDateTime(pricingStatus.value.lastUpdated) || '未知'
})

const toPerM = (perToken) => {
  if (perToken == null || perToken === '') return null
  const num = Number(perToken)
  if (!Number.isFinite(num)) return null
  return num * 1e6
}

const buildCapabilityTags = (data) => {
  const tags = []
  if (data.supports_vision) tags.push('视觉')
  if (data.supports_function_calling) tags.push('工具')
  if (data.supports_prompt_caching) tags.push('缓存')
  if (data.supports_reasoning) tags.push('推理')
  if (data.supports_web_search) tags.push('搜索')
  if (data.supports_service_tier) tags.push('档位')
  if (data.supports_pdf_input) tags.push('PDF')
  if (data.supports_audio_input || data.supports_audio_output) tags.push('音频')
  if (data.mode && data.mode !== 'chat') tags.push(data.mode)
  // 分段价提示
  const hasTier = Object.keys(data || {}).some(
    (key) => key.includes('_above_') && key.includes('cost')
  )
  if (hasTier) tags.push('分段')
  if (data.input_cost_per_token_priority != null || data.output_cost_per_token_priority != null) {
    tags.push('Priority')
  }
  if (data.input_cost_per_token_flex != null || data.output_cost_per_token_flex != null) {
    tags.push('Flex')
  }
  return tags
}

const allModels = computed(() =>
  Object.entries(pricingData.value).map(([name, data]) => {
    const litellmProvider = (data.litellm_provider || '').trim()
    return {
      name,
      // 优先用价格表官方供应商字段，缺失时按模型名推断
      provider: litellmProvider || detectProvider(name) || '其他',
      billingSource: data._billingSource === 'internal' ? 'internal' : 'seed',
      mode: data.mode || '',
      deprecationDate: data.deprecation_date || '',
      inputCost: toPerM(data.input_cost_per_token),
      outputCost: toPerM(data.output_cost_per_token),
      cacheCreateCost: toPerM(data.cache_creation_input_token_cost),
      cacheCreate1hCost: toPerM(data.cache_creation_input_token_cost_above_1hr),
      cacheReadCost: toPerM(data.cache_read_input_token_cost),
      priorityInputCost: toPerM(data.input_cost_per_token_priority),
      priorityOutputCost: toPerM(data.output_cost_per_token_priority),
      maxInputTokens: data.max_input_tokens || data.max_tokens || 0,
      maxOutputTokens: data.max_output_tokens || 0,
      // 兼容旧排序字段
      maxTokens: data.max_input_tokens || data.max_tokens || data.max_output_tokens || 0,
      capabilityTags: buildCapabilityTags(data)
    }
  })
)

// 从当前数据动态收集供应商列表，供可搜索下拉使用
const providerOptions = computed(() => {
  const set = new Set()
  for (const model of allModels.value) {
    if (model.provider) set.add(model.provider)
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b))
})

// CustomDropdown 选项格式 { label, value }
const providerDropdownOptions = computed(() =>
  providerOptions.value.map((provider) => ({ label: provider, value: provider }))
)

const importableDropdownOptions = computed(() =>
  importableModels.value.map((model) => ({
    label: `${model.id} · ${model.provider}`,
    value: model.id
  }))
)

const importedDropdownOptions = computed(() =>
  importedModels.value.map((model) => ({
    label: `${model.id} · ${model.provider}${model.hasBilling ? '' : ' · 仅目录'}`,
    value: model.id
  }))
)

const sortedImportedModels = computed(() =>
  sortModelsForDisplay(
    importedModels.value.map((model) => ({
      ...model,
      name: model.name || model.id
    }))
  )
)

const filteredModels = computed(() => {
  let models = allModels.value

  // 供应商筛选
  if (activeProvider.value) {
    models = models.filter((model) => model.provider === activeProvider.value)
  }

  // 模糊搜索：空格拆多关键词，全部命中（模型名/供应商/mode/能力标签）
  const raw = (searchQuery.value || '').trim().toLowerCase()
  if (raw) {
    const tokens = raw.split(/\s+/).filter(Boolean)
    models = models.filter((model) => {
      const hay = [
        model.name,
        model.provider,
        model.mode,
        model.billingSource,
        ...(model.capabilityTags || [])
      ]
        .join(' ')
        .toLowerCase()
      return tokens.every((token) => hay.includes(token))
    })
  }

  return models
})

const sortedModels = computed(() => {
  const models = [...filteredModels.value]

  // 默认 / 点「模型名称」：llysc 展示序（厂商优先 + 组内版本/日期降序）
  if (sortField.value === 'display' || sortField.value === 'name') {
    const ordered = sortModelsForDisplay(models)
    return sortAsc.value ? ordered : ordered.reverse()
  }

  const fieldMap = {
    input: (model) => model.inputCost ?? -1,
    output: (model) => model.outputCost ?? -1
  }
  const getter = fieldMap[sortField.value]
  if (!getter) return sortModelsForDisplay(models)

  models.sort((a, b) => {
    const valueA = getter(a)
    const valueB = getter(b)
    // null/- 沉底
    const na = valueA == null || valueA === '' ? Number.NEGATIVE_INFINITY : Number(valueA)
    const nb = valueB == null || valueB === '' ? Number.NEGATIVE_INFINITY : Number(valueB)
    return sortAsc.value ? na - nb : nb - na
  })
  return models
})

// ========== 方法 ==========
const detectProvider = (name) => {
  const lowerName = name.toLowerCase()
  if (lowerName.includes('claude')) return 'anthropic'
  if (lowerName.includes('gemini')) return 'gemini'
  if (
    lowerName.includes('gpt') ||
    lowerName.includes('o1') ||
    lowerName.includes('o3') ||
    lowerName.includes('o4') ||
    lowerName.includes('codex')
  ) {
    return 'openai'
  }
  if (lowerName.includes('deepseek')) return 'deepseek'
  if (lowerName.includes('llama') || lowerName.includes('meta')) return 'meta_llama'
  if (lowerName.includes('mistral')) return 'mistral'
  return ''
}

const formatPrice = (price) => {
  if (price == null || price === '') return '-'
  const num = Number(price)
  if (!Number.isFinite(num)) return '-'
  if (num === 0) return '$0'
  if (Math.abs(num) < 0.01) return `$${num.toFixed(4)}`
  if (Math.abs(num) < 1) return `$${num.toFixed(3)}`
  return `$${num.toFixed(2)}`
}

const formatContext = (tokens) => {
  if (!tokens) return '-'
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`
  return String(tokens)
}

// 切回价格表时表格才重新可见，此刻 top 已变，需重算高度（tab 隐藏期间 offsetParent 为 null，calc 会跳过）
const switchTab = async (key) => {
  activeTab.value = key
  if (key !== 'table') return
  await nextTick()
  calcTableHeight()
}

// 三态排序：字段升序 → 字段降序 → 恢复默认展示序（llysc）
const toggleSort = (field) => {
  if (sortField.value !== field) {
    sortField.value = field
    sortAsc.value = true
    return
  }
  if (sortAsc.value) {
    sortAsc.value = false
    return
  }
  sortField.value = 'display'
  sortAsc.value = true
}

const formatRawValue = (value) => {
  if (value == null || value === '') return '-'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    // per-token 价自动转 $/M 展示
    if (Math.abs(value) > 0 && Math.abs(value) < 0.01) {
      return `${formatPrice(value * 1e6)}  (raw ${value})`
    }
    return String(value)
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch (_error) {
      return String(value)
    }
  }
  return String(value)
}

// tone：价格语义色（对齐 llysc 输入绿/输出红）
const PRICE_TONE = {
  input: 'text-green-600 dark:text-green-400',
  output: 'text-red-500 dark:text-red-400',
  cacheWrite: 'text-amber-700 dark:text-amber-400',
  cacheRead: 'text-sky-600 dark:text-sky-400',
  other: 'text-gray-900 dark:text-gray-100'
}

const KNOWN_PRICE_FIELDS = [
  ['input_cost_per_token', '输入', 'input'],
  ['output_cost_per_token', '输出', 'output'],
  ['cache_creation_input_token_cost', '缓存写 5m', 'cacheWrite'],
  ['cache_creation_input_token_cost_above_1hr', '缓存写 1h', 'cacheWrite'],
  ['cache_read_input_token_cost', '缓存读', 'cacheRead'],
  ['input_cost_per_token_priority', 'Priority 输入', 'input'],
  ['output_cost_per_token_priority', 'Priority 输出', 'output'],
  ['cache_creation_input_token_cost_priority', 'Priority 缓存写', 'cacheWrite'],
  ['cache_read_input_token_cost_priority', 'Priority 缓存读', 'cacheRead'],
  ['input_cost_per_token_flex', 'Flex 输入', 'input'],
  ['output_cost_per_token_flex', 'Flex 输出', 'output'],
  ['output_cost_per_reasoning_token', '推理输出', 'output']
]

const KNOWN_META_FIELDS = [
  ['litellm_provider', '供应商'],
  ['mode', 'Mode'],
  ['max_input_tokens', '最大输入 tokens'],
  ['max_output_tokens', '最大输出 tokens'],
  ['max_tokens', 'max_tokens'],
  ['deprecation_date', '弃用日期'],
  ['_billingSource', '计费来源']
]

const buildFriendlyOne = (name, data) => {
  const source = data && typeof data === 'object' ? data : {}
  const metaRows = KNOWN_META_FIELDS.map(([key, label]) => {
    let value = source[key]
    if (key === '_billingSource') {
      value = value === 'internal' ? '内部计费' : value ? String(value) : '种子'
    } else if (key.includes('tokens') && value != null) {
      value = formatContext(Number(value))
    } else {
      value = formatRawValue(value)
    }
    return { label, value, mono: false }
  }).filter((row) => row.value !== '-')

  // 基础定价固定 5 项主序 + 可选扩展；有值才展示，但顺序永不乱
  const BASE_PRICE_ORDER = [
    'input_cost_per_token',
    'output_cost_per_token',
    'cache_creation_input_token_cost',
    'cache_creation_input_token_cost_above_1hr',
    'cache_read_input_token_cost',
    'input_cost_per_token_priority',
    'output_cost_per_token_priority',
    'cache_creation_input_token_cost_priority',
    'cache_read_input_token_cost_priority',
    'input_cost_per_token_flex',
    'output_cost_per_token_flex',
    'output_cost_per_reasoning_token'
  ]
  const priceFieldMap = Object.fromEntries(
    KNOWN_PRICE_FIELDS.map(([key, label, toneKey]) => [key, { label, toneKey }])
  )
  const priceRows = BASE_PRICE_ORDER.map((key) => {
    const meta = priceFieldMap[key]
    if (!meta) return null
    const raw = source[key]
    if (raw == null || raw === '') return null
    return {
      label: meta.label,
      value: formatPrice(Number(raw) * 1e6),
      mono: true,
      tone: PRICE_TONE[meta.toneKey] || PRICE_TONE.other
    }
  }).filter(Boolean)

  // 价格字段固定顺序（基础价 / 分段 / Priority / Flex 一律这个序）
  // 输入 → 输出 → 缓存写5m → 缓存写1h → 缓存读 → 推理
  const METRIC_ORDER = ['输入', '输出', '缓存写 5m', '缓存写 1h', '缓存读', '推理输出', '价格']
  const SERVICE_TIER_ORDER = ['', 'Priority', 'Flex', 'Batch', 'Ultrafast']

  const parseTierKey = (key) => {
    let rest = key
    let serviceTier = ''
    if (rest.endsWith('_priority')) {
      serviceTier = 'Priority'
      rest = rest.slice(0, -'_priority'.length)
    } else if (rest.endsWith('_flex')) {
      serviceTier = 'Flex'
      rest = rest.slice(0, -'_flex'.length)
    } else if (rest.endsWith('_batch') || rest.endsWith('_batches')) {
      serviceTier = 'Batch'
      rest = rest.replace(/_batches?$/, '')
    } else if (rest.endsWith('_ultrafast')) {
      serviceTier = 'Ultrafast'
      rest = rest.slice(0, -'_ultrafast'.length)
    }

    const thresholds = []
    const thrRe = /_above_(\d+)k_tokens/g
    let match
    while ((match = thrRe.exec(rest)) !== null) {
      thresholds.push(Number(match[1]))
    }
    const has1h = /_above_1hr/.test(rest)
    rest = rest
      .replace(/_above_\d+k_tokens/g, '')
      .replace(/_above_1hr/g, '')
      .replace(/_tokens$/g, '')

    let metric = '价格'
    if (rest.startsWith('input_cost_per_token')) metric = '输入'
    else if (rest.startsWith('output_cost_per_token')) metric = '输出'
    else if (rest.startsWith('output_cost_per_reasoning_token')) metric = '推理输出'
    else if (rest.startsWith('cache_creation_input_token_cost') || rest.includes('cache_creation')) {
      metric = has1h ? '缓存写 1h' : '缓存写 5m'
    } else if (rest.startsWith('cache_read_input_token_cost') || rest.includes('cache_read')) {
      metric = '缓存读'
    }

    return { serviceTier, thresholds, metric, has1h }
  }

  // 分段字段：只认「token 阈值」分段（_above_{N}k_tokens）
  // cache_creation_input_token_cost_above_1hr 是基础 1h 价，已在基础定价里，不进分段
  const knownPriceKeySet = new Set(KNOWN_PRICE_FIELDS.map((item) => item[0]))
  const tierKeys = Object.keys(source).filter((key) => {
    if (knownPriceKeySet.has(key)) return false
    if (!key.toLowerCase().includes('cost')) return false
    // 必须带 Nk_tokens 阈值，纯 above_1hr 不算分段
    return /_above_\d+k_tokens/.test(key)
  })

  // 按阈值分组；组内按 服务档 → 指标固定序
  const tierGroups = new Map()
  for (const key of tierKeys) {
    const parsed = parseTierKey(key)
    const thrLabel = parsed.thresholds.length
      ? parsed.thresholds.map((n) => `>${n}K`).join(' ')
      : '其它分段'
    if (!tierGroups.has(thrLabel)) tierGroups.set(thrLabel, [])

    const labelParts = []
    if (parsed.serviceTier) labelParts.push(parsed.serviceTier)
    labelParts.push(parsed.metric)
    if (parsed.thresholds.length) {
      labelParts.push(parsed.thresholds.map((n) => `>${n}K`).join(' '))
    }

    let tone = PRICE_TONE.other
    if (parsed.metric === '输入') tone = PRICE_TONE.input
    else if (parsed.metric === '输出' || parsed.metric === '推理输出') tone = PRICE_TONE.output
    else if (parsed.metric.startsWith('缓存写')) tone = PRICE_TONE.cacheWrite
    else if (parsed.metric === '缓存读') tone = PRICE_TONE.cacheRead

    tierGroups.get(thrLabel).push({
      label: labelParts.join(' · '),
      value: formatPrice(Number(source[key]) * 1e6),
      mono: true,
      tone,
      rawKey: key,
      _serviceTier: parsed.serviceTier,
      _metric: parsed.metric,
      _threshold: parsed.thresholds[0] || 0
    })
  }

  // 组按阈值数字升序；组内固定：档位序 + 指标序
  const sortedTierEntries = [...tierGroups.entries()].sort((a, b) => {
    const na = Number((a[0].match(/(\d+)/) || [])[1] || 0)
    const nb = Number((b[0].match(/(\d+)/) || [])[1] || 0)
    return na - nb || a[0].localeCompare(b[0])
  })
  tierGroups.clear()
  for (const [label, rows] of sortedTierEntries) {
    rows.sort((a, b) => {
      const sa = SERVICE_TIER_ORDER.indexOf(a._serviceTier)
      const sb = SERVICE_TIER_ORDER.indexOf(b._serviceTier)
      if (sa !== sb) return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb)
      const ma = METRIC_ORDER.indexOf(a._metric)
      const mb = METRIC_ORDER.indexOf(b._metric)
      if (ma !== mb) return (ma < 0 ? 99 : ma) - (mb < 0 ? 99 : mb)
      return a.label.localeCompare(b.label)
    })
    tierGroups.set(label, rows)
  }

  // ---------- 可解析的扩展字段（友好展示，不进「其它」） ----------
  const CAPABILITY_FIELDS = [
    ['supports_vision', '视觉'],
    ['supports_function_calling', '函数调用'],
    ['supports_parallel_function_calling', '并行函数调用'],
    ['supports_prompt_caching', '提示缓存'],
    ['supports_reasoning', '推理'],
    ['supports_web_search', '联网搜索'],
    ['supports_service_tier', '服务档位'],
    ['supports_pdf_input', 'PDF 输入'],
    ['supports_audio_input', '音频输入'],
    ['supports_audio_output', '音频输出'],
    ['supports_response_schema', '结构化输出'],
    ['supports_system_messages', '系统消息'],
    ['supports_tool_choice', '工具选择'],
    ['supports_assistant_prefill', '助手预填'],
    ['supports_computer_use', '电脑使用'],
    ['supports_url_context', 'URL 上下文'],
    ['supports_video_input', '视频输入'],
    ['supports_native_streaming', '原生流式']
  ]

  const LIMIT_FIELDS = [
    ['max_images_per_prompt', '单次最多图片'],
    ['max_videos_per_prompt', '单次最多视频'],
    ['max_video_length', '视频最长(秒)'],
    ['max_audio_per_prompt', '单次最多音频'],
    ['max_audio_length_hours', '音频最长(小时)'],
    ['max_pdf_size_mb', 'PDF 最大(MB)'],
    ['tool_use_system_prompt_tokens', '工具系统提示 tokens']
  ]

  // 多模态价：按单位友好格式化
  const formatMoney = (raw, scale = 1, suffix = '') => {
    if (raw == null || raw === '') return null
    const num = Number(raw) * scale
    if (!Number.isFinite(num)) return String(raw)
    return `${formatPrice(num)}${suffix}`
  }

  const MULTIMODAL_PRICE_FIELDS = [
    ['input_cost_per_audio_token', '音频输入', () => formatMoney(source.input_cost_per_audio_token, 1e6, ' /M')],
    ['output_cost_per_audio_token', '音频输出', () => formatMoney(source.output_cost_per_audio_token, 1e6, ' /M')],
    ['input_cost_per_audio_per_second', '音频输入', () => formatMoney(source.input_cost_per_audio_per_second, 1, ' /秒')],
    ['output_cost_per_audio_per_second', '音频输出', () => formatMoney(source.output_cost_per_audio_per_second, 1, ' /秒')],
    ['cache_creation_input_audio_token_cost', '音频缓存写', () => formatMoney(source.cache_creation_input_audio_token_cost, 1e6, ' /M')],
    ['cache_read_input_audio_token_cost', '音频缓存读', () => formatMoney(source.cache_read_input_audio_token_cost, 1e6, ' /M')],
    ['input_cost_per_image', '图片输入', () => formatMoney(source.input_cost_per_image, 1, ' /张')],
    ['output_cost_per_image', '图片输出', () => formatMoney(source.output_cost_per_image, 1, ' /张')],
    ['input_cost_per_image_token', '图片输入', () => formatMoney(source.input_cost_per_image_token, 1e6, ' /M')],
    ['output_cost_per_image_token', '图片输出', () => formatMoney(source.output_cost_per_image_token, 1e6, ' /M')],
    ['input_cost_per_pixel', '图片输入', () => formatMoney(source.input_cost_per_pixel, 1, ' /px')],
    ['output_cost_per_pixel', '图片输出', () => formatMoney(source.output_cost_per_pixel, 1, ' /px')],
    ['cache_read_input_image_token_cost', '图片缓存读', () => formatMoney(source.cache_read_input_image_token_cost, 1e6, ' /M')],
    ['input_cost_per_video_per_second', '视频输入', () => formatMoney(source.input_cost_per_video_per_second, 1, ' /秒')],
    ['output_cost_per_video_per_second', '视频输出', () => formatMoney(source.output_cost_per_video_per_second, 1, ' /秒')],
    ['input_cost_per_character', '字符输入', () => formatMoney(source.input_cost_per_character, 1, ' /字')],
    ['output_cost_per_character', '字符输出', () => formatMoney(source.output_cost_per_character, 1, ' /字')],
    ['input_cost_per_query', '按查询', () => formatMoney(source.input_cost_per_query, 1, ' /次')],
    ['input_cost_per_request', '按请求', () => formatMoney(source.input_cost_per_request, 1, ' /次')],
    ['input_cost_per_token_batches', 'Batch 输入', () => formatMoney(source.input_cost_per_token_batches, 1e6, ' /M')],
    ['output_cost_per_token_batches', 'Batch 输出', () => formatMoney(source.output_cost_per_token_batches, 1e6, ' /M')],
    ['input_dbu_cost_per_token', 'DBU 输入', () => formatMoney(source.input_dbu_cost_per_token, 1e6, ' /M')],
    ['output_dbu_cost_per_token', 'DBU 输出', () => formatMoney(source.output_dbu_cost_per_token, 1e6, ' /M')],
    ['ocr_cost_per_page', 'OCR', () => formatMoney(source.ocr_cost_per_page, 1, ' /页')]
  ]

  const formatListValue = (value) => {
    if (Array.isArray(value)) {
      if (!value.length) return '-'
      return value.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join('、')
    }
    if (value && typeof value === 'object') {
      return Object.entries(value)
        .map(([k, v]) => `${k}: ${v}`)
        .join('；')
    }
    return formatRawValue(value)
  }

  const capabilityDetailRows = CAPABILITY_FIELDS.map(([key, label]) => {
    if (source[key] == null) return null
    return {
      label,
      value: source[key] ? '支持' : '不支持',
      mono: false,
      tone: source[key] ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400'
    }
  }).filter(Boolean)

  const limitRows = LIMIT_FIELDS.map(([key, label]) => {
    if (source[key] == null || source[key] === '') return null
    return { label, value: formatRawValue(source[key]), mono: true }
  }).filter(Boolean)

  const multimodalRows = MULTIMODAL_PRICE_FIELDS.map(([key, label, fmt]) => {
    if (source[key] == null || source[key] === '') return null
    const value = fmt()
    if (value == null) return null
    let tone = PRICE_TONE.other
    if (label.includes('输入')) tone = PRICE_TONE.input
    else if (label.includes('输出')) tone = PRICE_TONE.output
    else if (label.includes('缓存写')) tone = PRICE_TONE.cacheWrite
    else if (label.includes('缓存读')) tone = PRICE_TONE.cacheRead
    return { label, value, mono: true, tone }
  }).filter(Boolean)

  // 搜索上下文价（嵌套）
  const searchRows = []
  const scq = source.search_context_cost_per_query
  if (scq && typeof scq === 'object') {
    const map = [
      ['search_context_size_low', '搜索上下文 · Low'],
      ['search_context_size_medium', '搜索上下文 · Medium'],
      ['search_context_size_high', '搜索上下文 · High']
    ]
    for (const [k, label] of map) {
      if (scq[k] == null || scq[k] === '') continue
      searchRows.push({
        label,
        value: formatMoney(scq[k], 1, ' /次') || formatRawValue(scq[k]),
        mono: true
      })
    }
  }

  // provider_specific_entry（如 fast 倍率）
  const providerExtraRows = []
  const pse = source.provider_specific_entry
  if (pse && typeof pse === 'object') {
    if (pse.fast != null && pse.fast !== '') {
      providerExtraRows.push({
        label: 'Fast 倍率',
        value: String(pse.fast),
        mono: true,
        tone: 'text-purple-600 dark:text-purple-400'
      })
    }
    for (const [k, v] of Object.entries(pse)) {
      if (k === 'fast') continue
      providerExtraRows.push({
        label: `厂商扩展 · ${k}`,
        value: formatListValue(v),
        mono: true
      })
    }
  }

  // 数组类元数据
  const metaExtraRows = []
  for (const [key, label] of [
    ['source', '数据来源'],
    ['supported_endpoints', '支持端点'],
    ['supported_modalities', '输入模态'],
    ['supported_output_modalities', '输出模态']
  ]) {
    if (source[key] == null || source[key] === '') continue
    metaExtraRows.push({ label, value: formatListValue(source[key]), mono: false })
  }

  // 128k 等多模态阈值分段（非标准 Nk token cost 字段）
  const mmTier = {}
  for (const key of Object.keys(source)) {
    const m = key.match(/^(.*)_above_(\d+)k_tokens$/)
    if (!m) continue
    if (tierKeys.includes(key)) continue // 已在长上下文文本价里
    if (knownPriceKeySet.has(key)) continue
    const thr = `>${m[2]}K`
    if (!mmTier[thr]) mmTier[thr] = []
    let label = m[1]
    if (label.includes('audio_per_second')) label = '音频输入 /秒'
    else if (label.includes('video_per_second')) label = '视频输入 /秒'
    else if (label.includes('character') && label.includes('input')) label = '字符输入'
    else if (label.includes('character') && label.includes('output')) label = '字符输出'
    else if (label.includes('image')) label = '图片输入'
    else label = m[1]
    const scale = m[1].includes('per_token') ? 1e6 : 1
    const suffix = m[1].includes('per_second')
      ? ' /秒'
      : m[1].includes('per_token')
        ? ' /M'
        : m[1].includes('character')
          ? ' /字'
          : m[1].includes('image')
            ? ' /张'
            : ''
    mmTier[thr].push({
      label: `${label} · ${thr}`,
      value: formatMoney(source[key], scale, suffix) || formatRawValue(source[key]),
      mono: true
    })
  }

  const consumed = new Set([
    ...KNOWN_META_FIELDS.map((item) => item[0]),
    ...KNOWN_PRICE_FIELDS.map((item) => item[0]),
    ...tierKeys,
    ...CAPABILITY_FIELDS.map((item) => item[0]),
    ...LIMIT_FIELDS.map((item) => item[0]),
    ...MULTIMODAL_PRICE_FIELDS.map((item) => item[0]),
    'search_context_cost_per_query',
    'provider_specific_entry',
    'source',
    'supported_endpoints',
    'supported_modalities',
    'supported_output_modalities'
  ])
  // multimodal above_* keys consumed
  for (const key of Object.keys(source)) {
    if (/_above_\d+k_tokens$/.test(key) && !tierKeys.includes(key) && !knownPriceKeySet.has(key)) {
      consumed.add(key)
    }
  }

  const extraKeys = Object.keys(source)
    .filter((key) => !consumed.has(key))
    .sort()
    .map((key) => ({ label: key, value: formatListValue(source[key]) }))

  const sections = []
  if (metaRows.length || metaExtraRows.length) {
    sections.push({ title: '基础信息', rows: [...metaRows, ...metaExtraRows] })
  }
  if (priceRows.length) sections.push({ title: '基础定价（$/M tokens）', rows: priceRows })
  for (const [thrLabel, rows] of tierGroups) {
    sections.push({
      title: thrLabel === '其它分段' ? '分段 / 长上下文定价（$/M）' : `长上下文 ${thrLabel}（$/M）`,
      rows
    })
  }
  if (multimodalRows.length) sections.push({ title: '多模态定价', rows: multimodalRows })
  if (searchRows.length) sections.push({ title: '搜索定价', rows: searchRows })
  for (const thr of Object.keys(mmTier).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))) {
    sections.push({ title: `多模态长上下文 ${thr}`, rows: mmTier[thr] })
  }
  if (providerExtraRows.length) sections.push({ title: '厂商扩展', rows: providerExtraRows })
  if (limitRows.length) sections.push({ title: '限制 / 容量', rows: limitRows })
  if (capabilityDetailRows.length) sections.push({ title: '能力明细', rows: capabilityDetailRows })

  return {
    name,
    sections,
    tags: buildCapabilityTags(source),
    extraKeys
  }
}

const buildFriendlyAll = () => {
  const models = allModels.value
  const providerCount = {}
  let internalCount = 0
  for (const model of models) {
    providerCount[model.provider || '其他'] = (providerCount[model.provider || '其他'] || 0) + 1
    if (model.billingSource === 'internal') internalCount++
  }
  const providers = Object.entries(providerCount)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  return {
    summary: [
      { label: '模型总数', value: String(models.length) },
      { label: '内部计费', value: String(internalCount) },
      { label: '供应商数', value: String(providers.length) }
    ],
    providers
  }
}

const showRawOne = (name) => {
  const data = pricingData.value[name] || {}
  rawModal.value = {
    show: true,
    title: name,
    subtitle: data.litellm_provider || detectProvider(name) || '',
    content: JSON.stringify(data, null, 2),
    viewMode: 'friendly',
    scope: 'one',
    friendly: buildFriendlyOne(name, data),
    friendlyAll: null,
    modelName: name,
    isInternal: data._billingSource === 'internal'
  }
}

const showRawAll = () => {
  rawModal.value = {
    show: true,
    title: `全部模型数据 (${modelCount.value})`,
    subtitle: '友好视图为汇总；完整明细请切 JSON',
    content: JSON.stringify(pricingData.value, null, 2),
    viewMode: 'friendly',
    scope: 'all',
    friendly: null,
    friendlyAll: buildFriendlyAll(),
    modelName: '',
    isInternal: false
  }
}

const copyRaw = () => {
  if (rawModal.value.viewMode === 'json') {
    copyText(rawModal.value.content)
    return
  }
  // 友好模式：复制当前结构化摘要文本
  if (rawModal.value.scope === 'one' && rawModal.value.friendly) {
    const lines = [`# ${rawModal.value.title}`, '']
    for (const section of rawModal.value.friendly.sections || []) {
      lines.push(`## ${section.title}`)
      for (const row of section.rows) {
        lines.push(`${row.label}: ${row.value}`)
      }
      lines.push('')
    }
    if (rawModal.value.friendly.tags?.length) {
      lines.push(`能力: ${rawModal.value.friendly.tags.join(', ')}`)
    }
    copyText(lines.join('\n'))
    return
  }
  copyText(rawModal.value.content)
}

// 累加表格下方到视口底的固定占用，跨断点自适应，无需写死常量。每层算三块：
// ① 节点自身的下外边距 ② 该节点之后兄弟的(上外边距+高度+下外边距) ③ 父级的下内边距+下边框
// getBoundingClientRect().height 是 border-box，不含 margin，必须单独累加，
// 否则会稳定少算（如统计行的 mt-3、卡片层的 1px 边框），表现为页面差一点点能滑
const calcBottomReserve = (el) => {
  const px = (v) => parseFloat(v) || 0
  let reserve = 8 // 安全垫，吸收子像素取整
  for (
    let node = el;
    node && node !== document.body && node.parentElement;
    node = node.parentElement
  ) {
    const parent = node.parentElement
    reserve += px(getComputedStyle(node).marginBottom)
    for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
      const ss = getComputedStyle(sib)
      // 跳过浮层（模态框等），它们不占文档流
      if (ss.position === 'fixed' || ss.position === 'absolute') continue
      reserve += px(ss.marginTop) + sib.getBoundingClientRect().height + px(ss.marginBottom)
    }
    const ps = getComputedStyle(parent)
    reserve += px(ps.paddingBottom) + px(ps.borderBottomWidth)
  }
  return reserve
}

// 按视口剩余空间动态计算表格高度。不设固定下限——固定下限会在剩余空间小于它时
// 把表格强行撑高，反而撑出视口（常见于 ~768px 笔记本，剩余恰好略小于旧的 240px）。
// 直接用剩余高度：多则多、少则少并内部滚动，maxHeight 永不超过剩余，页面绝不超高；负值兜底 0
const MOBILE_BREAKPOINT = 768
const calcTableHeight = () => {
  const el = tableWrapper.value
  // offsetParent 为 null 说明所在 tab 被 v-show 隐藏，此时 rect 不可信，跳过
  if (!el || el.offsetParent === null) return
  // 移动端（< md 768px）不锁高度：让表格自然撑开、整页滚动，避免顶部内容变高时剩余被压到接近 0
  if (window.innerWidth < MOBILE_BREAKPOINT) {
    tableMaxHeight.value = 'none'
    return
  }
  const top = el.getBoundingClientRect().top
  const avail = window.innerHeight - top - calcBottomReserve(el)
  tableMaxHeight.value = `${Math.max(0, Math.floor(avail))}px`
}

// tab 由隐藏变可见时重新计算（refresh 重建表格 DOM 后也需重新绑定）
const observeVisibility = () => {
  if (!tableWrapper.value) return
  if (visibilityObserver) visibilityObserver.disconnect()
  visibilityObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) calcTableHeight()
  })
  visibilityObserver.observe(tableWrapper.value)
}

// 后端回显的地址已脱敏(隐去 query),不能回填输入框——否则保存会把脱敏值当真值写回、丢掉参数。
// 输入框始终清空:填了才改,不填不动;要回默认走"恢复默认"按钮。
const syncSourceForm = () => {
  sourceForm.value = { pricingUrl: '', hashUrl: '' }
}

const loadData = async () => {
  loading.value = true
  if (props.readonly) {
    const result = await getPublicModelPricingApi()
    if (result.success) {
      pricingData.value = result.data?.pricing || {}
      pricingStatus.value = result.data?.status || {}
    } else {
      showToast(result.message || '加载模型价格失败', 'error')
    }
  } else {
    const [pricingResult, statusResult] = await Promise.all([
      getModelPricingApi(),
      getModelPricingStatusApi()
    ])
    if (pricingResult.success) {
      pricingData.value = pricingResult.data
    } else {
      showToast(pricingResult.message || '加载模型价格失败', 'error')
    }
    if (statusResult.success) {
      pricingStatus.value = statusResult.data
      syncSourceForm()
    } else {
      showToast(statusResult.message || '获取价格状态失败', 'error')
    }
  }
  loading.value = false
  await nextTick()
  calcTableHeight()
  observeVisibility()
}

const handleRefresh = async () => {
  refreshing.value = true
  const result = await refreshModelPricingApi()
  if (result.success) {
    showToast('价格数据已刷新', 'success')
    await loadData()
  } else {
    showToast(result.message || '刷新失败', 'error')
  }
  refreshing.value = false
}

const saveSource = async (payload) => {
  savingSource.value = true
  const result = await updateModelPricingSourceApi(payload)
  if (result.success) {
    showToast('数据源已保存', 'success')
    await loadData()
  } else {
    showToast(result.message || '保存数据源失败', 'error')
  }
  savingSource.value = false
  return result.success
}

const handleSaveSource = () => {
  // 两框皆空时不当作"恢复默认":那是"恢复默认"按钮的语义,避免误清配置
  if (!sourceForm.value.pricingUrl.trim()) {
    showToast('请填写定价 JSON 地址；要回到内置源请点「恢复默认」', 'error')
    return
  }
  return saveSource({
    pricingUrl: sourceForm.value.pricingUrl,
    hashUrl: sourceForm.value.hashUrl
  })
}

const handleResetSource = () => saveSource({ pricingUrl: '', hashUrl: '' })

// 模型目录:可导入 + 已导入并行拉,两个列表独立无依赖
const loadModelCatalog = async () => {
  modelsLoading.value = true
  const [importableResult, importedResult] = await Promise.all([
    getImportableModelsApi(),
    getImportedModelsApi()
  ])
  if (importableResult.success) {
    importableModels.value = importableResult.data?.models || []
  } else {
    showToast(importableResult.message || '获取可导入模型失败', 'error')
  }
  if (importedResult.success) {
    importedModels.value = importedResult.data?.models || []
  } else {
    showToast(importedResult.message || '获取已导入模型失败', 'error')
  }
  modelsLoading.value = false
}

const handleImportModels = async () => {
  modelsLoading.value = true
  const result = await importModelsApi(selectedImportable.value)
  if (result.success) {
    showToast(result.message || '导入完成', 'success')
    selectedImportable.value = []
  } else {
    showToast(result.message || '导入失败', 'error')
  }
  modelsLoading.value = false
  await loadData()
  await loadModelCatalog()
}

const handleRemoveModels = async () => {
  modelsLoading.value = true
  const result = await removeImportedModelsApi(selectedImported.value)
  if (result.success) {
    showToast(result.message || '移除完成', 'success')
    selectedImported.value = []
  } else {
    showToast(result.message || '移除失败', 'error')
  }
  modelsLoading.value = false
  await loadData()
  await loadModelCatalog()
}

const handleImport = async () => {
  importing.value = true
  const result = await pullModelPricingApi()
  if (result.success) {
    showToast(`已拉取最新价格，共 ${result.data?.modelCount ?? 0} 个模型`, 'success')
  } else {
    showToast(result.message || '拉取失败', 'error')
  }
  // 失败时也刷新:后端会回落 fallback 数据,展示需与实际一致
  await loadData()
  // 价格变了,可导入清单跟着变
  await loadModelCatalog()
  importing.value = false
}

const copyModelName = (name) => {
  if (!name) return
  copyText(name)
}

// 表格单元格点击复制（对齐 llysc：hover 下划线 + toast）
const copyCell = (value) => {
  if (value == null) return
  const text = String(value).trim()
  if (!text || text === '-') return
  copyText(text)
}

// 复制：打开编辑弹窗（后端完整转换预填，名 name-copy）
const copyToInternalEditor = async (name) => {
  if (!name) return
  rawModal.value.show = false
  addingInternalName.value = name
  const internal = await getInternalModelApi(name)
  if (internal.success && internal.data?.pricing) {
    addingInternalName.value = ''
    const data = internal.data
    editor.value = {
      show: true,
      isCreate: true,
      model: {
        ...data,
        name: `${data.name || name}-copy`,
        id: undefined
      }
    }
    return
  }
  const seeded = await buildInternalFromSeedApi(name, true)
  addingInternalName.value = ''
  if (!seeded.success) {
    showToast(seeded.message || '从种子构建模型失败', 'error')
    return
  }
  editor.value = { show: true, isCreate: true, model: seeded.data }
}

// 加入内部：先弹编辑框（后端完整转换预填，含分段/Priority/多模态），保存再落库
const addToInternal = async (name, _options = {}) => {
  if (!name || addingInternalName.value) return
  rawModal.value.show = false
  addingInternalName.value = name
  const existing = await getInternalModelApi(name)
  if (existing.success && existing.data?.hasBilling && existing.data?.pricing) {
    addingInternalName.value = ''
    editor.value = { show: true, model: existing.data, isCreate: false }
    return
  }
  const seeded = await buildInternalFromSeedApi(name, false)
  addingInternalName.value = ''
  if (!seeded.success) {
    showToast(seeded.message || '从种子构建模型失败', 'error')
    return
  }
  editor.value = { show: true, isCreate: true, model: seeded.data }
}

const editFromDetail = async (name) => {
  rawModal.value.show = false
  await openEditInternalByName(name)
}

const openCreateInternal = () => {
  editor.value = { show: true, model: null, isCreate: true }
}

const openEditInternal = (model) => {
  editor.value = { show: true, model: { ...model, name: model.name || model.id }, isCreate: false }
}

const openEditInternalByName = async (name) => {
  const result = await getInternalModelApi(name)
  if (!result.success) {
    showToast(result.message || '加载内部模型失败', 'error')
    return
  }
  editor.value = { show: true, model: result.data, isCreate: false }
}

const handleInternalSaved = async () => {
  await loadData()
  await loadModelCatalog()
}

onMounted(() => {
  loadData()
  if (!props.readonly) {
    loadModelCatalog()
  }
  window.addEventListener('resize', calcTableHeight)
  // 上方布局（AppHeader 更新提示出现、站点标题加载后换行等）异步变化会改变表格 top，
  // 这些不触发 resize，用 ResizeObserver 兜住；计算幂等（不依赖表格自身高度）故不会循环
  layoutObserver = new ResizeObserver(() => calcTableHeight())
  layoutObserver.observe(document.body)
})

onUnmounted(() => {
  window.removeEventListener('resize', calcTableHeight)
  if (visibilityObserver) visibilityObserver.disconnect()
  if (layoutObserver) layoutObserver.disconnect()
})
</script>
