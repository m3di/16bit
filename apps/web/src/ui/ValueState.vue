<script setup lang="ts">
import { computed } from 'vue'

import type { ValueStateName } from './value-types.ts'

// D18 for a single value: the inline counterpart of StateBlock, sized for cells and fields.
// Loading is plain screen-reader text, not a live region: a table of loading cells would
// otherwise announce every cell. The surrounding StateBlock or page owns the announcement.

const { state, label = '' } = defineProps<{
  state: ValueStateName
  /** Overrides the default text for the state. For loading it is read by screen readers only. */
  label?: string
}>()

const defaults: Record<ValueStateName, string> = {
  loading: 'Loading',
  empty: 'Empty',
  error: 'Could not load',
  'no-permission': 'No access',
}
const text = computed(() => label || defaults[state])
</script>

<template>
  <span v-if="state === 'loading'" class="inline-flex min-h-5 items-center" data-state="loading">
    <span class="sr-only">{{ text }}</span>
    <span
      aria-hidden="true"
      class="block h-2.5 w-16 animate-pulse rounded-chip bg-empty motion-reduce:animate-none"
    />
  </span>
  <span
    v-else
    :data-state="state"
    :class="[
      'inline-flex min-h-5 items-center gap-1.5 text-secondary',
      state === 'error' ? 'text-danger' : 'text-ink3',
    ]"
  >
    <span
      v-if="state !== 'empty'"
      aria-hidden="true"
      :class="[
        'block size-1.5 shrink-0',
        state === 'error' ? 'bg-danger' : 'border border-line3 border-dashed',
      ]"
    />
    {{ text }}
  </span>
</template>
