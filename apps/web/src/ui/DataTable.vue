<script setup lang="ts" generic="Row extends { id: string }">
export interface TableColumn {
  key: string
  label: string
  /** Numbers read better right-aligned. */
  align?: 'start' | 'end'
  /**
   * Set on a column that can be sorted: its header becomes a button that emits `sort`.
   * `none` is sortable but not sorted. Leave it out for a column that cannot be sorted.
   */
  sort?: 'ascending' | 'descending' | 'none'
}

const { selectedId = null, busy } = defineProps<{
  /** Read by screen readers as the table's name. */
  caption: string
  columns: readonly TableColumn[]
  rows: readonly Row[]
  selectedId?: string | null
  /** The rows are being replaced, for example by a new sort. */
  busy?: boolean
}>()

const emit = defineEmits<{ select: [row: Row]; sort: [key: string] }>()

// Sortable headers carry a cue at rest: two chevrons in the header's --ink3 mark a sortable
// column, and a sorted one shows a single centred chevron for its direction, in --ink. The icon
// keeps one width in every state, so the label never moves. aria-sort carries the state for
// screen readers.

defineSlots<{ cell(props: { row: Row; column: TableColumn }): unknown }>()

// A click anywhere on a row selects it. Controls inside the row keep their own behaviour, and
// keyboard users reach the row through the link the first cell should hold.
function onRowClick(event: MouseEvent, row: Row) {
  if (event.target instanceof Element && event.target.closest('a, button, input, select, label'))
    return
  emit('select', row)
}
</script>

<template>
  <!-- Wide tables scroll inside their own box. `relative` keeps absolutely placed screen-reader
       text in cells (links' "opens in a new tab") inside the box, not widening the page. -->
  <div class="relative min-w-0 overflow-x-auto">
    <table class="w-full border-collapse text-left" :aria-busy="busy ? 'true' : undefined">
      <caption class="sr-only">
        {{
          caption
        }}<template v-if="columns.some((c) => c.sort)"
          >, column headers with buttons are sortable</template
        >
      </caption>
      <thead>
        <tr class="border-b border-line">
          <th
            v-for="column in columns"
            :key="column.key"
            scope="col"
            class="h-9 px-2 text-secondary font-normal whitespace-nowrap text-ink3"
            :class="column.align === 'end' && 'text-right'"
            :aria-sort="column.sort && column.sort !== 'none' ? column.sort : undefined"
            :data-sort="column.sort"
          >
            <button
              v-if="column.sort"
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-control hover:text-ink"
              :class="column.sort !== 'none' && 'font-medium text-ink'"
              @click="emit('sort', column.key)"
            >
              {{ column.label }}
              <svg
                aria-hidden="true"
                viewBox="0 0 10 14"
                width="10"
                height="14"
                fill="none"
                stroke="currentColor"
                stroke-width="1"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="shrink-0"
                :data-sort-icon="column.sort"
              >
                <path v-if="column.sort === 'none'" d="M2 5.5 5 2.5l3 3" data-chevron="up" />
                <path v-if="column.sort === 'none'" d="M2 8.5 5 11.5l3-3" data-chevron="down" />
                <path v-if="column.sort === 'ascending'" d="M2 8.5 5 5.5l3 3" data-chevron="up" />
                <path
                  v-if="column.sort === 'descending'"
                  d="M2 5.5 5 8.5l3-3"
                  data-chevron="down"
                />
              </svg>
            </button>
            <template v-else>{{ column.label }}</template>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          class="cursor-pointer border-b border-line hover:bg-surface"
          :class="row.id === selectedId && 'bg-selected hover:bg-selected'"
          :aria-selected="row.id === selectedId ? 'true' : undefined"
          data-row
          @click="onRowClick($event, row)"
        >
          <td
            v-for="column in columns"
            :key="column.key"
            class="h-9 max-w-80 truncate px-2"
            :class="column.align === 'end' && 'text-right tabular-nums'"
          >
            <slot name="cell" :row="row" :column="column" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
