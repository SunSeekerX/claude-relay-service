<template>
  <div>
    <!-- 管理端：tab + 右侧计数/刷新（extra 槽，不另起一块） -->
    <div v-if="!readonly" class="mb-2">
      <SegmentedTabs
        v-model="activeTab"
        class="w-full"
        :tabs="sectionTabs"
      >
        <template #extra>
          <div class="flex flex-wrap items-center gap-2">
            <i class="i-lucide-coins text-blue-500 dark:text-blue-400" />
            <span class="text-sm text-gray-600 dark:text-gray-300">
              显示
              <span class="font-bold text-blue-600 dark:text-blue-400">{{
                sortedModels.length
              }}</span>
              /
              <span class="font-bold text-blue-600 dark:text-blue-400">{{ modelCount }}</span>
              <span class="mx-1 text-blue-200 dark:text-blue-700">·</span>
              <span class="text-gray-500 dark:text-gray-400">更新 {{ lastUpdated }}</span>
            </span>
            <button
              class="btn btn-primary h-8 inline-flex items-center text-sm font-medium"
              type="button"
              :disabled="refreshing"
              @click="handleRefresh"
            >
              <i
                :class="[
                  refreshing ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw'
                ]"
              />
              {{ refreshing ? '刷新中' : '刷新' }}
            </button>
          </div>
        </template>
      </SegmentedTabs>
    </div>

    <!-- 价格表筛选条；只读模式把计数塞右侧，不独占一行 -->
    <div
      v-show="readonly || activeTab === 'table'"
      class="mb-2 flex flex-col gap-2 rounded-xl border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-800 sm:flex-row sm:items-center"
    >
      <div class="toolbar-search-wrap min-w-0 flex-1">
        <i class="input-affix-icon input-affix-icon--left i-lucide-search" />
        <input
          v-model="searchQuery"
          class="toolbar-search-input"
          placeholder="模糊搜索模型名 / 供应商（空格多关键词）"
          type="text"
        />
      </div>
      <div class="w-full shrink-0 sm:w-44">
        <CustomDropdown
          v-model="activeProvider"
          accent="blue"
          clearable
          icon="i-lucide-server"
          :options="providerDropdownOptions"
          placeholder="全部供应商"
          search-placeholder="搜索供应商..."
          searchable
        />
      </div>
      <div
        v-if="readonly"
        class="inline-flex flex-wrap items-center gap-1.5 text-sm sm:ml-auto sm:shrink-0"
      >
        <i class="i-lucide-coins text-blue-500 dark:text-blue-400" />
        <span class="text-gray-600 dark:text-gray-300">
          显示
          <span class="font-bold text-blue-600 dark:text-blue-400">{{
            sortedModels.length
          }}</span>
          /
          <span class="font-bold text-blue-600 dark:text-blue-400">{{ modelCount }}</span>
          <span class="mx-1 text-blue-200 dark:text-blue-700">·</span>
          <span class="text-gray-500 dark:text-gray-400">更新 {{ lastUpdated }}</span>
        </span>
      </div>
    </div>
    <p v-if="readonly" class="mb-2 text-sm text-gray-500 dark:text-gray-400">
      以下为官方参考单价（$/百万 tokens）。实际扣费可能叠加服务倍率与 API Key 倍率。
    </p>

    <!-- 数据源配置（管理端可改，改完点“拉取最新价格”即时生效，无需重启） -->
    <div
      v-if="!readonly"
      v-show="activeTab === 'source'"
      class="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
    >
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <i class="i-lucide-cloud-download text-blue-500" />
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
            <i :class="['mr-1', savingSource ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-save']" />
            保存
          </button>
          <button
            class="rounded-lg bg-blue-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="savingSource || importing"
            @click="handleImport"
          >
            <i :class="['mr-1', importing ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-download']" />
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
            class="form-input w-full"
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
            class="form-input w-full"
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
      class="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
    >
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <i class="i-lucide-layers text-emerald-500" />
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
          <i :class="['mr-1', modelsLoading ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw']" />
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
          <i class="i-lucide-plus mr-1" />
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
              icon="i-lucide-box"
              multiple
              :options="importableDropdownOptions"
              placeholder="选择要导入的模型（可搜索）"
              search-placeholder="搜索模型..."
              searchable
            />
          </div>
          <button
            class="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="modelsLoading || selectedImportable.length === 0"
            @click="handleImportModels"
          >
            <i class="i-lucide-plus mr-1" />
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
              icon="i-lucide-layers"
              multiple
              :options="importedDropdownOptions"
              placeholder="选择要移除的内部模型"
              search-placeholder="搜索模型..."
              searchable
            />
          </div>
          <button
            class="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
            :disabled="modelsLoading || selectedImported.length === 0"
            @click="handleRemoveModels"
          >
            <i class="i-lucide-minus mr-1" />
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
                <th class="px-3 py-2 text-center font-medium text-green-700 dark:text-green-400">
                  输入 $/M
                </th>
                <th class="px-3 py-2 text-center font-medium text-red-600 dark:text-red-400">
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
                      class="t-table-action"
                      title="复制为新的内部模型并编辑"
                      @click="copyToInternalEditor(model.id || model.name)"
                    >
                      <i class="i-lucide-copy" />复制
                    </button>
                    <button
                      class="t-table-action t-table-action--primary"
                      @click="openEditInternalByName(model.id || model.name)"
                    >
                      <i class="i-lucide-pen-line" />编辑
                    </button>
                    <button
                      class="t-table-action"
                      @click="showRawOne(model.id || model.name)"
                    >
                      <i class="i-lucide-eye" />详情
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
      :is-create="editor.isCreate"
      :model="editor.model"
      :show="true"
      @close="editor.show = false"
      @saved="handleInternalSaved"
    />

    <!-- 价格表 tab -->
    <div v-show="readonly || activeTab === 'table'">
      <!-- 加载状态 -->
      <div v-if="loading" class="py-12 text-center">
        <i class="i-lucide-loader-circle animate-spin mb-4 text-2xl text-blue-500" />
        <p class="text-gray-500 dark:text-gray-400">加载价格数据中...</p>
      </div>

      <!-- 表格 -->
      <div
        v-else
        ref="tableWrapper"
        class="overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 dark:border-gray-700"
        :style="{ maxHeight: tableMaxHeight }"
      >
        <table class="w-full table-fixed text-sm">
          <colgroup>
            <col class="w-[22%]" />
            <col class="w-[7%]" />
            <col class="w-[8%]" />
            <col class="w-[8%]" />
            <col class="w-[8%]" />
            <col class="w-[8%]" />
            <col class="w-[8%]" />
            <col class="w-[7%]" />
            <col class="w-[7%]" />
            <col class="w-[7%]" />
            <col class="w-[10%]" />
            <col class="w-[10%]" />
          </colgroup>
          <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-gray-800">
            <tr>
              <th
                class="cursor-pointer px-2 py-3 text-left font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400"
                @click="toggleSort('name')"
              >
                模型
                <i
                  v-if="sortField === 'name'"
                  :class="['ml-1', sortAsc ? 'i-lucide-arrow-up' : 'i-lucide-arrow-down']"
                />
              </th>
              <th class="px-2 py-3 text-center font-medium text-gray-500 dark:text-gray-400">
                来源
              </th>
              <th class="px-2 py-3 text-center font-medium text-gray-500 dark:text-gray-400">
                Mode
              </th>
              <th
                class="cursor-pointer px-2 py-3 text-center font-medium text-green-700 hover:text-green-800 dark:text-green-400"
                @click="toggleSort('input')"
              >
                输入
                <i
                  v-if="sortField === 'input'"
                  :class="['ml-1', sortAsc ? 'i-lucide-arrow-up' : 'i-lucide-arrow-down']"
                />
              </th>
              <th
                class="cursor-pointer px-2 py-3 text-center font-medium text-red-600 hover:text-red-700 dark:text-red-400"
                @click="toggleSort('output')"
              >
                输出
                <i
                  v-if="sortField === 'output'"
                  :class="['ml-1', sortAsc ? 'i-lucide-arrow-up' : 'i-lucide-arrow-down']"
                />
              </th>
              <th class="px-2 py-3 text-center font-medium text-amber-700 dark:text-amber-400">
                写5m
              </th>
              <th class="px-2 py-3 text-center font-medium text-amber-700 dark:text-amber-400">
                写1h
              </th>
              <th class="px-2 py-3 text-center font-medium text-sky-600 dark:text-sky-400">
                读
              </th>
              <th class="px-2 py-3 text-center font-medium text-gray-500 dark:text-gray-400">
                最大入
              </th>
              <th class="px-2 py-3 text-center font-medium text-gray-500 dark:text-gray-400">
                最大出
              </th>
              <th class="px-2 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                能力
              </th>
              <th class="px-2 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                <button
                  v-if="!readonly"
                  class="t-table-action t-table-action--primary"
                  type="button"
                  @click="showRawAll"
                >
                  <i class="i-lucide-list" />详情
                </button>
                <span v-else>详情</span>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
            <tr
              v-for="model in sortedModels"
              :key="model.name"
              class="transition hover:bg-gray-50 dark:hover:bg-gray-800/50"
            >
              <td class="px-2 py-2 text-left align-middle">
                <div
                  class="cursor-pointer break-words font-semibold leading-snug text-gray-900 hover:underline dark:text-gray-100"
                  title="点击复制模型名"
                  @click="copyCell(model.name)"
                >
                  {{ model.name }}
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
                  <span
                    class="cursor-pointer rounded bg-gray-100 px-1.5 py-0.5 hover:underline dark:bg-gray-700/80"
                    title="点击复制供应商"
                    @click="copyCell(model.provider)"
                    >{{ model.provider || '-' }}</span
                  >
                  <span v-if="model.deprecationDate" class="text-amber-600 dark:text-amber-400">
                    弃用 {{ model.deprecationDate }}
                  </span>
                </div>
              </td>
              <td class="px-2 py-2 text-center align-middle">
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
              <td class="px-2 py-2 text-center align-middle text-gray-600 dark:text-gray-300">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(model.mode)"
                  >{{ model.mode || '-' }}</span
                >
              </td>
              <!-- 价格语义色对齐 llysc：输入绿 / 输出红；点击复制 -->
              <td class="px-1.5 py-2 text-center align-middle font-num text-sm font-medium text-green-600 dark:text-green-400">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatPrice(model.inputCost))"
                  >{{ formatPrice(model.inputCost) }}</span
                >
              </td>
              <td class="px-1.5 py-2 text-center align-middle font-num text-sm font-medium text-red-500 dark:text-red-400">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatPrice(model.outputCost))"
                  >{{ formatPrice(model.outputCost) }}</span
                >
              </td>
              <td class="px-1.5 py-2 text-center align-middle font-num text-sm text-amber-700 dark:text-amber-400">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatPrice(model.cacheCreateCost))"
                  >{{ formatPrice(model.cacheCreateCost) }}</span
                >
              </td>
              <td class="px-1.5 py-2 text-center align-middle font-num text-sm text-amber-700 dark:text-amber-400">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatPrice(model.cacheCreate1hCost))"
                  >{{ formatPrice(model.cacheCreate1hCost) }}</span
                >
              </td>
              <td class="px-1.5 py-2 text-center align-middle font-num text-sm text-sky-600 dark:text-sky-400">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatPrice(model.cacheReadCost))"
                  >{{ formatPrice(model.cacheReadCost) }}</span
                >
              </td>
              <td class="px-1.5 py-2 text-center align-middle font-num text-sm text-gray-600 dark:text-gray-300">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatContext(model.maxInputTokens))"
                  >{{ formatContext(model.maxInputTokens) }}</span
                >
              </td>
              <td class="px-1.5 py-2 text-center align-middle font-num text-sm text-gray-600 dark:text-gray-300">
                <span
                  class="cursor-pointer hover:underline"
                  title="点击复制"
                  @click="copyCell(formatContext(model.maxOutputTokens))"
                  >{{ formatContext(model.maxOutputTokens) }}</span
                >
              </td>
              <td class="px-2 py-2 text-left align-middle">
                <div class="flex flex-wrap gap-0.5">
                  <span
                    v-for="tag in model.capabilityTags"
                    :key="tag"
                    class="rounded bg-blue-50 px-1.5 py-0.5 text-sm text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                    >{{ tag }}</span
                  >
                  <span v-if="!model.capabilityTags.length" class="text-gray-400">-</span>
                </div>
              </td>
              <td class="px-1.5 py-2 text-left align-middle">
                <div class="t-table-actions flex-col sm:flex-row">
                  <template v-if="!readonly">
                    <button
                      class="t-table-action"
                      title="复制为新内部模型并打开编辑"
                      type="button"
                      @click="copyToInternalEditor(model.name)"
                    >
                      <i class="i-lucide-copy" />复制
                    </button>
                    <button
                      v-if="model.billingSource !== 'internal'"
                      class="t-table-action t-table-action--success"
                      :disabled="addingInternalName === model.name"
                      title="打开编辑弹窗，保存后成为内部计费模型"
                      type="button"
                      @click="addToInternal(model.name)"
                    >
                      <i
                        :class="[
                          addingInternalName === model.name
                            ? 'i-lucide-loader-circle animate-spin'
                            : 'i-lucide-plus'
                        ]"
                      />
                      加入内部
                    </button>
                    <button
                      v-else
                      class="t-table-action t-table-action--primary"
                      title="编辑内部计费模型"
                      type="button"
                      @click="openEditInternalByName(model.name)"
                    >
                      <i class="i-lucide-pen-line" />编辑
                    </button>
                  </template>
                  <button
                    class="t-table-action t-table-action--primary"
                    title="查看基础价 / 分段 / 分级定价"
                    type="button"
                    @click="showRawOne(model.name)"
                  >
                    <i class="i-lucide-eye" />详情
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="sortedModels.length === 0">
              <td
                class="px-3 py-5 text-center text-gray-500 dark:text-gray-400"
                colspan="13"
              >
                <i class="i-lucide-search mb-2 text-2xl text-gray-300 dark:text-gray-600" />
                <p>没有匹配的模型</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

    </div>

    <!-- 模型详情弹窗：友好视图 / JSON 切换 -->
    <ModalTransition>
      <div
        v-if="rawModal.show"
        class="modal fixed inset-0 z-50 flex items-center justify-center p-4"
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
                <i class="i-lucide-copy" />复制名
              </button>
              <button
                v-if="
                  !readonly &&
                  rawModal.scope === 'one' &&
                  rawModal.modelName &&
                  !rawModal.isInternal
                "
                class="inline-flex items-center gap-1 whitespace-nowrap rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50 dark:bg-emerald-900/30 dark:text-emerald-300"
                :disabled="addingInternalName === rawModal.modelName"
                type="button"
                @click="addToInternal(rawModal.modelName)"
              >
                <i
                  :class="[
                    addingInternalName === rawModal.modelName
                      ? 'i-lucide-loader-circle animate-spin'
                      : 'i-lucide-plus'
                  ]"
                />
                加入内部
              </button>
              <button
                v-if="
                  !readonly &&
                  rawModal.scope === 'one' &&
                  rawModal.modelName &&
                  rawModal.isInternal
                "
                class="inline-flex items-center gap-1 whitespace-nowrap rounded-lg bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 transition hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300"
                type="button"
                @click="editFromDetail(rawModal.modelName)"
              >
                <i class="i-lucide-pen-line" />编辑内部价
              </button>
              <button
                class="inline-flex items-center gap-1 rounded-lg bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                @click="copyRaw"
              >
                <i class="i-lucide-copy" />复制{{ rawModal.viewMode === 'json' ? 'JSON' : '摘要' }}
              </button>
              <button
                class="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                @click="rawModal.show = false"
              >
                <i class="i-lucide-x" />
              </button>
            </div>
          </div>

          <!-- 友好视图 -->
          <div
            v-if="rawModal.viewMode === 'friendly'"
            class="flex-1 space-y-4 overflow-auto px-5 py-4"
          >
            <template v-if="rawModal.scope === 'one' && rawModal.friendly">
              <!-- 对齐 llysc：紧凑文本块 + 价格语义色 -->
              <div class="space-y-3 text-sm">
                <div
                  v-if="rawModal.friendly.infoParts?.length"
                  class="flex flex-wrap gap-x-4 gap-y-1"
                >
                  <span
                    v-for="(part, idx) in rawModal.friendly.infoParts"
                    :key="idx"
                    class="rounded-md bg-gray-100 px-2 py-0.5 text-gray-600 dark:bg-gray-700/70 dark:text-gray-300"
                  >
                    {{ part }}
                  </span>
                </div>

                <div
                  v-if="rawModal.friendly.baseParts?.length || rawModal.friendly.baseLine"
                  class="rounded-xl border border-gray-200 p-3 dark:border-gray-700"
                >
                  <div class="mb-1.5 text-sm font-semibold text-blue-600 dark:text-blue-400">
                    基础价格
                  </div>
                  <div
                    class="cursor-pointer font-num leading-relaxed hover:underline"
                    title="点击复制"
                    @click="copyCell(rawModal.friendly.baseLine)"
                  >
                    <template v-if="rawModal.friendly.baseParts?.length">
                      <span
                        v-for="(part, idx) in rawModal.friendly.baseParts"
                        :key="'bp' + idx"
                        class="mr-2 inline-block"
                      >
                        <span class="text-gray-500 dark:text-gray-400">{{ part.label }}:</span>
                        <span class="font-medium" :class="priceToneClass(part.key)">{{
                          part.value
                        }}</span>
                        <span
                          v-if="idx < rawModal.friendly.baseParts.length - 1"
                          class="text-gray-300 dark:text-gray-600"
                          >,
                        </span>
                      </span>
                    </template>
                    <span v-else class="text-gray-800 dark:text-gray-200">{{
                      rawModal.friendly.baseLine
                    }}</span>
                  </div>
                </div>

                <div
                  v-if="rawModal.friendly.baseTiers?.length"
                  class="rounded-xl border border-orange-200/70 p-3 dark:border-orange-900/40"
                >
                  <div class="mb-1.5 text-sm font-semibold text-orange-600 dark:text-orange-400">
                    分段定价
                  </div>
                  <div
                    v-for="(tier, idx) in rawModal.friendly.baseTiers"
                    :key="'bt' + idx"
                    class="cursor-pointer font-num leading-relaxed hover:underline"
                    title="点击复制"
                    @click="copyCell(tier.label + ': ' + tier.text)"
                  >
                    <span class="font-medium text-orange-700 dark:text-orange-300"
                      >{{ tier.label }}:</span
                    >
                    <template v-if="tier.parts?.length">
                      <span v-for="(part, pidx) in tier.parts" :key="'btp' + pidx" class="ml-1">
                        <span class="text-gray-500 dark:text-gray-400">{{ part.label }}:</span>
                        <span class="font-medium" :class="priceToneClass(part.key)">{{
                          part.value
                        }}</span>
                        <span
                          v-if="pidx < tier.parts.length - 1"
                          class="text-gray-300 dark:text-gray-600"
                          >,</span
                        >
                      </span>
                    </template>
                    <span v-else class="ml-1 text-gray-800 dark:text-gray-200">{{ tier.text }}</span>
                  </div>
                </div>

                <div
                  v-if="rawModal.friendly.tierLines?.length"
                  class="rounded-xl border border-violet-200/70 p-3 dark:border-violet-900/40"
                >
                  <div class="mb-1.5 text-sm font-semibold text-violet-600 dark:text-violet-400">
                    分级定价
                  </div>
                  <p
                    v-if="rawModal.friendly.tierLines.some((line) => line.estimated || String(line.label).includes('推导'))"
                    class="mb-1 text-sm text-orange-600 dark:text-orange-400"
                  >
                    标注「推导」的长上下文单价由基础档倍率估算，非官方独立报价，对账请以实收字段为准。
                  </p>
                  <div
                    v-for="(line, idx) in rawModal.friendly.tierLines"
                    :key="'tl' + idx"
                    class="cursor-pointer font-num leading-relaxed hover:underline"
                    title="点击复制"
                    @click="copyCell(line.label + ': ' + line.text)"
                  >
                    <span
                      class="whitespace-pre font-medium"
                      :class="serviceTierLabelClass(line)"
                      >{{ line.label }}:</span
                    >
                    <template v-if="line.parts?.length">
                      <span v-for="(part, pidx) in line.parts" :key="'tlp' + pidx" class="ml-1">
                        <span class="text-gray-500 dark:text-gray-400">{{ part.label }}:</span>
                        <span class="font-medium" :class="priceToneClass(part.key)">{{
                          part.value
                        }}</span>
                        <span
                          v-if="pidx < line.parts.length - 1"
                          class="text-gray-300 dark:text-gray-600"
                          >,</span
                        >
                      </span>
                    </template>
                    <span v-else class="ml-1 text-gray-800 dark:text-gray-200">{{ line.text }}</span>
                  </div>
                </div>

                <div
                  v-if="rawModal.friendly.multimodalLine"
                  class="rounded-xl border border-teal-200/70 p-3 dark:border-teal-900/40"
                >
                  <div class="mb-1.5 text-sm font-semibold text-teal-600 dark:text-teal-400">
                    多模态定价
                  </div>
                  <div
                    class="cursor-pointer font-num font-medium text-teal-700 hover:underline dark:text-teal-300"
                    title="点击复制"
                    @click="copyCell(rawModal.friendly.multimodalLine)"
                  >
                    {{ rawModal.friendly.multimodalLine }}
                  </div>
                </div>

                <div v-if="rawModal.friendly.capabilityTags?.length">
                  <div class="mb-1.5 text-sm font-semibold text-gray-600 dark:text-gray-300">
                    全部能力
                  </div>
                  <div class="flex flex-wrap gap-1">
                    <span
                      v-for="tag in rawModal.friendly.capabilityTags"
                      :key="tag"
                      class="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                      >{{ tag }}</span
                    >
                  </div>
                </div>

                <p
                  v-if="
                    !rawModal.friendly.baseLine &&
                    !rawModal.friendly.baseTiers?.length &&
                    !rawModal.friendly.tierLines?.length &&
                    !rawModal.friendly.multimodalLine
                  "
                  class="text-gray-500 dark:text-gray-400"
                >
                  暂无结构化定价字段，可切换 JSON 查看原始数据。
                </p>
              </div>
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
import ModalTransition from '@/components/common/modal_transition.vue'
import CustomDropdown from '@/components/common/custom_dropdown.vue'
import SegmentedTabs from '@/components/common/segmented_tabs.vue'
import InternalModelEditor from '@/components/settings/internal_model_editor.vue'
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
} from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast, copyText } from '@/libs/tools'
import { formatLocalDateTime } from '@/libs/time'
import { sortModelsForDisplay } from '@/libs/model_sort'
import { buildModelPricingDetailView } from '@/libs/model_pricing_detail_format'

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
  { key: 'table', label: '价格表', icon: 'i-lucide-table' },
  { key: 'source', label: '定价数据源', icon: 'i-lucide-cloud-download' },
  { key: 'catalog', label: '内部计费模型', icon: 'i-lucide-layers' }
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

// 详情弹窗价格语义色
const priceToneClass = (key) => {
  const map = {
    input: 'text-green-600 dark:text-green-400',
    output: 'text-red-500 dark:text-red-400',
    cacheWrite: 'text-amber-600 dark:text-amber-400',
    cacheRead: 'text-sky-600 dark:text-sky-400',
    reasoning: 'text-purple-600 dark:text-purple-400',
    other: 'text-gray-800 dark:text-gray-200'
  }
  return map[key] || map.other
}

const serviceTierLabelClass = (line) => {
  const tier = String(line?.tier || line?.label || '').toLowerCase()
  if (tier.includes('priority')) return 'text-violet-700 dark:text-violet-300'
  if (tier.includes('flex')) return 'text-cyan-700 dark:text-cyan-300'
  if (tier.includes('batch')) return 'text-slate-600 dark:text-slate-300'
  if (String(line?.label || '').includes('推导') || line?.estimated) {
    return 'text-orange-600 dark:text-orange-400'
  }
  if (String(line?.label || '').includes('>')) return 'text-orange-700 dark:text-orange-300'
  return 'text-gray-800 dark:text-gray-200'
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

// tone：价格语义色（对齐 llysc 输入绿/输出红）
const buildFriendlyOne = (name, data) => {
  // 对齐 llysc 详情：基础价 / 分段 / Priority·Flex 分级 / 多模态 / 能力
  return buildModelPricingDetailView(name, data && typeof data === 'object' ? data : {})
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
  // 友好模式：复制 llysc 风格摘要
  if (rawModal.value.scope === 'one' && rawModal.value.friendly?.summaryText) {
    copyText(rawModal.value.friendly.summaryText)
    return
  }
  if (rawModal.value.scope === 'all' && rawModal.value.friendlyAll) {
    const lines = ['# 全部模型摘要', '']
    for (const card of rawModal.value.friendlyAll.summary || []) {
      lines.push(`${card.label}: ${card.value}`)
    }
    lines.push('', '## 供应商分布')
    for (const item of rawModal.value.friendlyAll.providers || []) {
      lines.push(`${item.name}: ${item.count}`)
    }
    copyText(lines.join('\n'))
    return
  }
  copyText(rawModal.value.content || '')
}

// 累加表格下方到视口底的固定占用，跨断点自适应，无需写死常量。每层算三块：
// ① 节点自身的下外边距 ② 该节点之后兄弟的(上外边距+高度+下外边距) ③ 父级的下内边距+下边框
// getBoundingClientRect().height 是 border-box，不含 margin，必须单独累加，
// 否则会稳定少算（如统计行的 mt-3、卡片层的 1px 边框），表现为页面差一点点能滑
// 底部预留：只沿祖先累加 padding/border/margin，不扫后续兄弟（避免价格大表每次 RO 全页强制布局）
const calcBottomReserve = (el) => {
  const px = (v) => parseFloat(v) || 0
  let reserve = 12
  for (
    let node = el;
    node && node !== document.body && node.parentElement;
    node = node.parentElement
  ) {
    const cs = getComputedStyle(node)
    reserve += px(cs.marginBottom) + px(cs.paddingBottom) + px(cs.borderBottomWidth)
  }
  return reserve
}

let heightCalcScheduled = false
const scheduleTableHeight = () => {
  if (heightCalcScheduled) return
  heightCalcScheduled = true
  requestAnimationFrame(() => {
    heightCalcScheduled = false
    calcTableHeight()
  })
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
    if (entries[0].isIntersecting) scheduleTableHeight()
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
    if (isOk(result)) {
      pricingData.value = result.data?.pricing || {}
      pricingStatus.value = result.data?.status || {}
    } else {
      showToast(msgOf(result, '加载模型价格失败'), 'error')
    }
  } else {
    const [pricingResult, statusResult] = await Promise.all([
      getModelPricingApi(),
      getModelPricingStatusApi()
    ])
    if (isOk(pricingResult)) {
      pricingData.value = pricingResult.data
    } else {
      showToast(msgOf(pricingResult, '加载模型价格失败'), 'error')
    }
    if (isOk(statusResult)) {
      pricingStatus.value = statusResult.data
      syncSourceForm()
    } else {
      showToast(msgOf(statusResult, '获取价格状态失败'), 'error')
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
  if (isOk(result)) {
    showToast('价格数据已刷新', 'success')
    await loadData()
  } else {
    showToast(msgOf(result, '刷新失败'), 'error')
  }
  refreshing.value = false
}

const saveSource = async (payload) => {
  savingSource.value = true
  const result = await updateModelPricingSourceApi(payload)
  if (isOk(result)) {
    showToast('数据源已保存', 'success')
    await loadData()
  } else {
    showToast(msgOf(result, '保存数据源失败'), 'error')
  }
  savingSource.value = false
  return isOk(result)
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
  if (isOk(importableResult)) {
    importableModels.value = importableResult.data?.models || []
  } else {
    showToast(msgOf(importableResult, '获取可导入模型失败'), 'error')
  }
  if (isOk(importedResult)) {
    importedModels.value = importedResult.data?.models || []
  } else {
    showToast(msgOf(importedResult, '获取已导入模型失败'), 'error')
  }
  modelsLoading.value = false
}

const handleImportModels = async () => {
  modelsLoading.value = true
  const result = await importModelsApi(selectedImportable.value)
  if (isOk(result)) {
    showToast(msgOf(result, '导入完成'), 'success')
    selectedImportable.value = []
  } else {
    showToast(msgOf(result, '导入失败'), 'error')
  }
  modelsLoading.value = false
  await loadData()
  await loadModelCatalog()
}

const handleRemoveModels = async () => {
  modelsLoading.value = true
  const result = await removeImportedModelsApi(selectedImported.value)
  if (isOk(result)) {
    showToast(msgOf(result, '移除完成'), 'success')
    selectedImported.value = []
  } else {
    showToast(msgOf(result, '移除失败'), 'error')
  }
  modelsLoading.value = false
  await loadData()
  await loadModelCatalog()
}

const handleImport = async () => {
  importing.value = true
  const result = await pullModelPricingApi()
  if (isOk(result)) {
    showToast(`已拉取最新价格，共 ${result.data?.modelCount ?? 0} 个模型`, 'success')
  } else {
    showToast(msgOf(result, '拉取失败'), 'error')
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
  if (isOk(internal) && internal.data?.pricing) {
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
  if (!isOk(seeded)) {
    showToast(msgOf(seeded, '从种子构建模型失败'), 'error')
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
  if (isOk(existing) && existing.data?.hasBilling && existing.data?.pricing) {
    addingInternalName.value = ''
    editor.value = { show: true, model: existing.data, isCreate: false }
    return
  }
  const seeded = await buildInternalFromSeedApi(name, false)
  addingInternalName.value = ''
  if (!isOk(seeded)) {
    showToast(msgOf(seeded, '从种子构建模型失败'), 'error')
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

const openEditInternalByName = async (name) => {
  const result = await getInternalModelApi(name)
  if (!isOk(result)) {
    showToast(msgOf(result, '加载内部模型失败'), 'error')
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
  window.addEventListener('resize', scheduleTableHeight)
  // 只观察表格自身容器，避免 document.body 上 RO 因大表重排反复触发强制布局
  layoutObserver = new ResizeObserver(() => scheduleTableHeight())
  const observeTarget = tableWrapper.value?.parentElement || tableWrapper.value
  if (observeTarget) layoutObserver.observe(observeTarget)
})

onUnmounted(() => {
  window.removeEventListener('resize', scheduleTableHeight)
  if (visibilityObserver) visibilityObserver.disconnect()
  if (layoutObserver) layoutObserver.disconnect()
})
</script>
