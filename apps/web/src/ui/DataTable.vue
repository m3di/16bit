<script setup lang="ts" generic="Row extends { id: string }">
export interface TableColumn {
  key: string
  label: string
  /** Numbers read better right-aligned. */
  align?: 'start' | 'end'
}

const { selectedId = null } = defineProps<{
  /** Read by screen readers as the table's name. */
  caption: string
  columns: readonly TableColumn[]
  rows: readonly Row[]
  selectedId?: string | null
}>()

const emit = defineEmits<{ select: [row: Row] }>()

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
  <!-- Wide tables scroll inside their own box. -->
  <div class="min-w-0 overflow-x-auto">
    <table class="w-full border-collapse text-left">
      <caption class="sr-only">
        {{
          caption
        }}
      </caption>
      <thead>
        <tr class="border-b border-line">
          <th
            v-for="column in columns"
            :key="column.key"
            scope="col"
            class="h-9 px-2 text-secondary font-normal whitespace-nowrap text-ink3"
            :class="column.align === 'end' && 'text-right'"
          >
            {{ column.label }}
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
