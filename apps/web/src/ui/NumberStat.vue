<script setup lang="ts">
import { SHORT_STATE_TEXT, type DataBlockState } from './blocks.ts'

// The `number` block (Main.dc.html's sprint row): a 12px label, then the number in Space Grotesk
// 26px and an optional "of 34" at 14px. A state takes the number's place and keeps the label, so
// the row does not jump while it loads.
const {
  label,
  value = '',
  of = '',
  state = 'ready',
  stateText = '',
} = defineProps<{
  label: string
  /** Formatted by the renderer ("16", "1,280"). */
  value?: string | number
  /** The whole it is part of ("of 34", "day 6 of 10"). */
  of?: string | number
  state?: DataBlockState
  /** Overrides the short text for a state ("No current sprint"). */
  stateText?: string
}>()
</script>

<template>
  <div class="flex min-w-0 flex-col gap-0.5 py-3.5" data-block="number" :data-state="state">
    <span class="text-secondary text-ink3">{{ label }}</span>
    <span v-if="state === 'ready'" class="font-display text-number font-medium text-ink"
      >{{ value }}<span v-if="of !== ''" class="text-name text-ink3"> of {{ of }}</span></span
    >
    <!-- Same height as the number. Loading is not a live region: the page announces it. -->
    <span v-else-if="state === 'loading'" class="flex h-[38px] items-center">
      <span class="sr-only">Loading</span>
      <span
        aria-hidden="true"
        class="block h-5 w-14 animate-pulse rounded-chip bg-empty motion-reduce:animate-none"
      />
    </span>
    <span
      v-else
      :class="[
        'flex h-[38px] items-center gap-1.5 text-secondary',
        state === 'error' ? 'text-danger' : 'text-ink3',
      ]"
    >
      <span
        aria-hidden="true"
        :class="[
          'block size-1.5 shrink-0',
          {
            'bg-line2': state === 'empty',
            'bg-danger': state === 'error',
            'border border-dashed border-line3': state === 'no-permission',
            'border border-line3': state === 'not-found',
            'bg-warning': state === 'invalid',
            'border border-dotted border-line3': state === 'unresolved',
          },
        ]"
      />
      {{ stateText || SHORT_STATE_TEXT[state] }}
    </span>
  </div>
</template>
