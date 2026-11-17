<script setup lang="ts">
import { computed } from 'vue'

/**
 * D18's four states, plus `not-found` for a 404. A 404 is kept apart from `empty` (the thing
 * exists and has nothing in it) and from `no-permission` (a 403). Hidden things answer 404
 * like missing ones (docs/ROLES.md), so not-found never claims the thing does not exist.
 */
export type BlockState = 'loading' | 'empty' | 'error' | 'no-permission' | 'not-found'

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

const titles: Record<BlockState, string> = {
  loading: 'Loading',
  empty: 'Nothing here yet',
  error: 'Something went wrong',
  'no-permission': 'You do not have access to this',
  'not-found': 'This could not be found',
}

const heading = computed(() => title || titles[state])

// The glyph is decorative: the title carries the meaning. Filled for empty, danger for error,
// dashed outline for no access (as in ValueState), solid outline for not found.
const glyphs: Record<Exclude<BlockState, 'loading'>, string> = {
  empty: 'bg-line2',
  error: 'bg-danger',
  'no-permission': 'border border-dashed border-line3',
  'not-found': 'border border-line3',
}
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
    <span aria-hidden="true" :class="['mb-2 block size-2.5', glyphs[state]]" />
    <p class="m-0 font-medium text-ink">{{ heading }}</p>
    <p v-if="message" class="m-0 max-w-sm text-secondary text-ink2">{{ message }}</p>
    <div v-if="$slots.action" class="mt-3"><slot name="action" /></div>
  </div>
</template>
