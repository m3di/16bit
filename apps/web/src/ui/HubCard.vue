<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { paletteVar, type PaletteColor } from './palette.ts'
import SizeMeter from './SizeMeter.vue'

const {
  name,
  color,
  count = 0,
  to = null,
  noAccess,
} = defineProps<{
  name: string
  color: PaletteColor
  /** The hub's item count. Not shown without access. */
  count?: number
  /** Where the card leads. Without it, or without access, the card is not a link. */
  to?: RouteLocationRaw | null
  /**
   * The reader can see the hub's name but nothing inside it (owners and admins without a
   * grant, docs/ROLES.md). The card shows the name and "No access" only.
   */
  noAccess?: boolean
}>()

const link = computed(() => (noAccess ? null : to))

const countLabel = computed(
  () => `${new Intl.NumberFormat('en').format(count)} ${count === 1 ? 'item' : 'items'}`,
)
</script>

<template>
  <component
    :is="link ? RouterLink : 'div'"
    :to="link ?? undefined"
    class="flex min-w-0 flex-col gap-3 rounded-card border border-line bg-bg px-4 py-3.5 text-ink no-underline"
    :class="link && 'hover:border-line2'"
    data-hub-card
    :data-no-access="noAccess || undefined"
  >
    <span class="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        class="size-2.5 shrink-0"
        :style="{ background: paletteVar(color) }"
      />
      <span class="truncate text-name font-medium">{{ name }}</span>
    </span>
    <span v-if="noAccess" class="flex items-center gap-2 text-secondary text-ink3">
      <!-- Dashed outline, as for no permission in StateBlock and ValueState. -->
      <span aria-hidden="true" class="size-1.5 shrink-0 border border-dashed border-line3" />
      No access
    </span>
    <span v-else class="flex items-center gap-2 text-secondary text-ink3">
      <SizeMeter :count="count" :color="color" />
      {{ countLabel }}
    </span>
  </component>
</template>
