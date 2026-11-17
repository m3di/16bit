<script setup lang="ts">
import { computed } from 'vue'
import { chipsFor, type ChipOption } from './chips.ts'
import PaletteChip from './PaletteChip.vue'
import type { ValueStateName } from './value-types.ts'
import ValueState from './ValueState.vue'

const {
  value,
  options,
  limit = Infinity,
  removable,
  label,
  state = 'ready',
  inline,
} = defineProps<{
  /** Option IDs, as a multi-select stores them. */
  value: readonly string[]
  options: readonly ChipOption[]
  /** Show at most this many chips and a "+N" count for the rest, as in table cells. */
  limit?: number
  /** Each chip gets a remove button. Emits `remove` with the option ID. */
  removable?: boolean
  /** Accessible name of the list, usually the attribute name. */
  label: string
  /** Overrides the value. An empty value shows the empty state on its own. */
  state?: Exclude<ValueStateName, 'empty'> | 'ready'
  /**
   * One line that never wraps, for table cells. Long labels are cut with an ellipsis (the full
   * label is the chip's title) and the "+N" count always stays visible.
   */
  inline?: boolean
}>()

defineEmits<{ remove: [id: string] }>()

const view = computed(() => chipsFor(value, options, limit))
const hidden = computed(() =>
  chipsFor(value, options)
    .chips.slice(view.value.chips.length)
    .map((c) => c.label)
    .join(', '),
)
</script>

<template>
  <ValueState v-if="state !== 'ready'" :state="state" />
  <ValueState v-else-if="view.chips.length === 0 && view.overflow === 0" state="empty" />
  <ul
    v-else
    :aria-label="label"
    :class="[
      'm-0 inline-flex list-none items-center gap-1 p-0',
      inline ? 'max-w-full min-w-0 flex-nowrap whitespace-nowrap' : 'flex-wrap',
    ]"
    :data-inline="inline || undefined"
  >
    <li
      v-for="chip in view.chips"
      :key="chip.id"
      :class="['inline-flex', inline && 'min-w-0']"
      :title="inline ? chip.label : undefined"
    >
      <PaletteChip
        v-if="chip.color"
        :color="chip.color"
        :class="['min-h-5 gap-1', inline && 'min-w-0 max-w-full']"
      >
        <span :class="inline && 'truncate'">{{ chip.label }}</span>
        <button
          v-if="removable"
          type="button"
          :aria-label="`Remove ${chip.label}`"
          class="-mr-1 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent p-0 text-current hover:bg-bg"
          @click="$emit('remove', chip.id)"
        >
          <svg aria-hidden="true" focusable="false" viewBox="0 0 8 8" class="size-2">
            <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
      </PaletteChip>
      <span
        v-else
        :class="[
          'inline-flex min-h-5 items-center gap-1 rounded-chip border px-1.5 text-caption',
          chip.missing ? 'border-dashed border-line3 text-ink3' : 'border-line2 text-ink2',
          inline && 'min-w-0 max-w-full',
        ]"
      >
        <span :class="inline && 'truncate'">{{ chip.label }}</span>
        <button
          v-if="removable"
          type="button"
          :aria-label="`Remove ${chip.label}`"
          class="-mr-1 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent p-0 text-current hover:bg-selected"
          @click="$emit('remove', chip.id)"
        >
          <svg aria-hidden="true" focusable="false" viewBox="0 0 8 8" class="size-2">
            <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
      </span>
    </li>
    <li v-if="view.overflow > 0" class="inline-flex shrink-0">
      <span class="text-caption text-ink3" :title="hidden"
        >+{{ view.overflow }}<span class="sr-only"> more: {{ hidden }}</span></span
      >
    </li>
  </ul>
</template>
