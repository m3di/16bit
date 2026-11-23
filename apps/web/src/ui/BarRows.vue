<script setup lang="ts">
import { barPercent, type BarRow, type DataBlockState } from './blocks.ts'
import ActorChip from './ActorChip.vue'
import BlockStatus from './BlockStatus.vue'

// Grouped numbers as thin bars (Main.dc.html). `stacked` is the release block: name and
// "11 of 12" on one line, a 4px bar under it, 14px apart. `inline` is the team block: avatar and
// name, a 60px bar and the number, 40px rows on hairlines. The bar is decoration; the text says
// the value, so the bar is never the only signal.
const {
  rows,
  layout = 'stacked',
  state = 'ready',
  stateTitle = '',
  stateMessage = null,
  emptyText = 'Nothing here yet',
  label = '',
} = defineProps<{
  rows: BarRow[]
  layout?: 'stacked' | 'inline'
  state?: DataBlockState
  stateTitle?: string
  stateMessage?: string | null
  emptyText?: string
  /** Names the list when no section heading is around it. */
  label?: string
}>()
</script>

<template>
  <BlockStatus
    v-if="state !== 'ready'"
    :state="state"
    :title="stateTitle"
    :message="stateMessage"
  />
  <BlockStatus v-else-if="rows.length === 0" state="empty" :title="emptyText" message="" />
  <ul
    v-else
    :aria-label="label || undefined"
    :class="['m-0 flex list-none flex-col p-0', layout === 'stacked' ? 'gap-3.5' : '']"
    data-block="bars"
    :data-layout="layout"
  >
    <li
      v-for="row in rows"
      :key="row.id"
      :class="
        layout === 'stacked'
          ? 'flex flex-col gap-1.5'
          : 'flex min-h-10 items-center gap-2.5 border-b border-line last:border-b-0'
      "
    >
      <template v-if="layout === 'stacked'">
        <span class="flex justify-between gap-3">
          <span class="min-w-0 truncate text-ink">{{ row.label }}</span>
          <span class="shrink-0 text-ink2"><span class="sr-only">: </span>{{ row.text }}</span>
        </span>
        <span aria-hidden="true" class="block h-1 bg-line">
          <span
            class="block h-1 bg-accent"
            :style="{ width: `${barPercent(row.value, row.max)}%` }"
          />
        </span>
      </template>
      <template v-else>
        <span class="min-w-0 flex-1">
          <ActorChip v-if="row.actor" :actor="row.actor" />
          <span v-else class="block truncate text-ink">{{ row.label }}</span>
        </span>
        <span aria-hidden="true" class="block h-1 w-[60px] shrink-0 bg-line">
          <span
            class="block h-1 bg-accent"
            :style="{ width: `${barPercent(row.value, row.max)}%` }"
          />
        </span>
        <span class="min-w-[18px] shrink-0 text-right text-ink tabular-nums"
          ><span class="sr-only">: </span>{{ row.text }}</span
        >
      </template>
    </li>
  </ul>
</template>
