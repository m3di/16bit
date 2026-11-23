<script setup lang="ts">
import { computed } from 'vue'
import type { BlockStateName } from './blocks.ts'

/** The states, defined in blocks.ts with their reasons. */
export type BlockState = BlockStateName

const {
  state,
  title = '',
  message = '',
  rows = 3,
  compact,
} = defineProps<{
  state: BlockState
  /** Overrides the default title for the state. Not shown while loading. */
  title?: string
  message?: string
  /** Skeleton rows while loading. */
  rows?: number
  /** A block inside a page: left-aligned and short, glyph beside the text. */
  compact?: boolean
}>()

const titles: Record<BlockState, string> = {
  loading: 'Loading',
  empty: 'Nothing here yet',
  error: 'Something went wrong',
  'no-permission': 'You do not have access to this',
  'not-found': 'This could not be found',
  invalid: 'This block needs fixing',
  unresolved: 'Nothing to show yet',
}

const heading = computed(() => title || titles[state])

// The glyph is decorative: the title carries the meaning. Filled for empty, danger for error,
// dashed outline for no access (as in ValueState), solid outline for not found, a warning fill
// for invalid (someone has to fix it), dotted outline for unresolved (waiting on something).
const glyphs: Record<Exclude<BlockState, 'loading'>, string> = {
  empty: 'bg-line2',
  error: 'bg-danger',
  'no-permission': 'border border-dashed border-line3',
  'not-found': 'border border-line3',
  invalid: 'bg-warning',
  unresolved: 'border border-dotted border-line3',
}
</script>

<template>
  <!-- Compact blocks share a page with up to 20 others (D77): they are busy but not live regions,
    and their errors are not alerts. The renderer announces one page-level message instead. -->
  <div
    v-if="state === 'loading'"
    :role="compact ? undefined : 'status'"
    aria-busy="true"
    :class="['flex flex-col', compact ? 'gap-2.5 py-1' : 'gap-3 py-2']"
  >
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
    v-else-if="compact"
    class="flex flex-wrap items-start gap-x-2.5 gap-y-2 py-2"
    :data-state="state"
  >
    <span aria-hidden="true" :class="['mt-1.5 block size-2 shrink-0', glyphs[state]]" />
    <span class="flex min-w-0 flex-1 basis-48 flex-col">
      <span class="text-ink">{{ heading }}</span>
      <span v-if="message" class="text-secondary text-ink3">{{ message }}</span>
    </span>
    <span v-if="$slots.action" class="shrink-0"><slot name="action" /></span>
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
