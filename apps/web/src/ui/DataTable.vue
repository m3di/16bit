<script setup lang="ts" generic="Row extends { id: string }">
import { computed } from 'vue'
import SortIcon from './SortIcon.vue'

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
  /** Its cells name their rows (`th scope="row"`), such as a person's name. One per table. */
  rowHeader?: boolean
  /** The header is read by screen readers only, as over a column of row menus. */
  labelHidden?: boolean
  /**
   * Cells are never cut short: for controls (selects, buttons, row menus), whose focus ring a
   * cut would clip, and for text that must be read whole, such as a reason. Other cells are cut
   * with an ellipsis at 320px.
   */
  wrap?: boolean
  /** The column is as narrow as its cells allow and does not wrap, as a column of row menus. */
  shrink?: boolean
}

/**
 * `select`: a click on a row selects it (a list of items beside a panel).
 * `static`: rows are never selected, for settings lists whose rows hold their own controls.
 */
export type TableMode = 'select' | 'static'

const {
  mode = 'select',
  selectedId = null,
  busy,
  minWidth = 0,
  rowAttrs = () => ({}),
} = defineProps<{
  /** Read by screen readers as the table's name. */
  caption: string
  columns: readonly TableColumn[]
  rows: readonly Row[]
  mode?: TableMode
  /** The selected row. Ignored in `static` mode. */
  selectedId?: string | null
  /** The rows are being replaced, for example by a new sort. */
  busy?: boolean
  /** Below this width (px) the table scrolls inside its own box instead of squeezing. 0 for none. */
  minWidth?: number
  /** Attributes for a row's `tr`, such as `data-*` hooks. */
  rowAttrs?: (row: Row) => Record<string, string | boolean | undefined>
}>()

const emit = defineEmits<{ select: [row: Row]; sort: [key: string] }>()

defineSlots<{ cell(props: { row: Row; column: TableColumn }): unknown }>()

// A click anywhere on a row selects it. Controls inside the row keep their own behaviour, and
// keyboard users reach the row through the link the first cell should hold.
function onRowClick(event: MouseEvent, row: Row) {
  if (event.target instanceof Element && event.target.closest('a, button, input, select, label'))
    return
  emit('select', row)
}

const selects = computed(() => mode === 'select')
</script>

<template>
  <!-- Wide tables scroll inside their own box. `relative` keeps absolutely placed screen-reader
       text in cells (links' "opens in a new tab") inside the box, not widening the page. -->
  <div class="relative min-w-0 overflow-x-auto">
    <table
      class="w-full border-collapse text-left"
      :style="minWidth ? { minWidth: `${minWidth}px` } : undefined"
      :aria-busy="busy ? 'true' : undefined"
      :data-mode="mode"
    >
      <caption class="sr-only">
        {{
          caption
        }}<template v-if="columns.some((c) => c.sort)"
          >, column headers with buttons are sortable</template
        >
      </caption>
      <thead>
        <tr class="border-b border-line">
          <!-- Static rows sit flush with the section heading, as in the settings mockups: no
               leading padding and a 12px gap after each cell. Selectable rows keep 8px on both
               sides, so the selected fill does not touch the text. -->
          <th
            v-for="column in columns"
            :key="column.key"
            scope="col"
            class="font-normal whitespace-nowrap text-ink3"
            :class="[
              selects ? 'h-9 px-2 text-secondary' : 'h-8 pr-3 text-caption last:pr-0',
              column.align === 'end' ? 'text-right' : 'text-left',
              column.shrink && 'w-px',
            ]"
            :aria-sort="column.sort && column.sort !== 'none' ? column.sort : undefined"
            :data-sort="column.sort"
          >
            <span v-if="column.labelHidden" class="sr-only">{{ column.label }}</span>
            <!-- In a right-aligned column the sort icon leads, so the label lines up with the
                 numbers' right edge. Elsewhere it follows the label. -->
            <button
              v-else-if="column.sort"
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-control hover:text-ink"
              :class="column.sort !== 'none' && 'font-medium text-ink'"
              @click="emit('sort', column.key)"
            >
              <SortIcon v-if="column.align === 'end'" :sort="column.sort" />
              {{ column.label }}
              <SortIcon v-if="column.align !== 'end'" :sort="column.sort" />
            </button>
            <template v-else>{{ column.label }}</template>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          v-bind="rowAttrs(row)"
          class="border-b border-line"
          :class="
            selects && [
              'cursor-pointer hover:bg-surface',
              row.id === selectedId && 'bg-selected hover:bg-selected',
            ]
          "
          :aria-selected="selects && row.id === selectedId ? 'true' : undefined"
          data-row
          v-on="selects ? { click: (event: MouseEvent) => onRowClick(event, row) } : {}"
        >
          <component
            :is="column.rowHeader ? 'th' : 'td'"
            v-for="column in columns"
            :key="column.key"
            :scope="column.rowHeader ? 'row' : undefined"
            class="font-normal"
            :class="[
              selects ? 'h-9 px-2' : 'h-[38px] pr-3 last:pr-0',
              column.align === 'end' ? 'text-right tabular-nums' : 'text-left',
              column.shrink ? 'w-px whitespace-nowrap' : !column.wrap && 'max-w-80 truncate',
            ]"
          >
            <slot name="cell" :row="row" :column="column" />
          </component>
        </tr>
      </tbody>
    </table>
  </div>
</template>
