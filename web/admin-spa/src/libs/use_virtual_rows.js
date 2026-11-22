import { computed, onBeforeUnmount, onMounted, ref, unref, watch } from 'vue'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/vue-virtual'

let nextScope = 0

// A logical row may contain several native tr elements. Measure their common
// tbody so expanded content participates in the same height and focus lifetime.
export const useVirtualRows = ({ rows, scroller, root = scroller, getRowKey, headerHeight = 0, estimateSize = () => 80, overscan = 2, activeKey = ref(null) }) => {
  const scope = `virtual-rows-${++nextScope}`
  const keys = computed(() => unref(rows).map(getRowKey))
  const indexes = computed(() => new Map(keys.value.map((key, index) => [key, index])))
  const domKeys = computed(() => new Map(keys.value.map(key => [`${typeof key}:${String(key)}`, key])))
  const virtualizer = useVirtualizer(computed(() => {
    const element = unref(scroller)
    const margin = unref(headerHeight)
    const activeIndex = indexes.value.get(activeKey.value)
    return {
      count: keys.value.length,
      getScrollElement: () => element,
      getItemKey: index => keys.value[index],
      estimateSize,
      overscan,
      scrollMargin: margin,
      scrollPaddingStart: margin,
      rangeExtractor: range => {
        const visible = defaultRangeExtractor(range)
        // Focus can precede a programmatic scroll in the same task, before
        // Vue flushes the changed options into the adapter.
        const focusedIndex = indexes.value.get(activeKey.value) ?? activeIndex
        return focusedIndex === undefined || visible.includes(focusedIndex) ? visible : [...visible, focusedIndex].sort((a, b) => a - b)
      },
    }
  }))
  const virtualRows = computed(() => {
    let previousEnd = unref(headerHeight)
    return virtualizer.value.getVirtualItems().map(item => {
      const gap = Math.max(0, item.start - previousEnd)
      previousEnd = item.end
      return { ...item, gap, domKey: `${typeof item.key}:${String(item.key)}` }
    })
  })
  const totalSize = computed(() => virtualizer.value.getTotalSize())
  const endGap = computed(() => {
    const last = virtualRows.value.at(-1)
    return Math.max(0, totalSize.value - (last ? last.end - unref(headerHeight) : 0))
  })
  const rowAttrs = item => ({ 'data-index': item.index, 'data-virtual-scope': scope, 'data-virtual-key': item.domKey })
  const measureElement = element => virtualizer.value.measureElement(element)
  const scrollToIndex = (index, options) => virtualizer.value.scrollToIndex(index, options)
  const scrollToOffset = (offset, options) => virtualizer.value.scrollToOffset(offset, options)
  const retainFocusedRow = event => {
    const row = event.target.closest?.(`[data-virtual-scope="${scope}"]`)
    activeKey.value = row ? domKeys.value.get(row.dataset.virtualKey) ?? null : null
  }
  // Root-local listeners avoid document work for every table on a page. A
  // teleported editor retains its originating row until the next table action.
  let listeningRoot
  const bindRoot = element => {
    if (element === listeningRoot) return
    listeningRoot?.removeEventListener('focusin', retainFocusedRow, true)
    listeningRoot?.removeEventListener('pointerdown', retainFocusedRow, true)
    listeningRoot = element
    element?.addEventListener('focusin', retainFocusedRow, true)
    element?.addEventListener('pointerdown', retainFocusedRow, true)
  }
  const stopRoot = watch(() => unref(root), bindRoot, { flush: 'post' })
  onMounted(() => bindRoot(unref(root)))
  watch(indexes, value => {
    if (activeKey.value !== null && !value.has(activeKey.value)) activeKey.value = null
  })
  onBeforeUnmount(() => {
    stopRoot()
    bindRoot(null)
  })
  return { virtualRows, endGap, totalSize, measureElement, rowAttrs, scrollToIndex, scrollToOffset, activeKey, virtualizer }
}
