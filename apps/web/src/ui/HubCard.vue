<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { paletteVar, type PaletteColor } from './palette.ts'
import SizeMeter from './SizeMeter.vue'

interface Common {
  name: string
  color: PaletteColor
}

/** A hub the reader can open. */
interface Granted extends Common {
  /** The hub's item count. */
  count: number
  /** Where the card leads. Without it the card is not a link. */
  to?: RouteLocationRaw | null
  noAccess?: false
}

/**
 * The reader can see the hub's name but nothing inside it (owners and admins without a grant,
 * docs/ROLES.md). The card shows the name and "No access" only, so it takes no count and no link.
 */
interface NoAccess extends Common {
  noAccess: true
  count?: never
  to?: never
}

const props = defineProps<Granted | NoAccess>()

const link = computed(() => (props.noAccess ? null : (props.to ?? null)))

const countLabel = computed(() => {
  const count = props.count ?? 0
  return `${new Intl.NumberFormat('en').format(count)} ${count === 1 ? 'item' : 'items'}`
})
</script>

<template>
  <component
    :is="link ? RouterLink : 'div'"
    :to="link ?? undefined"
    class="flex min-w-0 flex-col gap-3 rounded-card border border-line bg-bg px-4 py-3.5 text-ink no-underline"
    :class="link && 'hover:border-line2'"
    data-hub-card
    :data-no-access="props.noAccess || undefined"
  >
    <span class="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        class="size-2.5 shrink-0"
        :style="{ background: paletteVar(props.color) }"
      />
      <span class="truncate text-name font-medium">{{ props.name }}</span>
    </span>
    <span v-if="props.noAccess" class="flex items-center gap-2 text-secondary text-ink3">
      <!-- Dashed outline, as for no permission in StateBlock and ValueState. -->
      <span aria-hidden="true" class="size-1.5 shrink-0 border border-dashed border-line3" />
      No access
    </span>
    <span v-else class="flex items-center gap-2 text-secondary text-ink3">
      <SizeMeter :count="props.count ?? 0" :color="props.color" />
      {{ countLabel }}
    </span>
  </component>
</template>
