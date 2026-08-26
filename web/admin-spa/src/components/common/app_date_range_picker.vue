<template>
  <div ref="rootRef" class="adr" :class="[`adr-${size}`, { 'is-disabled': disabled, 'is-open': open }]">
    <!-- 触发条：不使用原生 datetime-local -->
    <button
      class="adr-trigger"
      type="button"
      :disabled="disabled"
      @click="toggleOpen"
    >
      <i class="adr-icon i-lucide-calendar-heart" />
      <span class="adr-text" :class="{ 'is-placeholder': !hasValue }">
        <template v-if="hasValue">
          <span class="adr-part">{{ displayStart }}</span>
          <span class="adr-sep">至</span>
          <span class="adr-part">{{ displayEnd }}</span>
        </template>
        <template v-else>选择时间范围</template>
      </span>
      <button
        v-if="clearable && hasValue"
        class="adr-clear"
        title="清空"
        type="button"
        @click.stop="clear"
      >
        <i class="i-lucide-x" />
      </button>
      <i class="adr-caret i-lucide-chevron-down" />
    </button>

    <!-- 弹层 -->
    <div v-if="open" class="adr-panel" @click.stop>
      <div v-if="showPresets" class="adr-presets">
        <button
          v-for="preset in resolvedPresets"
          :key="preset.key"
          class="adr-chip"
          :class="{ 'is-active': activePreset === preset.key }"
          type="button"
          @click="applyPreset(preset.key)"
        >
          {{ preset.label }}
        </button>
      </div>

      <div class="adr-body">
        <!-- 日历 -->
        <div class="adr-cal">
          <div class="adr-cal-head">
            <button class="adr-nav" type="button" @click="shiftMonth(-1)">
              <i class="i-lucide-chevron-left" />
            </button>
            <div class="adr-month-label">{{ monthLabel }}</div>
            <button class="adr-nav" type="button" @click="shiftMonth(1)">
              <i class="i-lucide-chevron-right" />
            </button>
          </div>
          <div class="adr-week">
            <span v-for="w in weekLabels" :key="w">{{ w }}</span>
          </div>
          <div class="adr-days">
            <button
              v-for="cell in calendarCells"
              :key="cell.key"
              class="adr-day"
              :class="{
                'is-out': cell.out,
                'is-today': cell.isToday,
                'is-start': cell.isStart,
                'is-end': cell.isEnd,
                'is-in': cell.isIn,
                'is-disabled': cell.disabled
              }"
              type="button"
              :disabled="cell.disabled"
              @click="pickDay(cell)"
            >
              {{ cell.day }}
            </button>
          </div>
          <p class="adr-hint">
            {{ pickingEnd ? '再点结束日期' : '先点开始日期' }}
            <span v-if="draftStart && draftEnd"> · 已选区间</span>
          </p>
        </div>

        <!-- 时间 -->
        <div class="adr-times">
          <div class="adr-time-block">
            <div class="adr-time-title">开始时间</div>
            <div class="adr-time-row">
              <CustomDropdown
                v-model="startHour"
                class="adr-dd"
                :options="hourOptions"
                size="sm"
              />
              <span class="adr-colon">:</span>
              <CustomDropdown
                v-model="startMinute"
                class="adr-dd"
                :options="minuteOptions"
                size="sm"
              />
            </div>
            <div class="adr-time-preview">{{ draftStartPreview }}</div>
          </div>
          <div class="adr-time-block">
            <div class="adr-time-title">结束时间</div>
            <div class="adr-time-row">
              <CustomDropdown
                v-model="endHour"
                class="adr-dd"
                :options="hourOptions"
                size="sm"
              />
              <span class="adr-colon">:</span>
              <CustomDropdown
                v-model="endMinute"
                class="adr-dd"
                :options="minuteOptions"
                size="sm"
              />
            </div>
            <div class="adr-time-preview">{{ draftEndPreview }}</div>
          </div>
        </div>
      </div>

      <div class="adr-foot">
        <button class="adr-btn ghost" type="button" @click="open = false">取消</button>
        <button class="adr-btn primary" type="button" :disabled="!canApply" @click="applyDraft">
          确定
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CustomDropdown from '@/components/common/custom_dropdown.vue'
import dayjs from 'dayjs'
import {
  buildDateRangePreset,
  DEFAULT_DATE_RANGE_PRESETS,
  SIMPLE_DATE_RANGE_PRESETS,
  toStoreDateTime
} from '@/libs/time.js'

// modelValue: [start, end] 'YYYY-MM-DD HH:mm:ss' | null
const props = defineProps({
  modelValue: { type: [Array, null], default: null },
  clearable: { type: Boolean, default: true },
  disabled: { type: Boolean, default: false },
  // false | 'filter' | 'simple' | [{key,label}]
  presets: {
    type: [Boolean, String, Array],
    default: 'filter'
  },
  size: {
    type: String,
    default: 'md',
    validator: (value) => ['sm', 'md'].includes(value)
  },
  // 分钟步进：默认 1（精确到分）
  minuteStep: {
    type: Number,
    default: 1
  }
})

const emit = defineEmits(['update:modelValue', 'change'])

const rootRef = ref(null)
const open = ref(false)
const viewMonth = ref(dayjs().startOf('month'))
const draftStart = ref(null) // dayjs | null
const draftEnd = ref(null)
const pickingEnd = ref(false)
const startHour = ref(0)
const startMinute = ref(0)
const endHour = ref(23)
const endMinute = ref(59)

const weekLabels = ['一', '二', '三', '四', '五', '六', '日']
const pad = (n) => String(n).padStart(2, '0')
const hourOptions = Array.from({ length: 24 }, (_, h) => ({ value: h, label: pad(h) }))
const minuteOptions = computed(() => {
  const step = Math.max(1, Number(props.minuteStep) || 1)
  const list = []
  for (let m = 0; m < 60; m += step) list.push({ value: m, label: pad(m) })
  return list
})
const minuteValues = computed(() => minuteOptions.value.map((item) => item.value))

const resolvedPresets = computed(() => {
  if (props.presets === false || props.presets === 'none') return []
  if (Array.isArray(props.presets)) return props.presets
  if (props.presets === 'simple') return SIMPLE_DATE_RANGE_PRESETS
  return DEFAULT_DATE_RANGE_PRESETS
})
const showPresets = computed(() => resolvedPresets.value.length > 0)

const range = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : null))
const hasValue = computed(() => !!(range.value?.[0] || range.value?.[1]))

const displayStart = computed(() => {
  if (!range.value?.[0]) return '—'
  return dayjs(range.value[0]).isValid()
    ? dayjs(range.value[0]).format('YYYY-MM-DD HH:mm')
    : String(range.value[0])
})
const displayEnd = computed(() => {
  if (!range.value?.[1]) return '—'
  return dayjs(range.value[1]).isValid()
    ? dayjs(range.value[1]).format('YYYY-MM-DD HH:mm')
    : String(range.value[1])
})

const monthLabel = computed(() => viewMonth.value.format('YYYY年 M月'))

const snapMinute = (minute) => {
  const list = minuteValues.value
  if (list.includes(minute)) return minute
  let best = list[0]
  let bestDiff = Math.abs(minute - best)
  for (const m of list) {
    const d = Math.abs(minute - m)
    if (d < bestDiff) {
      best = m
      bestDiff = d
    }
  }
  return best
}

const syncDraftFromModel = () => {
  const start = range.value?.[0] ? dayjs(range.value[0]) : null
  const end = range.value?.[1] ? dayjs(range.value[1]) : null
  draftStart.value = start?.isValid() ? start : null
  draftEnd.value = end?.isValid() ? end : null
  pickingEnd.value = false
  if (draftStart.value) {
    startHour.value = draftStart.value.hour()
    startMinute.value = snapMinute(draftStart.value.minute())
    viewMonth.value = draftStart.value.startOf('month')
  } else {
    startHour.value = 0
    startMinute.value = 0
    viewMonth.value = dayjs().startOf('month')
  }
  if (draftEnd.value) {
    endHour.value = draftEnd.value.hour()
    endMinute.value = snapMinute(draftEnd.value.minute())
  } else {
    endHour.value = 23
    endMinute.value = minuteValues.value[minuteValues.value.length - 1]
  }
}

const composeStart = computed(() => {
  if (!draftStart.value) return null
  return draftStart.value
    .hour(startHour.value)
    .minute(startMinute.value)
    .second(0)
    .millisecond(0)
})
const composeEnd = computed(() => {
  if (!draftEnd.value) return null
  return draftEnd.value.hour(endHour.value).minute(endMinute.value).second(0).millisecond(0)
})

const draftStartPreview = computed(() =>
  composeStart.value ? composeStart.value.format('YYYY-MM-DD HH:mm') : '未选择'
)
const draftEndPreview = computed(() =>
  composeEnd.value ? composeEnd.value.format('YYYY-MM-DD HH:mm') : '未选择'
)

const canApply = computed(() => !!(composeStart.value && composeEnd.value))

const calendarCells = computed(() => {
  const start = viewMonth.value.startOf('month')
  // Monday-first
  const weekday = start.day() // 0 Sun
  const lead = weekday === 0 ? 6 : weekday - 1
  const gridStart = start.subtract(lead, 'day')
  const today = dayjs().startOf('day')
  const s = composeStart.value?.startOf('day')
  const e = composeEnd.value?.startOf('day')
  const cells = []
  for (let i = 0; i < 42; i++) {
    const date = gridStart.add(i, 'day')
    const dayStart = date.startOf('day')
    const out = date.month() !== viewMonth.value.month()
    let isIn = false
    if (s && e) {
      isIn = (dayStart.isAfter(s) && dayStart.isBefore(e)) || dayStart.isSame(s) || dayStart.isSame(e)
    }
    cells.push({
      key: date.format('YYYY-MM-DD'),
      day: date.date(),
      date,
      out,
      isToday: dayStart.isSame(today),
      isStart: !!(s && dayStart.isSame(s)),
      isEnd: !!(e && dayStart.isSame(e)),
      isIn,
      disabled: false
    })
  }
  return cells
})

const almostSame = (a, b, minutes = 2) => {
  if (!a || !b) return false
  const diff = Math.abs(dayjs(a).valueOf() - dayjs(b).valueOf())
  return Number.isFinite(diff) && diff < minutes * 60 * 1000
}

const activePreset = computed(() => {
  const current = range.value
  if (!current || (!current[0] && !current[1])) {
    return resolvedPresets.value.some((preset) => preset.key === 'all') ? 'all' : ''
  }
  if (!current[0] || !current[1]) return 'custom'
  for (const preset of resolvedPresets.value) {
    if (preset.key === 'all' || preset.key === 'custom') continue
    const built = buildDateRangePreset(preset.key)
    if (!built) continue
    if (almostSame(current[0], built[0]) && almostSame(current[1], built[1])) return preset.key
  }
  return 'custom'
})

const emitRange = (start, end) => {
  if (!start && !end) {
    emit('update:modelValue', null)
    emit('change', null)
    return
  }
  const next = [start || '', end || '']
  emit('update:modelValue', next)
  emit('change', next)
}

const applyDraft = () => {
  if (!composeStart.value || !composeEnd.value) return
  let start = composeStart.value
  let end = composeEnd.value
  if (end.isBefore(start)) {
    const tmp = start
    start = end
    end = tmp
  }
  emitRange(toStoreDateTime(start), toStoreDateTime(end))
  open.value = false
}

const clear = () => {
  emitRange('', '')
  draftStart.value = null
  draftEnd.value = null
  pickingEnd.value = false
}

const applyPreset = (key) => {
  if (key === 'all') {
    clear()
    open.value = false
    return
  }
  const built = buildDateRangePreset(key)
  if (!built) return
  emitRange(built[0], built[1])
  // 同步草稿，便于再微调
  const s = dayjs(built[0])
  const e = dayjs(built[1])
  draftStart.value = s
  draftEnd.value = e
  startHour.value = s.hour()
  startMinute.value = snapMinute(s.minute())
  endHour.value = e.hour()
  endMinute.value = snapMinute(e.minute())
  viewMonth.value = s.startOf('month')
  pickingEnd.value = false
  open.value = false
}

const pickDay = (cell) => {
  if (cell.disabled) return
  const day = cell.date.startOf('day')
  if (!pickingEnd.value || !draftStart.value) {
    draftStart.value = day
    draftEnd.value = null
    pickingEnd.value = true
    // 默认开始 00:00，结束 23:xx
    startHour.value = 0
    startMinute.value = 0
    endHour.value = 23
    endMinute.value = minuteValues.value[minuteValues.value.length - 1]
    return
  }
  // picking end
  if (day.isBefore(draftStart.value.startOf('day'))) {
    draftEnd.value = draftStart.value
    draftStart.value = day
  } else {
    draftEnd.value = day
  }
  pickingEnd.value = false
}

const shiftMonth = (delta) => {
  viewMonth.value = viewMonth.value.add(delta, 'month')
}

const toggleOpen = () => {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) syncDraftFromModel()
}

const onDocPointer = (event) => {
  if (!open.value) return
  const el = rootRef.value
  const target = event.target
  // CustomDropdown 面板 Teleport 到 body，点选项不属于本组件根节点，不能当外部点击关面板
  if (target && typeof target.closest === 'function') {
    if (target.closest('.cute-dropdown__panel')) return
  }
  if (el && !el.contains(target)) open.value = false
}

const onKey = (event) => {
  if (event.key === 'Escape') open.value = false
}

watch(
  () => props.modelValue,
  () => {
    if (open.value) syncDraftFromModel()
  },
  { deep: true }
)

onMounted(() => {
  document.addEventListener('mousedown', onDocPointer)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocPointer)
  document.removeEventListener('keydown', onKey)
})
</script>

<style scoped>
.adr {
  position: relative;
  display: inline-flex;
  width: auto;
  max-width: 100%;
  min-width: 0;
  height: auto;
  flex: 0 0 auto;
  flex-direction: column;
  align-self: center;
  vertical-align: middle;
}

.adr-trigger {
  display: flex;
  min-width: 12rem;
  width: 100%;
  max-width: 100%;
  align-items: center;
  gap: 0.4rem;
  height: 2rem;
  padding: 0 0.45rem 0 0.55rem;
  border: 1px solid rgb(229 231 235);
  border-radius: 0.75rem;
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.adr.is-open .adr-trigger,
.adr-trigger:hover {
  border-color: rgb(147 197 253);
  box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.15);
}

.adr-icon {
  flex-shrink: 0;
  width: 0.95rem;
  height: 0.95rem;
  color: #fb7185;
}

.adr-text {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 0.35rem;
  overflow: hidden;
  color: rgb(31 41 55);
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  text-align: left;
  white-space: nowrap;
}

.adr-text.is-placeholder {
  color: rgb(156 163 175);
}

.adr-part {
  overflow: hidden;
  text-overflow: ellipsis;
}

.adr-sep {
  flex-shrink: 0;
  color: rgb(156 163 175);
  font-size: 0.75rem;
}

.adr-clear,
.adr-caret {
  flex-shrink: 0;
  color: rgb(156 163 175);
}

.adr-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  border: 0;
  border-radius: 9999px;
  background: transparent;
  cursor: pointer;
}

.adr-clear:hover {
  background: rgb(243 244 246);
  color: rgb(75 85 99);
}

.adr-caret {
  width: 0.9rem;
  height: 0.9rem;
}

.adr-panel {
  position: absolute;
  top: calc(100% + 0.35rem);
  left: 0;
  z-index: 80;
  width: min(22rem, 92vw);
  padding: 0.65rem;
  border: 1px solid rgb(229 231 235);
  border-radius: 0.9rem;
  background: #fff;
  box-shadow:
    0 18px 40px -18px rgba(15, 23, 42, 0.35),
    0 0 0 1px rgba(255, 255, 255, 0.4) inset;
}

.adr-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-bottom: 0.55rem;
}

.adr-chip {
  height: 1.45rem;
  padding: 0 0.5rem;
  border: 1px solid rgb(229 231 235);
  border-radius: 9999px;
  background: rgb(249 250 251);
  color: rgb(75 85 99);
  font-size: 0.75rem;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

.adr-chip:hover {
  border-color: rgb(147 197 253);
  background: rgb(239 246 255);
  color: rgb(37 99 235);
}

.adr-chip.is-active {
  border-color: transparent;
  background: linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%);
  color: #fff;
  box-shadow: 0 2px 8px rgba(96, 165, 250, 0.35);
}

.adr-body {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.adr-cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.35rem;
}

.adr-month-label {
  color: rgb(31 41 55);
  font-size: 0.875rem;
  font-weight: 650;
}

.adr-nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  border: 0;
  border-radius: 0.5rem;
  background: rgb(249 250 251);
  color: rgb(75 85 99);
  cursor: pointer;
}

.adr-nav:hover {
  background: rgb(239 246 255);
  color: rgb(37 99 235);
}

.adr-week,
.adr-days {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 0.15rem;
}

.adr-week span {
  color: rgb(156 163 175);
  font-size: 0.7rem;
  font-weight: 600;
  text-align: center;
}

.adr-day {
  height: 1.85rem;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: rgb(55 65 81);
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.adr-day:hover:not(:disabled) {
  background: rgb(239 246 255);
  color: rgb(37 99 235);
}

.adr-day.is-out {
  color: rgb(203 213 225);
}

.adr-day.is-today {
  box-shadow: inset 0 0 0 1px rgb(147 197 253);
}

.adr-day.is-in {
  background: rgba(96, 165, 250, 0.15);
  color: rgb(29 78 216);
}

.adr-day.is-start,
.adr-day.is-end {
  background: linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%);
  color: #fff;
  font-weight: 700;
}

.adr-hint {
  margin: 0.35rem 0 0;
  color: rgb(148 163 184);
  font-size: 0.75rem;
}

.adr-times {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.45rem;
}

.adr-time-block {
  padding: 0.45rem 0.5rem;
  border: 1px solid rgb(243 244 246);
  border-radius: 0.65rem;
  background: rgb(249 250 251);
}

.adr-time-title {
  margin-bottom: 0.25rem;
  color: rgb(107 114 128);
  font-size: 0.75rem;
  font-weight: 600;
}


.adr-time-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 0.25rem;
}

.adr-dd {
  min-width: 0;
  width: 100%;
}

.adr-dd :deep(.cute-dropdown),
.adr-dd :deep(.cute-dropdown__trigger) {
  width: 100%;
}

.adr-dd :deep(.cd-sm .cute-dropdown__trigger),
.adr-dd :deep(.cute-dropdown.cd-sm .cute-dropdown__trigger) {
  height: 1.7rem;
  min-height: 1.7rem;
  padding: 0 0.4rem;
  font-size: 0.8125rem;
}

.adr-colon {
  color: rgb(156 163 175);
  font-weight: 700;
}

.adr-time-preview {
  margin-top: 0.25rem;
  color: rgb(100 116 139);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
}

.adr-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.4rem;
  margin-top: 0.55rem;
}

.adr-btn {
  height: 1.85rem;
  padding: 0 0.75rem;
  border: 0;
  border-radius: 0.55rem;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

.adr-btn.ghost {
  background: rgb(243 244 246);
  color: rgb(75 85 99);
}

.adr-btn.primary {
  background: linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%);
  color: #fff;
}

.adr-btn.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.adr-sm .adr-trigger {
  height: 1.75rem;
  border-radius: 0.65rem;
}

.adr-sm .adr-text {
  font-size: 0.75rem;
}

.is-disabled {
  opacity: 0.6;
  pointer-events: none;
}

:global(.dark) .adr-trigger {
  border-color: rgb(55 65 81);
  background: rgb(17 24 39);
  box-shadow: none;
}

:global(.dark) .adr-text {
  color: rgb(243 244 246);
}

:global(.dark) .adr-text.is-placeholder,
:global(.dark) .adr-sep,
:global(.dark) .adr-caret {
  color: rgb(148 163 184);
}

:global(.dark) .adr-panel {
  border-color: rgb(55 65 81);
  background: rgb(17 24 39);
  box-shadow: 0 18px 40px -12px rgba(0, 0, 0, 0.55);
}

:global(.dark) .adr-chip {
  border-color: rgb(55 65 81);
  background: rgb(31 41 55);
  color: rgb(209 213 219);
}

:global(.dark) .adr-chip.is-active {
  background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
  color: #fff;
}

:global(.dark) .adr-month-label,
:global(.dark) .adr-day {
  color: rgb(226 232 240);
}

:global(.dark) .adr-day.is-out {
  color: rgb(71 85 105);
}

:global(.dark) .adr-day.is-in {
  background: rgba(59, 130, 246, 0.2);
  color: rgb(147 197 253);
}

:global(.dark) .adr-nav,
:global(.dark) .adr-btn.ghost {
  background: rgb(31 41 55);
  color: rgb(203 213 225);
}

:global(.dark) .adr-time-block {
  border-color: rgb(55 65 81);
  background: rgb(31 41 55);
}

</style>
