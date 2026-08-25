<template>
  <span class="app-tooltip group relative inline-flex max-w-full items-center">
    <slot />
    <span
      v-if="hasTip"
      :class="[
        'pointer-events-none absolute z-[80] hidden rounded-md bg-gray-900 px-2 py-1 text-sm text-white opacity-0 shadow-lg transition group-hover:block group-hover:opacity-100 dark:bg-gray-700',
        rich ? 'max-w-xs whitespace-normal text-left' : 'whitespace-nowrap',
        placementClass
      ]"
      role="tooltip"
    >
      <slot v-if="$slots.content" name="content" />
      <template v-else>{{ content }}</template>
    </span>
  </span>
</template>

<script setup>
import { computed, useSlots } from 'vue'

const props = defineProps({
  content: { type: String, default: '' },
  placement: { type: String, default: 'top' }
})

const slots = useSlots()
const hasTip = computed(() => !!props.content || !!slots.content)
const rich = computed(() => !!slots.content)

const placementClass = computed(() => {
  switch (props.placement) {
    case 'bottom':
      return 'left-1/2 top-full mt-1.5 -translate-x-1/2'
    case 'left':
      return 'right-full top-1/2 mr-1.5 -translate-y-1/2'
    case 'right':
      return 'left-full top-1/2 ml-1.5 -translate-y-1/2'
    case 'top':
    default:
      return 'bottom-full left-1/2 mb-1.5 -translate-x-1/2'
  }
})
</script>
