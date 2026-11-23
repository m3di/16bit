<script setup lang="ts">
import type { FieldValue } from './blocks.ts'
import { paletteVar } from './palette.ts'

// One formatted value in a row, card or fields block. A select option's colour is a dot beside
// its name, never colour alone; an empty value is its configured empty text in --ink3.
const { value, tone = 'ink2' } = defineProps<{
  value: FieldValue
  /** The text colour of a value that is set. */
  tone?: 'ink' | 'ink2' | 'ink3'
}>()

const tones = { ink: 'text-ink', ink2: 'text-ink2', ink3: 'text-ink3' } as const
</script>

<template>
  <span
    :class="[
      'inline-flex min-w-0 items-center gap-1.5',
      value.mono && 'font-mono text-secondary',
      value.empty || value.mono ? 'text-ink3' : tones[tone],
    ]"
    :data-empty="value.empty ? '' : undefined"
  >
    <span
      v-if="value.color && !value.empty"
      aria-hidden="true"
      class="size-1.5 shrink-0 rounded-full"
      :style="{ background: paletteVar(value.color) }"
    />
    <span class="truncate">{{ value.text }}</span>
  </span>
</template>
