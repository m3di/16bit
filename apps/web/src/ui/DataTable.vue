<script setup lang="ts" generic="Row extends { id: string }">
import { useVirtualizer } from '@tanstack/vue-virtual'
import { computed, nextTick, onUpdated, ref, watch, type ComponentPublicInstance } from 'vue'
import {
  DEFAULT_WINDOW_SIZE,
  VIRTUAL_HEADER_HEIGHT,
  VIRTUAL_OVERSCAN,
  VIRTUAL_ROW_HEIGHT,
  rowKeyIndex,
  sameWindows,
  windowOffsets,
  type RowWindows,
} from './data-table.ts'
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
  /**
   * A fixed width (any CSS length), such as `96px` for IDs. Virtual tables lay columns out from
   * the header so they do not jump while scrolling; columns without a width share what is left.
   */
  width?: string
}

/**
 * `select`: a click on a row selects it (a list of items beside a panel).
 * `static`: rows are never selected, for settings lists whose rows hold their own controls.
 * `virtual`: `select` for large lists. Only the rows in view are rendered, 38px each, inside a
 * scroll box sized by `rowCount`; rows not loaded yet are placeholders.
 */
export type TableMode = 'select' | 'static' | 'virtual'

const {
  rows,
  mode = 'select',
  selectedId = null,
  busy,
  minWidth = 0,
  rowAttrs = () => ({}),
  rowCount = 0,
  rowAt = null,
  windowSize = DEFAULT_WINDOW_SIZE,
  height = 480,
} = defineProps<{
  /** Read by screen readers as the table's name. */
  caption: string
  columns: readonly TableColumn[]
  /**
   * The rows, in order. In `virtual` mode it may have holes, rows not loaded yet, or be `[]`
   * with `rowAt` reading rows from a store.
   */
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
  /** `virtual`: how many rows there are in all. It sizes the scrollbar. */
  rowCount?: number
  /** `virtual`: the row at an index, or undefined while it is not loaded. Defaults to `rows`. */
  rowAt?: ((index: number) => Row | undefined) | null
  /** `virtual`: rows per window in the `windows` event (D61: 200). */
  windowSize?: number
  /** `virtual`: the scroll box's height, in px or any CSS length (such as `100%`). */
  height?: number | string
}>()

const emit = defineEmits<{
  select: [row: Row]
  sort: [key: string]
  /** `virtual`: the windows holding the rows in view changed. Load the ones not loaded yet. */
  windows: [windows: RowWindows]
}>()

defineSlots<{ cell(props: { row: Row; column: TableColumn }): unknown }>()

// A click anywhere on a row selects it. Controls inside the row keep their own behaviour, and
// keyboard users reach the row through the link the first cell should hold.
const inControl = (event: MouseEvent) => {
  const target = event.target as Element | null
  return (
    typeof target?.closest === 'function' && !!target.closest('a, button, input, select, label')
  )
}

function onRowClick(event: MouseEvent, row: Row) {
  if (!inControl(event)) emit('select', row)
}

const selects = computed(() => mode !== 'static')
const virtual = computed(() => mode === 'virtual')

// Virtual mode. The header is sticky inside the scroll box, so rows start below it
// (`scrollMargin`) and a row scrolled into view lands below it, not under it
// (`scrollPaddingStart`).
const box = ref<HTMLDivElement | null>(null)
const boxHeight = computed(() => (typeof height === 'number' ? `${String(height)}px` : height))
const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>(
  computed(() => ({
    count: virtual.value ? rowCount : 0,
    enabled: virtual.value,
    getScrollElement: () => box.value,
    estimateSize: () => VIRTUAL_ROW_HEIGHT,
    overscan: VIRTUAL_OVERSCAN,
    scrollMargin: VIRTUAL_HEADER_HEIGHT,
    scrollPaddingStart: VIRTUAL_HEADER_HEIGHT,
    // Before the box is measured (and in server rendering), assume it has its stated height.
    initialRect: { width: 0, height: typeof height === 'number' ? height : 480 },
  })),
)
const items = computed(() => (virtual.value ? virtualizer.value.getVirtualItems() : []))
const rowOf = (index: number): Row | undefined => (rowAt ? rowAt(index) : rows[index])

/** In `virtual` mode, the rows in view, loaded or not. Keyed by index, so a placeholder keeps
 * its element (and focus) when its row arrives. */
const bodyRows = computed(() =>
  items.value.map((item) => ({ index: item.index, row: rowOf(item.index) })),
)
// Spacers above and below the rendered rows keep the scroll height at `rowCount` rows.
const spaceAbove = computed(() => {
  const first = items.value[0]
  return first ? first.start - VIRTUAL_HEADER_HEIGHT : 0
})
const spaceBelow = computed(() => {
  const last = items.value[items.value.length - 1]
  return last ? virtualizer.value.getTotalSize() - (last.end - VIRTUAL_HEADER_HEIGHT) : 0
})

// Ask for the windows in view whenever they change, starting with the first render.
let lastWindows: RowWindows | null = null
watch(
  () => {
    const first = items.value[0]
    const last = items.value[items.value.length - 1]
    if (!first || !last) return null
    const start = first.index
    const end = last.index + 1
    return { start, end, offsets: windowOffsets(start, end, windowSize) }
  },
  (windows) => {
    if (!windows || sameWindows(lastWindows, windows)) return
    lastWindows = windows
    emit('windows', windows)
  },
  { immediate: true },
)

// Keyboard selection. The active row is the one the keys move from: the last clicked or moved
// to, or the selected row when it is in view. It holds the tab stop, so the table is one stop.
const active = ref(-1)
watch(
  () =>
    selectedId === null ? -1 : (bodyRows.value.find((r) => r.row?.id === selectedId)?.index ?? -1),
  (index) => {
    if (index >= 0) active.value = index
  },
  { immediate: true },
)
const tabStop = computed(() => {
  if (bodyRows.value.some((r) => r.index === active.value)) return active.value
  return bodyRows.value[0]?.index ?? -1
})

const rowEls = new Map<number, HTMLTableRowElement>()
function setRowEl(index: number, el: Element | ComponentPublicInstance | null) {
  if (el) rowEls.set(index, el as HTMLTableRowElement)
  else rowEls.delete(index)
}

// A row moved to may not be rendered or loaded yet: focus it once it renders, and select it
// once it loads.
const focusPending = ref(-1)
const selectPending = ref(-1)
function focusIfRendered() {
  const el = rowEls.get(focusPending.value)
  if (focusPending.value < 0 || !el) return
  focusPending.value = -1
  el.focus({ preventScroll: true })
}
onUpdated(focusIfRendered)
watch(
  () => (selectPending.value >= 0 ? rowOf(selectPending.value) : undefined),
  (row) => {
    if (!row) return
    selectPending.value = -1
    emit('select', row)
  },
)

/** How many rows fit in the box, for Page Up and Page Down. */
const pageRows = () => {
  const size = virtualizer.value.scrollRect?.height ?? (typeof height === 'number' ? height : 480)
  return Math.max(1, Math.floor((size - VIRTUAL_HEADER_HEIGHT) / VIRTUAL_ROW_HEIGHT) - 1)
}

function moveTo(index: number) {
  active.value = index
  virtualizer.value.scrollToIndex(index, { align: 'auto' })
  focusPending.value = index
  void nextTick(focusIfRendered)
  const row = rowOf(index)
  if (row) {
    selectPending.value = -1
    emit('select', row)
  } else selectPending.value = index
}

function onRowKeydown(event: KeyboardEvent, index: number) {
  // Keys pressed in a control inside the row (the ID link) stay with that control.
  if (event.target !== event.currentTarget) return
  const next = rowKeyIndex(index, event.key, rowCount, pageRows())
  if (next === null) return
  event.preventDefault()
  // Up on the first row and Down on the last stay put.
  if (next !== index) moveTo(next)
}

function onVirtualRowClick(event: MouseEvent, index: number, row: Row | undefined) {
  if (inControl(event)) return
  // A click wins over a keyboard move still waiting for its row to load or render.
  selectPending.value = -1
  focusPending.value = -1
  active.value = index
  if (row) emit('select', row)
}

defineExpose({
  /** Scrolls a row into view, as when the selected row moves after a change (D61). */
  scrollToIndex: (index: number) => {
    virtualizer.value.scrollToIndex(index, { align: 'auto' })
  },
  /** The windows last asked for, to load again after the screen drops its rows. */
  windows: () => lastWindows,
})
</script>

<template>
  <!-- Wide tables scroll inside their own box. `relative` keeps absolutely placed screen-reader
       text in cells (links' "opens in a new tab") inside the box, not widening the page. A
       virtual table also scrolls down inside it, under a sticky header. -->
  <div
    ref="box"
    class="relative min-w-0"
    :class="virtual ? 'overflow-auto overscroll-contain' : 'overflow-x-auto'"
    :style="virtual ? { height: boxHeight } : undefined"
    :data-virtual="virtual ? '' : undefined"
  >
    <!-- Virtual rows have a fixed height, so borders sit on the cells (separate borders) where
         they count inside the 38px, and the layout is fixed so columns do not jump. -->
    <table
      class="w-full text-left"
      :class="virtual ? 'table-fixed border-separate border-spacing-0' : 'border-collapse'"
      :style="minWidth ? { minWidth: `${minWidth}px` } : undefined"
      :aria-busy="busy ? 'true' : undefined"
      :aria-rowcount="virtual ? rowCount + 1 : undefined"
      :data-mode="mode"
    >
      <caption class="sr-only">
        {{
          caption
        }}<template v-if="columns.some((c) => c.sort)"
          >, column headers with buttons are sortable</template
        ><template v-if="virtual">, arrow keys on a row move the selection</template>
      </caption>
      <thead>
        <tr :class="!virtual && 'border-b border-line'" :aria-rowindex="virtual ? 1 : undefined">
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
              virtual && 'sticky top-0 z-[1] border-b border-line bg-bg',
              column.align === 'end' ? 'text-right' : 'text-left',
              column.shrink && 'w-px',
            ]"
            :style="column.width ? { width: column.width } : undefined"
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
      <tbody v-if="virtual">
        <tr v-if="spaceAbove > 0" aria-hidden="true" data-spacer="above">
          <td :colspan="columns.length" class="p-0" :style="{ height: `${spaceAbove}px` }" />
        </tr>
        <tr
          v-for="{ index, row } in bodyRows"
          :key="index"
          :ref="(el) => setRowEl(index, el)"
          v-bind="row ? rowAttrs(row) : {}"
          class="-outline-offset-2"
          :class="
            row
              ? [
                  'cursor-pointer hover:bg-surface',
                  row.id === selectedId && 'bg-selected hover:bg-selected',
                ]
              : 'text-ink3'
          "
          :tabindex="index === tabStop ? 0 : -1"
          :aria-rowindex="index + 2"
          :aria-selected="row && row.id === selectedId ? 'true' : undefined"
          :aria-busy="row ? undefined : 'true'"
          :data-row="row ? '' : undefined"
          :data-placeholder="row ? undefined : ''"
          :data-index="index"
          @click="onVirtualRowClick($event, index, row)"
          @keydown="onRowKeydown($event, index)"
        >
          <component
            :is="column.rowHeader ? 'th' : 'td'"
            v-for="(column, c) in columns"
            :key="column.key"
            :scope="column.rowHeader ? 'row' : undefined"
            class="h-[38px] truncate border-b border-line px-2 font-normal"
            :class="column.align === 'end' ? 'text-right tabular-nums' : 'text-left'"
          >
            <slot v-if="row" name="cell" :row="row" :column="column" />
            <!-- A row not loaded yet: a quiet bar per cell, and one word for screen readers.
                 Not a live region; the block that loads announces it. -->
            <template v-else>
              <span v-if="c === 0" class="sr-only">Loading</span>
              <span
                aria-hidden="true"
                class="inline-block h-2.5 w-3/5 max-w-24 animate-pulse rounded-chip bg-empty align-middle motion-reduce:animate-none"
              />
            </template>
          </component>
        </tr>
        <tr v-if="spaceBelow > 0" aria-hidden="true" data-spacer="below">
          <td :colspan="columns.length" class="p-0" :style="{ height: `${spaceBelow}px` }" />
        </tr>
      </tbody>
      <tbody v-else>
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
