<template>
  <template v-for="item in virtualRows" :key="item.domKey">
    <tbody v-if="item.gap > 0" aria-hidden="true" class="virtual-table-gap">
      <tr><td :colspan="columnCount" :style="{ height: `${item.gap}px` }"></td></tr>
    </tbody>
    <tbody
      :ref="measureElement"
      v-bind="{ ...$attrs, ...rowAttrs(item) }"
      :data-row-parity="item.index % 2"
    >
      <slot :index="item.index" :row="rows[item.index]" />
    </tbody>
  </template>
  <tbody v-if="endGap > 0" aria-hidden="true" class="virtual-table-gap">
    <tr><td :colspan="columnCount" :style="{ height: `${endGap}px` }"></td></tr>
  </tbody>
</template>

<script setup>
import { inject } from 'vue'

defineOptions({ inheritAttrs: false })
const { virtualRows, endGap, rowAttrs, measureElement, rows, columnCount } = inject('crs.virtual.table')
</script>
