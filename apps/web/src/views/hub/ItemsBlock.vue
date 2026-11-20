<script setup lang="ts">
import type { FolderAttributeDefinition, Item } from '@16bit/core'
import { computed, ref, watch } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import type { RowWindows } from '../../ui/data-table.ts'
import { BaseButton, DataTable, StateBlock, type TableColumn } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import { WINDOW_SIZE } from './folder-rows.ts'
import {
  canSort,
  followSelected,
  nextSort,
  type ItemList,
  type Reorder,
  type SortKey,
} from './useItems.ts'
import ValueCell from './ValueCell.vue'

const {
  folderName,
  list,
  rowAt,
  indexOf,
  reordered = null,
  columns,
  idPrefix,
  selectedId = null,
  itemLink,
  isCreating = () => false,
  readOnly,
  sort = null,
} = defineProps<{
  folderName: string
  list: Load<ItemList>
  /** The item at a row, or undefined while its window is not loaded (D61). */
  rowAt: (index: number) => Item | undefined
  /** The row an item is at, or -1 when it is not loaded. */
  indexOf: (id: string) => number
  /** The last time the rows in view were read again after a change. */
  reordered?: Reorder | null
  columns: readonly FolderAttributeDefinition[]
  idPrefix: string
  selectedId?: string | null
  /** Where a row's ID links: the same page with the item panel open. */
  itemLink: (item: Item) => RouteLocationRaw
  isCreating?: (id: string) => boolean
  /** The server refused a write in this hub: no "New item" action. */
  readOnly?: boolean
  /** The order asked for. Columns of indexed, sortable attributes can change it. */
  sort?: SortKey | null
}>()

const emit = defineEmits<{
  open: [item: Item]
  retry: []
  create: []
  sort: [sort: SortKey | null]
  /** The rows in view and the windows that hold them; load the ones missing. */
  windows: [windows: RowWindows]
  /** Read the windows that failed again. */
  retryWindows: []
}>()

const ariaSort = (attributeId: string): 'ascending' | 'descending' | 'none' => {
  if (sort?.attribute !== attributeId) return 'none'
  return sort.direction === 'asc' ? 'ascending' : 'descending'
}

// Virtual rows lay columns out from the header (fixed layout): the ID and numbers are narrow,
// the rest share what is left.
const tableColumns = computed<TableColumn[]>(() => [
  { key: '#id', label: 'ID', width: '104px' },
  ...columns.map(({ attribute }) => ({
    key: attribute.id,
    label: attribute.name,
    align: attribute.type === 'number' ? ('end' as const) : ('start' as const),
    ...(attribute.type === 'number' ? { width: '112px' } : {}),
    ...(canSort(attribute) ? { sort: ariaSort(attribute.id) } : {}),
  })),
])
/** Below this width the table scrolls sideways inside its box, so cells are not squeezed. */
const minWidth = computed(() => 104 + 160 * columns.length)

// A row still being created has no server copy yet, so it cannot be opened.
function select(row: Item) {
  if (!isCreating(row.id)) emit('open', row)
}

const attributes = computed(() => new Map(columns.map((c) => [c.attribute.id, c.attribute])))

// After the rows in view were read again (D61), the selected row may have moved. If it was in
// view, it is scrolled to where it is now, so the reader does not lose it.
const table = ref<{
  scrollToIndex: (index: number) => void
  isInView: (index: number) => boolean
} | null>(null)
watch(
  () => reordered,
  (reorder) => {
    const t = table.value
    const index = t ? followSelected(reorder, selectedId, indexOf, t.isInView) : null
    if (t && index !== null) t.scrollToIndex(index)
  },
)

/** Rows `from` to `to` (1-based) of the windows that failed, for the message. */
const failedRanges = computed(() => {
  if (list.state !== 'ready') return ''
  const total = list.data.total
  return [...list.data.failed]
    .sort((a, b) => a - b)
    .map((offset) => {
      const n = (x: number) => new Intl.NumberFormat('en').format(x)
      return `${n(offset + 1)} to ${n(Math.min(offset + WINDOW_SIZE, total))}`
    })
    .join(', ')
})
</script>

<template>
  <StateBlock v-if="list.state === 'loading'" state="loading" title="Loading items" :rows="6" />
  <StateBlock
    v-else-if="list.state === 'error' && list.error.isNoPermission"
    state="no-permission"
    title="You do not have access to this folder's items"
  />
  <StateBlock
    v-else-if="list.state === 'error' && list.error.isNotFound"
    state="not-found"
    title="This folder is not available"
    message="It may have been deleted, or it may not be shared with you."
  />
  <StateBlock
    v-else-if="list.state === 'error'"
    state="error"
    title="The items could not be loaded"
    :message="list.error.message"
  >
    <template #action>
      <BaseButton size="sm" @click="emit('retry')">Try again</BaseButton>
    </template>
  </StateBlock>
  <StateBlock
    v-else-if="list.data.total === 0"
    state="empty"
    :title="list.data.where ? 'No items match this filter' : 'No items in this folder yet'"
    :message="readOnly || list.data.where ? '' : 'Items you add here show up in this table.'"
  >
    <template v-if="!readOnly && !list.data.where" #action>
      <BaseButton size="sm" @click="emit('create')">New item</BaseButton>
    </template>
  </StateBlock>
  <div v-else class="flex min-w-0 flex-col gap-3">
    <!-- A large folder is read in windows of 200 rows; only the rows in view are rendered. -->
    <DataTable
      ref="table"
      mode="virtual"
      :caption="`Items in ${folderName}`"
      :columns="tableColumns"
      :rows="[]"
      :row-at="rowAt"
      :row-count="list.data.total"
      height="max(320px, calc(100vh - 260px))"
      :min-width="minWidth"
      :selected-id="selectedId"
      :busy="list.data.sorting"
      @select="select"
      @sort="emit('sort', nextSort(sort, $event))"
      @windows="emit('windows', $event)"
    >
      <template #cell="{ row, column }">
        <template v-if="column.key === '#id'">
          <span v-if="isCreating(row.id)" class="font-mono text-secondary text-ink3">Saving…</span>
          <RouterLink
            v-else
            :to="itemLink(row)"
            class="font-mono text-secondary text-ink no-underline hover:underline"
            data-item-link
            >{{ idPrefix }}-{{ row.seqId }}</RouterLink
          >
        </template>
        <ValueCell v-else :attribute="attributes.get(column.key)" :value="row.values[column.key]" />
      </template>
    </DataTable>

    <div class="flex flex-wrap items-center gap-3">
      <span v-if="list.data.sorting" role="status" class="text-secondary text-ink3" data-sorting
        >Sorting…</span
      >
      <template v-if="list.data.failed.length > 0">
        <span role="alert" class="text-secondary text-danger" data-window-error
          >Rows {{ failedRanges }} could not be loaded. {{ list.data.failure?.message }}</span
        >
        <BaseButton size="sm" @click="emit('retryWindows')">Try again</BaseButton>
      </template>
    </div>
  </div>
</template>
