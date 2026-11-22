<template>
  <div
    ref="scroller"
    class="virtual-table-scroll virtual-table-watermarked"
    :class="{ 'virtual-table-fill': fillHeight, 'virtual-table-mobile-fill': mobileFill }"
    :style="viewportStyle"
  >
    <slot />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, provide, ref, watch } from 'vue'
import { useVirtualRows } from '@/libs/use_virtual_rows.js'
import { measureTableAvailableHeight, tableViewportAncestors } from '@/libs/table_viewport.js'
import '@/assets/styles/virtual_table.css'

const props = defineProps({
  rows: { type: Array, required: true },
  rowKey: { type: [String, Function], default: 'id' },
  maxHeight: { type: String, default: '24rem' },
  fillHeight: { type: Boolean, default: false },
  mobileFill: { type: Boolean, default: false },
  estimateSize: { type: Number, default: 72 }
})
const scroller = ref(null)
const headerHeight = ref(0)
const columnCount = ref(1)
const availableHeight = ref(null)
const rows = computed(() => props.rows)
const getRowKey = (row, index) =>
  typeof props.rowKey === 'function' ? props.rowKey(row, index) : (row[props.rowKey] ?? index)
const virtual = useVirtualRows({
  rows,
  scroller,
  getRowKey,
  headerHeight,
  estimateSize: () => props.estimateSize
})
provide('crs.virtual.table', { ...virtual, rows, columnCount })

const viewportStyle = computed(() => {
  const cap = props.maxHeight
  const height = availableHeight.value === null ? cap : `${availableHeight.value}px`
  return {
    maxHeight: props.fillHeight ? height : availableHeight.value === null ? cap : `min(${cap}, ${availableHeight.value}px)`,
    ...(props.fillHeight ? { height } : {})
  }
})
let observer
let frame = 0
let header
let signature = ''
let widths = []
const originalMinWidths = new WeakMap()
const measureLayout = () => {
  frame = 0
  const table = scroller.value?.querySelector(':scope > table')
  if (!table || !table.getBoundingClientRect().width) return
  availableHeight.value = window.innerWidth < 768 && props.mobileFill ? null : measureTableAvailableHeight(scroller.value, 24)
  const nextHeader = table.tHead
  if (nextHeader !== header) {
    if (header) observer?.unobserve(header)
    header = nextHeader
    if (header) observer?.observe(header)
  }
  headerHeight.value = header?.getBoundingClientRect().height ?? 0
  const cells = [...(header?.rows[header.rows.length - 1]?.cells ?? [])]
  columnCount.value = cells.reduce((count, cell) => count + cell.colSpan, 0) || 1
  const nextSignature = cells.map((cell) => {
    if (!originalMinWidths.has(cell)) originalMinWidths.set(cell, cell.style.minWidth)
    const style = getComputedStyle(cell)
    return [cell.textContent, style.font, style.padding, style.letterSpacing].join(':')
  }).join('\u0000')
  if (signature !== nextSignature) {
    signature = nextSignature
    widths = []
    cells.forEach((cell) => { cell.style.minWidth = originalMinWidths.get(cell) })
  }
  for (const cell of table.querySelectorAll('tbody:not([aria-hidden]) td')) {
    if (/\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}/.test(cell.textContent)) {
      cell.style.whiteSpace = 'nowrap'
    }
    for (const group of cell.querySelectorAll('.flex, .inline-flex, .admin-action-row')) {
      const buttons = [...group.children].filter((child) => child.matches('button'))
      if (buttons.length < 3) continue
      const buttonWidths = buttons.map((button) => button.getBoundingClientRect().width).sort((a, b) => b - a)
      const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0
      group.dataset.virtualActions = ''
      group.style.minWidth = `${Math.ceil(buttonWidths.slice(0, 3).reduce((sum, width) => sum + width, gap * 2))}px`
    }
  }
  cells.forEach((cell, index) => {
    widths[index] = Math.max(Math.ceil(cell.getBoundingClientRect().width), widths[index] ?? 0)
    const style = getComputedStyle(cell)
    const extra = style.boxSizing === 'border-box' ? 0 :
      ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce(
        (sum, property) => sum + (Number.parseFloat(style[property]) || 0), 0
      )
    const minWidth = `${Math.max(0, widths[index] - extra)}px`
    if (cell.style.minWidth !== minWidth) cell.style.minWidth = minWidth
  })
}
const scheduleLayout = () => {
  if (!frame) frame = requestAnimationFrame(measureLayout)
}
watch([virtual.virtualRows, () => props.rows], () => { void nextTick(scheduleLayout) }, { flush: 'post' })
onMounted(() => {
  observer = new ResizeObserver(scheduleLayout)
  observer.observe(scroller.value)
  for (const ancestor of tableViewportAncestors(scroller.value)) {
    observer.observe(ancestor)
    for (const sibling of ancestor.children) {
      if (!sibling.contains(scroller.value)) observer.observe(sibling)
    }
  }
  window.addEventListener('resize', scheduleLayout)
  scheduleLayout()
})
onUpdated(scheduleLayout)
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', scheduleLayout)
  cancelAnimationFrame(frame)
})
defineExpose({ scrollToIndex: virtual.scrollToIndex, scrollToOffset: virtual.scrollToOffset })
</script>
