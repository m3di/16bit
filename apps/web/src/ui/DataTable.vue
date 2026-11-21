<script setup lang="ts" generic="Row extends { id: string }">
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/vue-virtual'
import {
  computed,
  nextTick,
  onBeforeUpdate,
  onUpdated,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue'
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
  indexOf = null,
  windowSize = DEFAULT_WINDOW_SIZE,
  height = 480,
} = defineProps<{
  /** Read by screen readers as the table's name. */
  caption: string
  columns: readonly TableColumn[]
  /** The rows, in order. In `virtual` mode pass `[]`: rows come from `rowAt`. */
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
  /** `virtual`: the row at an index, or undefined while it is not loaded. */
  rowAt?: ((index: number) => Row | undefined) | null
  /**
   * `virtual`: the row an item is at, or -1 when it is not loaded. The active row is followed by
   * its ID through it, so focus stays on its item when rows are added or removed above it.
   */
  indexOf?: ((id: string) => number) | null
  /** `virtual`: rows per window in the `windows` event (D61: 200). */
  windowSize?: number
  /** `virtual`: the scroll box's height, in px or any CSS length (such as `100%`). */
  height?: number | string
}>()

const emit = defineEmits<{
  /** A row was selected, by a click or by the arrow keys (`virtual`), which keep focus. */
  select: [row: Row, via: 'pointer' | 'keyboard']
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
  if (!inControl(event)) emit('select', row, 'pointer')
}

const selects = computed(() => mode !== 'static')
const virtual = computed(() => mode === 'virtual')

// Virtual mode. The header is sticky inside the scroll box, so rows start below it
// (`scrollMargin`) and a row scrolled into view lands below it, not under it
// (`scrollPaddingStart`).
const box = ref<HTMLDivElement | null>(null)

// Keyboard selection. The active row is the one the keys move from: the last clicked, focused
// or moved to, or the selected row when it is in view. It holds the tab stop, so the table is
// one stop, and it stays rendered when scrolled out of view, so a wheel or scrollbar scroll
// never drops the focus it may hold.
const activeAt = ref(-1)
/** The active row's item, once loaded: rows added or removed above it move it (D61). */
const activeId = ref<string | null>(null)
function setActive(index: number) {
  activeAt.value = index
  activeId.value = rowAt?.(index)?.id ?? null
}
/** The active row's index now, following its item when it is known. */
const active = computed(() => {
  const id = activeId.value
  const at = id !== null && indexOf ? indexOf(id) : -1
  return at >= 0 ? at : activeAt.value
})
/** The active row, when the range in view does not include it. */
let kept = -1
function keepActive(range: Range, index: number): number[] {
  const indexes = defaultRangeExtractor(range)
  kept = -1
  if (index < 0 || index >= range.count || indexes.length === 0 || indexes.includes(index))
    return indexes
  kept = index
  return index < (indexes[0] ?? 0) ? [index, ...indexes] : [...indexes, index]
}

const boxHeight = computed(() => (typeof height === 'number' ? `${String(height)}px` : height))
const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>(
  computed(() => {
    // Read here, so the rows rendered follow the active row when it moves.
    const keep = active.value
    return {
      count: virtual.value ? rowCount : 0,
      enabled: virtual.value,
      getScrollElement: () => box.value,
      estimateSize: () => VIRTUAL_ROW_HEIGHT,
      overscan: VIRTUAL_OVERSCAN,
      scrollMargin: VIRTUAL_HEADER_HEIGHT,
      scrollPaddingStart: VIRTUAL_HEADER_HEIGHT,
      rangeExtractor: (range: Range) => keepActive(range, keep),
      // Before the box is measured (and in server rendering), assume it has its stated height.
      initialRect: { width: 0, height: typeof height === 'number' ? height : 480 },
    }
  }),
)
const items = computed(() => (virtual.value ? virtualizer.value.getVirtualItems() : []))
const rowOf = (index: number): Row | undefined => rowAt?.(index)

/** In `virtual` mode, the rows in view, loaded or not. */
const bodyRows = computed(() =>
  items.value.map((item) => ({ index: item.index, row: rowOf(item.index) })),
)
type Segment =
  | { kind: 'row'; key: string; index: number; row: Row | undefined }
  | { kind: 'gap'; key: string; at: 'above' | 'between' | 'below'; height: number }
// The rendered rows, with spacers above, below, and around a kept active row, so the scroll
// height stays at `rowCount` rows and each row sits where it belongs.
const segments = computed(() => {
  const out: Segment[] = []
  let cursor = 0
  for (const [i, item] of items.value.entries()) {
    const start = item.start - VIRTUAL_HEADER_HEIGHT
    if (start > cursor) {
      const at = out.length === 0 ? 'above' : 'between'
      out.push({ kind: 'gap', key: `gap-${at}`, at, height: start - cursor })
    }
    // A loaded row is keyed by its ID, so when a row is added or removed above it (D61) its
    // element moves with it, focus and pointer included, instead of showing another item. A
    // placeholder is keyed by its index.
    const row = bodyRows.value[i]?.row
    const key = row ? `row:${row.id}` : `index:${String(item.index)}`
    out.push({ kind: 'row', key, index: item.index, row })
    cursor = item.end - VIRTUAL_HEADER_HEIGHT
  }
  const rest = virtualizer.value.getTotalSize() - cursor
  if (out.length > 0 && rest > 0)
    out.push({ kind: 'gap', key: 'gap-below', at: 'below', height: rest })
  return out
})

// Ask for the windows in view whenever they change, starting with the first render. A kept
// active row out of view is left out: its window was loaded when it was selected.
let lastWindows: RowWindows | null = null
watch(
  () => {
    const inView = items.value.filter((item) => item.index !== kept)
    const first = inView[0]
    const last = inView[inView.length - 1]
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

watch(
  () =>
    selectedId === null ? -1 : (bodyRows.value.find((r) => r.row?.id === selectedId)?.index ?? -1),
  (index) => {
    if (index >= 0) setActive(index)
  },
  { immediate: true },
)
const tabStop = computed(() => {
  if (bodyRows.value.some((r) => r.index === active.value)) return active.value
  return bodyRows.value[0]?.index ?? -1
})

// Row elements by key: a row's element can leave and another arrive at the same index in one
// update, in either order.
const rowElsByKey = new Map<string, HTMLTableRowElement>()
function setRowEl(key: string, el: Element | ComponentPublicInstance | null) {
  if (el) rowElsByKey.set(key, el as HTMLTableRowElement)
  else rowElsByKey.delete(key)
}
/** The element of the row rendered at an index. */
const rowEls = {
  get(index: number): HTMLTableRowElement | undefined {
    const segment = segments.value.find((s) => s.kind === 'row' && s.index === index)
    return segment ? rowElsByKey.get(segment.key) : undefined
  },
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
// A focused placeholder is replaced by a new element when its row arrives: focus goes to the
// row that took its place, so a keyboard move to a row not loaded yet keeps focus.
/** The row that holds focus, from its focusin and focusout: its index and its key. */
let focused: { index: number; key: string } | null = null
let replaced: { index: number; el: HTMLTableRowElement } | null = null
onBeforeUpdate(() => {
  // Read by key: the segments already describe the coming render.
  const el = focused ? rowElsByKey.get(focused.key) : undefined
  replaced = focused && el && focused.key.startsWith('index:') ? { index: focused.index, el } : null
})
onUpdated(() => {
  const el = replaced ? rowEls.get(replaced.index) : undefined
  if (replaced && el && el !== replaced.el) el.focus({ preventScroll: true })
  replaced = null
  focusIfRendered()
})
watch(
  () => (selectPending.value >= 0 ? rowOf(selectPending.value) : undefined),
  (row) => {
    if (!row) return
    selectPending.value = -1
    emit('select', row, 'keyboard')
  },
)

/** How many rows fit in the box, for Page Up and Page Down. */
const pageRows = () => {
  const size = virtualizer.value.scrollRect?.height ?? (typeof height === 'number' ? height : 480)
  return Math.max(1, Math.floor((size - VIRTUAL_HEADER_HEIGHT) / VIRTUAL_ROW_HEIGHT) - 1)
}

function moveTo(index: number) {
  setActive(index)
  virtualizer.value.scrollToIndex(index, { align: 'auto' })
  focusPending.value = index
  void nextTick(focusIfRendered)
  const row = rowOf(index)
  if (row) {
    selectPending.value = -1
    emit('select', row, 'keyboard')
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

/** Focus reached a row (Tab, or its ID link): it becomes the active row, and stays rendered. */
function onRowFocus(index: number, key: string) {
  setActive(index)
  focused = { index, key }
}
function onRowBlur(key: string) {
  if (focused?.key === key) focused = null
}

function onVirtualRowClick(event: MouseEvent, index: number, row: Row | undefined) {
  if (inControl(event)) return
  // A click wins over a keyboard move still waiting for its row to load or render.
  selectPending.value = -1
  focusPending.value = -1
  setActive(index)
  if (row) emit('select', row, 'pointer')
}

defineExpose({
  /** Scrolls a row into view, as when the selected row moves after a change (D61). */
  scrollToIndex: (index: number) => {
    virtualizer.value.scrollToIndex(index, { align: 'auto' })
  },
  /** Whether a row is in the visible part of the box, not counting rows rendered around it. */
  isInView: (index: number) => {
    const range = virtualizer.value.range
    return !!range && index >= range.startIndex && index <= range.endIndex
  },
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
        <template v-for="segment in segments" :key="segment.key">
          <tr v-if="segment.kind === 'gap'" aria-hidden="true" :data-spacer="segment.at">
            <td :colspan="columns.length" class="p-0" :style="{ height: `${segment.height}px` }" />
          </tr>
          <tr
            v-else
            :ref="(el) => setRowEl(segment.key, el)"
            v-bind="segment.row ? rowAttrs(segment.row) : {}"
            class="-outline-offset-2"
            :class="
              segment.row
                ? [
                    'cursor-pointer hover:bg-surface',
                    segment.row.id === selectedId && 'bg-selected hover:bg-selected',
                  ]
                : 'text-ink3'
            "
            :tabindex="segment.index === tabStop ? 0 : -1"
            :aria-rowindex="segment.index + 2"
            :aria-selected="segment.row && segment.row.id === selectedId ? 'true' : undefined"
            :aria-busy="segment.row ? undefined : 'true'"
            :data-row="segment.row ? '' : undefined"
            :data-placeholder="segment.row ? undefined : ''"
            :data-index="segment.index"
            @click="onVirtualRowClick($event, segment.index, segment.row)"
            @keydown="onRowKeydown($event, segment.index)"
            @focusin="onRowFocus(segment.index, segment.key)"
            @focusout="onRowBlur(segment.key)"
          >
            <component
              :is="column.rowHeader ? 'th' : 'td'"
              v-for="(column, c) in columns"
              :key="column.key"
              :scope="column.rowHeader ? 'row' : undefined"
              class="h-[38px] truncate border-b border-line px-2 font-normal"
              :class="column.align === 'end' ? 'text-right tabular-nums' : 'text-left'"
            >
              <slot v-if="segment.row" name="cell" :row="segment.row" :column="column" />
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
        </template>
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
