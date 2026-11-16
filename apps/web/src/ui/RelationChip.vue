<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import type { RelationTarget, ValueStateName } from './value-types.ts'
import ValueState from './ValueState.vue'

const {
  target,
  to = null,
  state = 'ready',
} = defineProps<{
  target: RelationTarget | null | undefined
  /** Where the chip links. Without it the title is plain text. */
  to?: RouteLocationRaw | null
  state?: Exclude<ValueStateName, 'empty' | 'no-permission'> | 'ready'
}>()
</script>

<template>
  <ValueState v-if="state !== 'ready'" :state="state" />
  <ValueState v-else-if="!target" state="empty" />
  <!-- The item exists but the reader has no grant. Never a link, never its title (D45). -->
  <span v-else-if="target.access === 'none'" data-access="none">
    <ValueState state="no-permission" />
    <span class="sr-only">: a linked item you cannot see</span>
  </span>
  <span v-else class="inline-flex min-w-0 items-baseline gap-1.5" data-access="ok">
    <span v-if="target.displayId" class="shrink-0 font-mono text-secondary text-ink3">{{
      target.displayId
    }}</span>
    <RouterLink
      v-if="to"
      :to="to"
      class="truncate border-b border-line2 text-ink no-underline hover:border-line3"
      >{{ target.title }}</RouterLink
    >
    <span v-else class="truncate text-ink">{{ target.title }}</span>
  </span>
</template>
