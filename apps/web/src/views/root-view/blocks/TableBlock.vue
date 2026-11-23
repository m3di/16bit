<script setup lang="ts">
import type { Block, Item } from '@16bit/core'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { BlockStatus, DataTable, type TableColumn } from '../../../ui/index.ts'
import { folderColumns } from '../../hub/useHub.ts'
import { ValueCell } from '../../hub/value-cell.ts'
import { formatNumber } from '../format.ts'
import type { BlockLoad } from '../useRootView.ts'
import { useBlock } from './use-block.ts'

// The `table` block in a composed view: the bound folder's columns, as the folder screen shows
// them, for the first `limit` rows (at most 100, D79). The folder screen itself (the default
// view) keeps its windowed table; a block shows a bounded page of rows, so it renders them all.
const { block, load = null } = defineProps<{
  block: Block
  load?: BlockLoad | null
  level: number
}>()

const config = computed(() => (block.type === 'table' ? block.config : null))
const b = useBlock(() => load, 'items')

const folderId = computed(() => config.value?.binding.folderId ?? '')
const columns = computed(() => {
  const d = b.description()
  return d ? folderColumns(d, folderId.value) : []
})
const attributes = computed(() => new Map(columns.value.map((c) => [c.attribute.id, c.attribute])))
const tableColumns = computed<TableColumn[]>(() => [
  { key: '#id', label: 'ID', width: '104px' },
  ...columns.value.map(({ attribute }) => ({
    key: attribute.id,
    label: attribute.name,
    align: attribute.type === 'number' ? ('end' as const) : ('start' as const),
  })),
])
const folderName = computed(() => {
  const d = b.description()
  const f = d?.hub.id === folderId.value ? d.hub : d?.folders.find((x) => x.id === folderId.value)
  return f?.name ?? 'this folder'
})

const rows = computed(() => (b.data.value ? b.current(b.data.value.items) : []))
const more = computed(() => {
  const d = b.data.value
  return d && d.total > rows.value.length
    ? `Showing ${formatNumber(rows.value.length)} of ${formatNumber(d.total)} items`
    : ''
})
const idOf = (row: Item) => `${b.description()?.hub.idPrefix ?? ''}-${String(row.seqId)}`
</script>

<template>
  <div
    :data-view-block="block.id"
    data-block="table"
    :data-block-state="b.state.value"
    class="flex min-w-0 flex-col gap-2"
  >
    <BlockStatus v-if="b.state.value !== 'ready'" :state="b.state.value" :rows="4" />
    <BlockStatus v-else-if="rows.length === 0" state="empty" title="No items here yet" message="" />
    <template v-else>
      <DataTable
        mode="static"
        :caption="`Items in ${folderName}`"
        :columns="tableColumns"
        :rows="rows"
        :min-width="104 + 160 * columns.length"
      >
        <template #cell="{ row, column }">
          <RouterLink
            v-if="column.key === '#id'"
            :to="b.host.itemLink(row as Item)"
            class="font-mono text-secondary text-ink no-underline hover:underline"
            data-item-link
            >{{ idOf(row as Item) }}</RouterLink
          >
          <ValueCell
            v-else
            :attribute="attributes.get(column.key)"
            :value="(row as Item).values[column.key]"
          />
        </template>
      </DataTable>
      <p v-if="more" class="m-0 text-secondary text-ink3" data-table-more>{{ more }}</p>
    </template>
  </div>
</template>
