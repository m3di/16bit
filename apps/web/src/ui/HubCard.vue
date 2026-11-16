<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { paletteVar, type PaletteColor } from './palette.ts'
import SizeMeter from './SizeMeter.vue'

const {
  name,
  color,
  count,
  to = null,
} = defineProps<{
  name: string
  color: PaletteColor
  /** The hub's item count. */
  count: number
  /** Where the card leads. Without it the card is not a link. */
  to?: RouteLocationRaw | null
}>()

const countLabel = computed(
  () => `${new Intl.NumberFormat('en').format(count)} ${count === 1 ? 'item' : 'items'}`,
)
</script>

<template>
  <component
    :is="to ? RouterLink : 'div'"
    :to="to ?? undefined"
    class="flex min-w-0 flex-col gap-3 rounded-card border border-line bg-bg px-4 py-3.5 text-ink no-underline"
    :class="to && 'hover:border-line2'"
    data-hub-card
  >
    <span class="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        class="size-2.5 shrink-0"
        :style="{ background: paletteVar(color) }"
      />
      <span class="truncate text-name font-medium">{{ name }}</span>
    </span>
    <span class="flex items-center gap-2 text-secondary text-ink3">
      <SizeMeter :count="count" :color="color" />
      {{ countLabel }}
    </span>
  </component>
</template>
