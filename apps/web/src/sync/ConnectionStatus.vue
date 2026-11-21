<script setup lang="ts">
import { StatusDot } from '../ui/index.ts'
import type { FeedStatus } from './feed.ts'

// The live connection, shown only while it is down (D60). The live region stays in the page so
// that the change is announced; online it is empty.
defineProps<{ status: FeedStatus }>()
</script>

<template>
  <span role="status" class="inline-flex" data-connection>
    <template v-if="status === 'offline'">
      <StatusDot tone="warning" label="Offline" />
      <span class="sr-only">Live updates are paused while the connection comes back.</span>
    </template>
    <template v-else-if="status === 'stopped'">
      <StatusDot tone="warning" label="Offline" />
      <!-- Unlike a drop, this does not fix itself, so the way out is shown, not only read out. -->
      <span class="ml-1.5 text-secondary text-ink3" data-connection-stopped
        >Live updates stopped. Reload the page to see changes.</span
      >
    </template>
  </span>
</template>
