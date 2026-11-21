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
      <span class="sr-only">Live updates have stopped. Reload the page to see changes.</span>
    </template>
  </span>
</template>
