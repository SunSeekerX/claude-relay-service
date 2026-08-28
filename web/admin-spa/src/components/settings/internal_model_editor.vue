<template>
  <ModalTransition>
    <div
      v-if="show"
      class="modal fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
      @click.self="$emit('close')"
    >
      <div
        class="modal-content flex max-h-[95vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl dark:bg-gray-800 sm:rounded-2xl"
      >
        <div
          class="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700"
        >
          <div>
            <h3 class="text-base font-semibold text-gray-900 dark:text-gray-100">
              {{ isCreate ? '新建内部计费模型' : '编辑内部计费模型' }}
            </h3>
            <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              整模保存；有内部模型时计费与用户价表优先用它
            </p>
          </div>
          <button
            class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
            @click="$emit('close')"
          >
            <i class="i-lucide-x" />
          </button>
        </div>

        <div class="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <!-- 基础信息 -->
          <section class="space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-200">基础信息</h4>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="block text-sm">
                <span class="mb-1 block text-gray-600 dark:text-gray-300">模型名称</span>
                <input
                  v-model="form.name"
                  class="form-input w-full"
                  :disabled="!isCreate"
                  placeholder="claude-sonnet-4-5"
                />
              </label>
              <label class="block text-sm">
                <span class="mb-1 block text-gray-600 dark:text-gray-300">Provider</span>
                <input
                  v-model="form.provider"
                  class="form-input w-full"
                  placeholder="anthropic / openai / google"
                />
              </label>
              <label class="block text-sm">
                <span class="mb-1 block text-gray-600 dark:text-gray-300">Mode</span>
                <input
                  v-model="form.mode"
                  class="form-input w-full"
                  list="internal-model-mode-options"
                  placeholder="chat / responses / completion ..."
                />
                <datalist id="internal-model-mode-options">
                  <option value="chat" />
                  <option value="responses" />
                  <option value="completion" />
                  <option value="embedding" />
                  <option value="image_generation" />
                  <option value="audio_speech" />
                  <option value="audio_transcription" />
                </datalist>
              </label>
              <label class="block text-sm">
                <span class="mb-1 block text-gray-600 dark:text-gray-300">Model Group</span>
                <input
                  v-model="form.modelGroup"
                  class="form-input w-full"
                />
              </label>
              <label class="block text-sm">
                <span class="mb-1 block text-gray-600 dark:text-gray-300">最大输入 tokens</span>
                <input
                  v-model.number="form.maxInputTokens"
                  class="form-input w-full"
                  min="0"
                  type="number"
                />
              </label>
              <label class="block text-sm">
                <span class="mb-1 block text-gray-600 dark:text-gray-300">最大输出 tokens</span>
                <input
                  v-model.number="form.maxOutputTokens"
                  class="form-input w-full"
                  min="0"
                  type="number"
                />
              </label>
              <label class="block text-sm sm:col-span-2">
                <span class="mb-1 block text-gray-600 dark:text-gray-300">弃用日期</span>
                <input
                  v-model="form.deprecationDate"
                  class="form-input w-full"
                  placeholder="YYYY-MM-DD"
                />
              </label>
            </div>
          </section>

          <!-- 基础价 -->
          <section class="space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-200">
              基础定价（$/M tokens）
            </h4>
            <div class="grid gap-3 sm:grid-cols-2">
              <label
                v-for="field in basePriceFields"
                :key="field.key"
                class="block text-sm"
              >
                <span class="mb-1 block text-gray-600 dark:text-gray-300">{{ field.label }}</span>
                <input
                  v-model="form.pricing[field.key]"
                  class="form-input w-full"
                  :placeholder="field.placeholder || '0'"
                />
              </label>
            </div>
          </section>

          <!-- 标准分段 -->
          <section class="space-y-2 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
            <div class="flex items-center justify-between">
              <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-200">
                标准分段定价 price_tiers
              </h4>
              <button class="text-sm text-blue-600 dark:text-blue-400" type="button" @click="addTier(form.pricing.price_tiers)">
                + 添加分段
              </button>
            </div>
            <p v-if="!form.pricing.price_tiers.length" class="text-sm text-gray-500">暂无分段</p>
            <div
              v-for="(tier, index) in form.pricing.price_tiers"
              :key="'base-tier-' + index"
              class="mb-2 space-y-2 rounded-lg border border-gray-100 p-2 dark:border-gray-700"
            >
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-500">threshold（context &gt; threshold）</span>
                <button
                  class="text-sm text-red-500"
                  type="button"
                  @click="form.pricing.price_tiers.splice(index, 1)"
                >
                  删除
                </button>
              </div>
              <input
                v-model.number="tier.threshold"
                class="form-input w-full"
                type="number"
              />
              <div class="grid gap-2 sm:grid-cols-2">
                <label
                  v-for="field in tierPriceFields"
                  :key="field.key"
                  class="block text-sm"
                >
                  <span class="mb-1 block text-gray-600 dark:text-gray-300">{{ field.label }}</span>
                  <input
                    v-model="tier[field.key]"
                    class="form-input w-full"
                  />
                </label>
              </div>
            </div>
          </section>

          <!-- Priority -->
          <section class="space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-200">
              Priority / Fast 定价
            </h4>
            <div class="grid gap-3 sm:grid-cols-2">
              <label
                v-for="field in tierLevelFields"
                :key="'p-' + field.key"
                class="block text-sm"
              >
                <span class="mb-1 block text-gray-600 dark:text-gray-300">{{ field.label }}</span>
                <input
                  v-model="form.pricing.priority_pricing[field.key]"
                  class="form-input w-full"
                  placeholder="留空=同基础价"
                />
              </label>
            </div>
            <div class="flex items-center justify-between">
              <h5 class="text-sm font-medium text-gray-600 dark:text-gray-300">Priority 分段</h5>
              <button
                class="text-sm text-blue-600 dark:text-blue-400"
                type="button"
                @click="addTier(form.pricing.priority_pricing.price_tiers)"
              >
                + 添加分段
              </button>
            </div>
            <div
              v-for="(tier, index) in form.pricing.priority_pricing.price_tiers"
              :key="'p-tier-' + index"
              class="mb-2 space-y-2 rounded-lg border border-gray-100 p-2 dark:border-gray-700"
            >
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-500">threshold</span>
                <button
                  class="text-sm text-red-500"
                  type="button"
                  @click="form.pricing.priority_pricing.price_tiers.splice(index, 1)"
                >
                  删除
                </button>
              </div>
              <input
                v-model.number="tier.threshold"
                class="form-input w-full"
                type="number"
              />
              <div class="grid gap-2 sm:grid-cols-2">
                <label
                  v-for="field in tierPriceFields"
                  :key="'pt-' + field.key"
                  class="block text-sm"
                >
                  <span class="mb-1 block text-gray-600 dark:text-gray-300">{{ field.label }}</span>
                  <input
                    v-model="tier[field.key]"
                    class="form-input w-full"
                  />
                </label>
              </div>
            </div>
          </section>

          <!-- Flex -->
          <section class="space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-200">Flex / Batch 定价</h4>
            <div class="grid gap-3 sm:grid-cols-2">
              <label
                v-for="field in tierLevelFields"
                :key="'f-' + field.key"
                class="block text-sm"
              >
                <span class="mb-1 block text-gray-600 dark:text-gray-300">{{ field.label }}</span>
                <input
                  v-model="form.pricing.flex_pricing[field.key]"
                  class="form-input w-full"
                  placeholder="留空=同基础价"
                />
              </label>
            </div>
            <div class="flex items-center justify-between">
              <h5 class="text-sm font-medium text-gray-600 dark:text-gray-300">Flex 分段</h5>
              <button
                class="text-sm text-blue-600 dark:text-blue-400"
                type="button"
                @click="addTier(form.pricing.flex_pricing.price_tiers)"
              >
                + 添加分段
              </button>
            </div>
            <div
              v-for="(tier, index) in form.pricing.flex_pricing.price_tiers"
              :key="'f-tier-' + index"
              class="mb-2 space-y-2 rounded-lg border border-gray-100 p-2 dark:border-gray-700"
            >
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-500">threshold</span>
                <button
                  class="text-sm text-red-500"
                  type="button"
                  @click="form.pricing.flex_pricing.price_tiers.splice(index, 1)"
                >
                  删除
                </button>
              </div>
              <input
                v-model.number="tier.threshold"
                class="form-input w-full"
                type="number"
              />
              <div class="grid gap-2 sm:grid-cols-2">
                <label
                  v-for="field in tierPriceFields"
                  :key="'ft-' + field.key"
                  class="block text-sm"
                >
                  <span class="mb-1 block text-gray-600 dark:text-gray-300">{{ field.label }}</span>
                  <input
                    v-model="tier[field.key]"
                    class="form-input w-full"
                  />
                </label>
              </div>
            </div>
          </section>

          <!-- 多模态 -->
          <section class="space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-200">
              音频 / 图片 / 视频 / 其它
            </h4>
            <div class="grid gap-3 sm:grid-cols-2">
              <label
                v-for="field in multiPriceFields"
                :key="field.key"
                class="block text-sm"
              >
                <span class="mb-1 block text-gray-600 dark:text-gray-300">{{ field.label }}</span>
                <input
                  v-if="!field.nested"
                  v-model="form.pricing[field.key]"
                  class="form-input w-full"
                />
                <input
                  v-else
                  v-model="form.pricing.search_context_cost[field.key]"
                  class="form-input w-full"
                />
              </label>
            </div>

            <div>
              <div class="mb-2 flex items-center justify-between">
                <span class="text-sm text-gray-600 dark:text-gray-300">图片输出分段</span>
                <button
                  class="text-sm text-blue-600 dark:text-blue-400"
                  type="button"
                  @click="form.pricing.image_output_tiers.push({ condition: '', output_per_image: '' })"
                >
                  + 添加
                </button>
              </div>
              <div
                v-for="(tier, index) in form.pricing.image_output_tiers"
                :key="'img-' + index"
                class="mb-2 grid grid-cols-[1fr_1fr_auto] gap-2"
              >
                <input
                  v-model="tier.condition"
                  class="form-input"
                  placeholder="condition 如 1024x1024"
                />
                <input
                  v-model="tier.output_per_image"
                  class="form-input"
                  placeholder="output_per_image"
                />
                <button
                  class="text-sm text-red-500"
                  type="button"
                  @click="form.pricing.image_output_tiers.splice(index, 1)"
                >
                  删
                </button>
              </div>
            </div>

            <div>
              <div class="mb-2 flex items-center justify-between">
                <span class="text-sm text-gray-600 dark:text-gray-300">视频时长分段</span>
                <button
                  class="text-sm text-blue-600 dark:text-blue-400"
                  type="button"
                  @click="
                    form.pricing.video_input_tiers.push({
                      threshold_seconds: 8,
                      input_per_second: ''
                    })
                  "
                >
                  + 添加
                </button>
              </div>
              <div
                v-for="(tier, index) in form.pricing.video_input_tiers"
                :key="'vid-' + index"
                class="mb-2 grid grid-cols-[1fr_1fr_auto] gap-2"
              >
                <input
                  v-model.number="tier.threshold_seconds"
                  class="form-input w-full"
                  min="0"
                  type="number"
                />
                <input
                  v-model="tier.input_per_second"
                  class="form-input"
                  placeholder="input_per_second"
                />
                <button
                  class="text-sm text-red-500"
                  type="button"
                  @click="form.pricing.video_input_tiers.splice(index, 1)"
                >
                  删
                </button>
              </div>
            </div>

            <div>
              <div class="mb-2 flex items-center justify-between">
                <span class="text-sm text-gray-600 dark:text-gray-300">多模态长上下文分段</span>
                <button
                  class="text-sm text-blue-600 dark:text-blue-400"
                  type="button"
                  @click="
                    form.pricing.multimodal_tiers.push({
                      threshold: 128000,
                      audio_input_per_second: '',
                      video_input_per_second: '',
                      input_per_character: '',
                      output_per_character: '',
                      image_input_per_image: ''
                    })
                  "
                >
                  + 添加
                </button>
              </div>
              <div
                v-for="(tier, index) in form.pricing.multimodal_tiers"
                :key="'mm-' + index"
                class="mb-3 space-y-2 rounded-lg border border-gray-100 p-2 dark:border-gray-700"
              >
                <div class="flex items-center justify-between">
                  <span class="text-sm text-gray-500">threshold tokens</span>
                  <button
                    class="text-sm text-red-500"
                    type="button"
                    @click="form.pricing.multimodal_tiers.splice(index, 1)"
                  >
                    删除
                  </button>
                </div>
                <input
                  v-model.number="tier.threshold"
                  class="form-input w-full"
                  min="0"
                  type="number"
                />
                <div class="grid gap-2 sm:grid-cols-2">
                  <label class="block text-sm">
                    <span class="mb-1 block text-gray-600 dark:text-gray-300">audio $/秒</span>
                    <input
                      v-model="tier.audio_input_per_second"
                      class="form-input w-full"
                    />
                  </label>
                  <label class="block text-sm">
                    <span class="mb-1 block text-gray-600 dark:text-gray-300">video $/秒</span>
                    <input
                      v-model="tier.video_input_per_second"
                      class="form-input w-full"
                    />
                  </label>
                  <label class="block text-sm">
                    <span class="mb-1 block text-gray-600 dark:text-gray-300">input $/字符</span>
                    <input
                      v-model="tier.input_per_character"
                      class="form-input w-full"
                    />
                  </label>
                  <label class="block text-sm">
                    <span class="mb-1 block text-gray-600 dark:text-gray-300">output $/字符</span>
                    <input
                      v-model="tier.output_per_character"
                      class="form-input w-full"
                    />
                  </label>
                  <label class="block text-sm">
                    <span class="mb-1 block text-gray-600 dark:text-gray-300">image $/张</span>
                    <input
                      v-model="tier.image_input_per_image"
                      class="form-input w-full"
                    />
                  </label>
                </div>
              </div>
            </div>
          </section>

          <!-- 能力 -->
          <section class="space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-200">能力标识</h4>
            <div class="flex flex-wrap gap-3">
              <label
                v-for="cap in capabilityKeys"
                :key="cap"
                class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200"
              >
                <input v-model="form.capabilities[cap]" type="checkbox" />
                {{ cap }}
              </label>
            </div>
          </section>
        </div>

        <div
          class="flex shrink-0 items-center justify-end gap-2 border-t border-gray-200 px-4 py-3 dark:border-gray-700"
        >
          <button
            class="inline-flex h-10 items-center justify-center rounded-lg border border-gray-200 px-4 text-sm font-medium text-gray-600 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            type="button"
            @click="$emit('close')"
          >
            取消
          </button>
          <button
            class="btn btn-primary h-10 inline-flex items-center justify-center px-4 text-sm font-medium disabled:opacity-50"
            type="button"
            :disabled="saving"
            @click="handleSave"
          >
            <i :class="['mr-1', saving ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-save']" />
            保存
          </button>
        </div>
      </div>
    </div>
  </ModalTransition>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'

import ModalTransition from '@/components/common/modal_transition.vue'
import { createInternalModelApi, saveInternalModelApi } from '@/libs/http_apis.js'
import { isOk, msgOf } from '@/libs/http_envelope'
import { showToast } from '@/libs/tools.js'

const props = defineProps({
  show: { type: Boolean, default: false },
  model: { type: Object, default: null },
  isCreate: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'saved'])

const capabilityKeys = [
  'vision',
  'function_calling',
  'parallel_function_calling',
  'prompt_caching',
  'reasoning',
  'web_search',
  'response_schema',
  'system_messages',
  'tool_choice',
  'pdf_input',
  'assistant_prefill',
  'computer_use',
  'url_context',
  'video_input',
  'native_streaming',
  'service_tier'
]

const basePriceFields = [
  { key: 'input_per_million_tokens', label: '输入' },
  { key: 'output_per_million_tokens', label: '输出' },
  { key: 'cache_write_per_million_tokens', label: '缓存写 5m' },
  { key: 'cache_write_1h_per_million_tokens', label: '缓存写 1h' },
  { key: 'cache_read_per_million_tokens', label: '缓存读' },
  { key: 'reasoning_per_million_tokens', label: '推理输出' },
  { key: 'cache_hit_per_million_tokens', label: '缓存命中' },
  { key: 'cache_write_1h_above_200k_per_million_tokens', label: '1h 缓存写 >200k' },
  { key: 'fast_rate_multiplier', label: 'Fast 倍率（记录）', placeholder: '如 6' }
]

const tierLevelFields = [
  { key: 'input_per_million_tokens', label: '输入' },
  { key: 'output_per_million_tokens', label: '输出' },
  { key: 'cache_write_per_million_tokens', label: '缓存写 5m' },
  { key: 'cache_write_1h_per_million_tokens', label: '缓存写 1h' },
  { key: 'cache_read_per_million_tokens', label: '缓存读' }
]

const tierPriceFields = [
  { key: 'input_per_million_tokens', label: '输入 $/M' },
  { key: 'output_per_million_tokens', label: '输出 $/M' },
  { key: 'cache_write_per_million_tokens', label: '缓存写 5m' },
  { key: 'cache_write_1h_per_million_tokens', label: '缓存写 1h' },
  { key: 'cache_read_per_million_tokens', label: '缓存读' }
]

const multiPriceFields = [
  { key: 'audio_input_per_million_tokens', label: '音频输入 $/M' },
  { key: 'audio_output_per_million_tokens', label: '音频输出 $/M' },
  { key: 'audio_input_per_second', label: '音频输入 $/秒' },
  { key: 'audio_output_per_second', label: '音频输出 $/秒' },
  { key: 'audio_cache_write_per_million_tokens', label: '音频缓存写 $/M' },
  { key: 'audio_cache_read_per_million_tokens', label: '音频缓存读 $/M' },
  { key: 'image_input_per_image', label: '图片输入 $/张' },
  { key: 'image_output_per_image', label: '图片输出 $/张' },
  { key: 'image_input_per_million_tokens', label: '图片输入 $/M' },
  { key: 'image_output_per_million_tokens', label: '图片输出 $/M' },
  { key: 'image_input_per_pixel', label: '图片输入 $/像素' },
  { key: 'image_output_per_pixel', label: '图片输出 $/像素' },
  { key: 'image_cache_read_per_million_tokens', label: '图片缓存读 $/M' },
  { key: 'video_input_per_second', label: '视频输入 $/秒' },
  { key: 'video_output_per_second', label: '视频输出 $/秒' },
  { key: 'input_per_query', label: '按查询 $' },
  { key: 'input_per_request', label: '按请求 $' },
  { key: 'input_per_character', label: '输入 $/字符' },
  { key: 'output_per_character', label: '输出 $/字符' },
  { key: 'dbu_input_per_million_tokens', label: 'DBU 输入 $/M' },
  { key: 'dbu_output_per_million_tokens', label: 'DBU 输出 $/M' },
  { key: 'ocr_per_page', label: 'OCR $/页' },
  { key: 'low', label: '搜索上下文 low $', nested: true },
  { key: 'medium', label: '搜索上下文 medium $', nested: true },
  { key: 'high', label: '搜索上下文 high $', nested: true }
]

const emptyTier = () => ({
  threshold: 200000,
  input_per_million_tokens: '',
  output_per_million_tokens: '',
  cache_write_per_million_tokens: '',
  cache_write_1h_per_million_tokens: '',
  cache_read_per_million_tokens: ''
})

const emptyPricing = () => ({
  currency: 'USD',
  input_per_million_tokens: '',
  output_per_million_tokens: '',
  cache_write_per_million_tokens: '',
  cache_write_1h_per_million_tokens: '',
  cache_read_per_million_tokens: '',
  reasoning_per_million_tokens: '',
  price_tiers: [],
  priority_pricing: {
    input_per_million_tokens: '',
    output_per_million_tokens: '',
    cache_write_per_million_tokens: '',
    cache_write_1h_per_million_tokens: '',
    cache_read_per_million_tokens: '',
    price_tiers: []
  },
  flex_pricing: {
    input_per_million_tokens: '',
    output_per_million_tokens: '',
    cache_write_per_million_tokens: '',
    cache_write_1h_per_million_tokens: '',
    cache_read_per_million_tokens: '',
    price_tiers: []
  },
  audio_input_per_million_tokens: '',
  audio_output_per_million_tokens: '',
  audio_input_per_second: '',
  audio_output_per_second: '',
  audio_cache_write_per_million_tokens: '',
  audio_cache_read_per_million_tokens: '',
  image_input_per_image: '',
  image_output_per_image: '',
  image_input_per_million_tokens: '',
  image_output_per_million_tokens: '',
  image_input_per_pixel: '',
  image_output_per_pixel: '',
  image_cache_read_per_million_tokens: '',
  image_output_tiers: [],
  video_input_per_second: '',
  video_output_per_second: '',
  video_input_tiers: [],
  multimodal_tiers: [],
  fast_rate_multiplier: '',
  search_context_cost: { low: '', medium: '', high: '' },
  input_per_query: '',
  input_per_request: '',
  input_per_character: '',
  output_per_character: '',
  cache_hit_per_million_tokens: '',
  cache_write_1h_above_200k_per_million_tokens: '',
  dbu_input_per_million_tokens: '',
  dbu_output_per_million_tokens: '',
  ocr_per_page: ''
})

const form = reactive({
  name: '',
  provider: '',
  mode: 'chat',
  modelGroup: '',
  deprecationDate: '',
  maxInputTokens: null,
  maxOutputTokens: null,
  pricing: emptyPricing(),
  capabilities: {},
  // 种子完整元数据（supported_endpoints 等），加入内部时必须原样带回保存
  metadata: null
})

const saving = ref(false)

const addTier = (list) => {
  list.push(emptyTier())
}

const resetFromModel = () => {
  const source = props.model || {}
  const pricing = {
    ...emptyPricing(),
    ...(source.pricing || {})
  }
  pricing.priority_pricing = {
    ...emptyPricing().priority_pricing,
    ...(source.pricing?.priority_pricing || {})
  }
  pricing.flex_pricing = {
    ...emptyPricing().flex_pricing,
    ...(source.pricing?.flex_pricing || {})
  }
  pricing.search_context_cost = {
    low: '',
    medium: '',
    high: '',
    ...(source.pricing?.search_context_cost || {})
  }
  pricing.price_tiers = Array.isArray(source.pricing?.price_tiers)
    ? source.pricing.price_tiers.map((tier) => ({ ...emptyTier(), ...tier }))
    : []
  pricing.priority_pricing.price_tiers = Array.isArray(
    source.pricing?.priority_pricing?.price_tiers
  )
    ? source.pricing.priority_pricing.price_tiers.map((tier) => ({ ...emptyTier(), ...tier }))
    : []
  pricing.flex_pricing.price_tiers = Array.isArray(source.pricing?.flex_pricing?.price_tiers)
    ? source.pricing.flex_pricing.price_tiers.map((tier) => ({ ...emptyTier(), ...tier }))
    : []
  pricing.image_output_tiers = Array.isArray(source.pricing?.image_output_tiers)
    ? source.pricing.image_output_tiers.map((tier) => ({ ...tier }))
    : []
  pricing.video_input_tiers = Array.isArray(source.pricing?.video_input_tiers)
    ? source.pricing.video_input_tiers.map((tier) => ({ ...tier }))
    : []
  pricing.multimodal_tiers = Array.isArray(source.pricing?.multimodal_tiers)
    ? source.pricing.multimodal_tiers.map((tier) => ({ ...tier }))
    : []

  form.name = source.name || source.id || ''
  form.provider = source.provider || ''
  form.mode = source.mode || 'chat'
  form.modelGroup = source.modelGroup || ''
  form.deprecationDate = source.deprecationDate || ''
  form.maxInputTokens =
    source.maxInputTokens == null || source.maxInputTokens === ''
      ? null
      : Number(source.maxInputTokens)
  form.maxOutputTokens =
    source.maxOutputTokens == null || source.maxOutputTokens === ''
      ? null
      : Number(source.maxOutputTokens)
  form.pricing = pricing
  // 保留 from-seed / 已有内部模型的完整 metadata，禁止保存时丢光
  form.metadata =
    source.metadata && typeof source.metadata === 'object' ? source.metadata : null
  form.capabilities = { ...(source.capabilities || {}) }
  for (const key of capabilityKeys) {
    if (form.capabilities[key] == null) {
      form.capabilities[key] = false
    }
  }
}

watch(
  () => [props.show, props.model, props.isCreate],
  () => {
    if (props.show) {
      resetFromModel()
    }
  },
  { immediate: true }
)

const cleanEmpty = (value) => {
  if (value === '' || value === undefined) {
    return undefined
  }
  return value
}

const isPriceLikeKey = (key) =>
  key.includes('per_million') ||
  key.includes('per_second') ||
  key.includes('per_image') ||
  key.includes('per_pixel') ||
  key.includes('per_page') ||
  key.includes('per_query') ||
  key.includes('per_request') ||
  key.includes('per_character') ||
  key === 'fast_rate_multiplier' ||
  key === 'threshold' ||
  key === 'threshold_seconds' ||
  key === 'low' ||
  key === 'medium' ||
  key === 'high'

const cleanPricing = (pricing) => {
  const out = JSON.parse(JSON.stringify(pricing))
  const errors = []
  const cleanObj = (obj, path = 'pricing') => {
    if (!obj || typeof obj !== 'object') return obj
    if (Array.isArray(obj)) {
      return obj.map((item, i) => cleanObj(item, `${path}[${i}]`)).filter((item) => item != null)
    }
    const next = {}
    for (const [key, value] of Object.entries(obj)) {
      if (value === '' || value === null || value === undefined) continue
      if (typeof value === 'object') {
        const cleaned = cleanObj(value, `${path}.${key}`)
        if (
          cleaned == null ||
          (Array.isArray(cleaned) && cleaned.length === 0) ||
          (!Array.isArray(cleaned) && Object.keys(cleaned).length === 0)
        ) {
          continue
        }
        next[key] = cleaned
      } else if (isPriceLikeKey(key)) {
        const num = Number(value)
        if (!Number.isFinite(num) || num < 0) {
          errors.push(`${path}.${key}`)
          continue
        }
        next[key] = key === 'threshold' || key === 'threshold_seconds' ? num : String(value).trim()
      } else {
        next[key] = value
      }
    }
    return next
  }
  const cleaned = cleanObj(out) || {}
  if (errors.length) {
    throw new Error(`价格字段必须是非负数字: ${errors.slice(0, 6).join(', ')}`)
  }
  // 不默认补 0：空表单应被后端拒绝，避免内部价把种子覆盖成免费
  // threshold/condition/currency 是结构字段，不算单价
  const nonPriceKeys = new Set(['currency', 'condition', 'threshold', 'threshold_seconds', 'fast_rate_multiplier'])
  const hasPrice = (value, keyHint = '') => {
    if (value == null || value === '') return false
    if (nonPriceKeys.has(keyHint)) return false
    if (Array.isArray(value)) return value.some((item) => hasPrice(item))
    if (typeof value === 'object') {
      return Object.entries(value).some(([key, item]) => hasPrice(item, key))
    }
    const num = Number(value)
    return Number.isFinite(num) && num >= 0
  }
  // 丢掉只有 threshold 的空分段
  const pruneEmptyTiers = (obj) => {
    if (!obj || typeof obj !== 'object') return
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value) && (key.endsWith('_tiers') || key === 'price_tiers')) {
        obj[key] = value.filter((tier) => tier && hasPrice(tier))
        if (!obj[key].length) delete obj[key]
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        pruneEmptyTiers(value)
      }
    }
  }
  pruneEmptyTiers(cleaned)
  if (!hasPrice(cleaned)) {
    throw new Error('请至少填写一个有效单价字段（threshold / Fast 倍率不算单价）')
  }
  cleaned.currency = cleaned.currency || 'USD'
  return cleaned
}

const handleSave = async () => {
  if (!form.name?.trim()) {
    showToast('请填写模型名称', 'error')
    return
  }
  saving.value = true
  let pricing
  try {
    pricing = cleanPricing(form.pricing)
  } catch (error) {
    saving.value = false
    showToast(error.message || '价格字段校验失败', 'error')
    return
  }
  const payload = {
    name: form.name.trim(),
    provider: form.provider || 'imported',
    mode: form.mode || 'chat',
    modelGroup: cleanEmpty(form.modelGroup) || null,
    deprecationDate: cleanEmpty(form.deprecationDate) || null,
    maxInputTokens: form.maxInputTokens == null ? null : Number(form.maxInputTokens),
    maxOutputTokens: form.maxOutputTokens == null ? null : Number(form.maxOutputTokens),
    pricing,
    capabilities: { ...form.capabilities },
    // 整模保存：把 from-seed 带来的完整种子 metadata 一并落库
    metadata: form.metadata && typeof form.metadata === 'object' ? form.metadata : null
  }
  const result = props.isCreate
    ? await createInternalModelApi(payload)
    : await saveInternalModelApi(payload.name, payload)
  saving.value = false
  if (isOk(result)) {
    showToast('已保存内部计费模型', 'success')
    emit('saved', result.data)
    emit('close')
  } else {
    showToast(msgOf(result, '保存失败'), 'error')
  }
}
</script>
