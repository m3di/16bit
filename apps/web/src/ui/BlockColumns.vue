<script setup lang="ts">
import { computed, useSlots } from 'vue'
import { slotChildren } from './blocks.ts'

// The `columns` block: its children side by side, wrapping below each other when the page is too
// narrow (never a fixed width). `weights` share the width as the mockup's 3 to 2; `ruled` is the
// number row, hairlines above and below and no gap. Layout only, so no states of its own.
const {
  weights = [],
  min = null,
  ruled,
} = defineProps<{
  /** Flex grow per child, in order. Missing weights are 1. */
  weights?: number[]
  /** Width in px below which a child wraps. 380 by default, 150 when ruled. */
  min?: number | null
  ruled?: boolean
}>()

const slots = useSlots()
const children = computed(() => slotChildren(slots.default?.()))
const basis = computed(() => min ?? (ruled ? 150 : 380))
</script>

<template>
  <div
    :class="['flex min-w-0 flex-wrap', ruled ? 'border-y border-line' : 'items-start gap-9']"
    data-block="columns"
  >
    <div
      v-for="(child, i) in children"
      :key="child.key ?? i"
      class="min-w-0"
      :style="{ flex: `${String(weights[i] ?? 1)} 1 ${String(basis)}px` }"
    >
      <component :is="child" />
    </div>
  </div>
</template>
