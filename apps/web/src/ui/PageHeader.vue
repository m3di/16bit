<script setup lang="ts">
import type { LiveStatus } from './blocks.ts'
import StatusDot from './StatusDot.vue'

// The top of a root view (Main.dc.html): page title, an optional line under it, and the live dot
// on the right. The dot is the hub feed's connection state (D82), not data of its own.
const {
  title,
  description = '',
  live = null,
  loading,
} = defineProps<{
  title: string
  description?: string
  /** Leave unset where the page does not follow the feed. */
  live?: LiveStatus | null
  /** The title is not known yet: a skeleton in its place. */
  loading?: boolean
}>()
</script>

<template>
  <header class="flex flex-wrap items-end justify-between gap-3" data-block="page-header">
    <div class="flex max-w-[560px] min-w-0 flex-col gap-1.5">
      <div v-if="loading" role="status" aria-busy="true" class="py-1.5">
        <span class="sr-only">Loading</span>
        <span
          aria-hidden="true"
          class="block h-6 w-64 max-w-full animate-pulse rounded-chip bg-empty motion-reduce:animate-none"
        />
      </div>
      <h1 v-else class="m-0 font-display text-page-title font-medium tracking-[-0.01em] text-ink">
        {{ title }}
      </h1>
      <p v-if="description && !loading" class="m-0 text-ink2">{{ description }}</p>
      <slot />
    </div>
    <!-- Always in the page, so a change is announced; empty while there is nothing to say. -->
    <span v-if="live !== null" role="status" class="inline-flex" data-live>
      <StatusDot v-if="live === 'online'" tone="success" label="Live" />
      <StatusDot v-else-if="live === 'connecting'" label="Connecting" />
      <template v-else-if="live === 'offline'">
        <StatusDot tone="warning" label="Offline" />
        <span class="sr-only">Live updates are paused while the connection comes back.</span>
      </template>
      <template v-else-if="live === 'stopped'">
        <StatusDot tone="warning" label="Offline" />
        <span class="ml-1.5 text-secondary text-ink3"
          >Live updates stopped. Reload the page to see changes.</span
        >
      </template>
    </span>
  </header>
</template>
