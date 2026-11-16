<script setup lang="ts">
import { computed } from 'vue'

export type BlockState = 'loading' | 'empty' | 'error' | 'no-permission'

const {
  state,
  title = '',
  message = '',
  rows = 3,
} = defineProps<{
  state: BlockState
  /** Overrides the default title for the state. Not shown while loading. */
  title?: string
  message?: string
  /** Skeleton rows while loading. */
  rows?: number
}>()

const defaults: Record<BlockState, string> = {
  loading: 'Loading',
  empty: 'Nothing here yet',
  error: 'Something went wrong',
  'no-permission': 'You do not have access to this',
}

const heading = computed(() => title || defaults[state])
</script>

<template>
  <div v-if="state === 'loading'" role="status" aria-busy="true" class="flex flex-col gap-3 py-2">
    <span class="sr-only">{{ heading }}</span>
    <span
      v-for="n in rows"
      :key="n"
      aria-hidden="true"
      class="block h-3 animate-pulse rounded-chip bg-empty motion-reduce:animate-none"
      :style="{ width: `${String(100 - ((n * 17) % 45))}%` }"
    />
  </div>
  <div
    v-else
    :role="state === 'error' ? 'alert' : undefined"
    class="flex flex-col items-center gap-1 px-4 py-10 text-center"
    :data-state="state"
  >
    <span
      aria-hidden="true"
      :class="['mb-2 block size-2.5', state === 'error' ? 'bg-danger' : 'bg-line2']"
    />
    <p class="m-0 font-medium text-ink">{{ heading }}</p>
    <p v-if="message" class="m-0 max-w-sm text-secondary text-ink2">{{ message }}</p>
    <div v-if="$slots.action" class="mt-3"><slot name="action" /></div>
  </div>
</template>
