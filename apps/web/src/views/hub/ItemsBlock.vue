<script setup lang="ts">
import type { FolderAttributeDefinition, Item } from '@16bit/core'
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { BaseButton, DataTable, StateBlock, type TableColumn } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import type { ItemList } from './useItems.ts'
import ValueCell from './ValueCell.vue'

const {
  folderName,
  list,
  rows,
  columns,
  idPrefix,
  selectedId = null,
  itemLink,
  isCreating = () => false,
} = defineProps<{
  folderName: string
  list: Load<ItemList>
  rows: readonly Item[]
  columns: readonly FolderAttributeDefinition[]
  idPrefix: string
  selectedId?: string | null
  /** Where a row's ID links: the same page with the item panel open. */
  itemLink: (item: Item) => RouteLocationRaw
  isCreating?: (id: string) => boolean
}>()

const emit = defineEmits<{ open: [item: Item]; retry: []; more: []; create: [] }>()

const tableColumns = computed<TableColumn[]>(() => [
  { key: '#id', label: 'ID' },
  ...columns.map(({ attribute }) => ({
    key: attribute.id,
    label: attribute.name,
    align: attribute.type === 'number' ? ('end' as const) : ('start' as const),
  })),
])

const attributes = computed(() => new Map(columns.map((c) => [c.attribute.id, c.attribute])))
</script>

<template>
  <StateBlock v-if="list.state === 'loading'" state="loading" title="Loading items" :rows="6" />
  <StateBlock
    v-else-if="list.state === 'error' && list.error.isNoPermission"
    state="no-permission"
    title="You do not have access to this folder's items"
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
    v-else-if="rows.length === 0"
    state="empty"
    title="No items in this folder yet"
    message="Items you add here show up in this table."
  >
    <template #action>
      <BaseButton size="sm" @click="emit('create')">New item</BaseButton>
    </template>
  </StateBlock>
  <div v-else class="flex min-w-0 flex-col gap-3">
    <DataTable
      :caption="`Items in ${folderName}`"
      :columns="tableColumns"
      :rows="rows"
      :selected-id="selectedId"
      @select="emit('open', $event)"
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
      <BaseButton
        v-if="list.data.nextCursor"
        size="sm"
        :disabled="list.data.more"
        @click="emit('more')"
      >
        {{ list.data.more ? 'Loading…' : 'Load more' }}
      </BaseButton>
      <span v-if="list.data.moreError" role="alert" class="text-secondary text-danger">
        More items could not be loaded. {{ list.data.moreError.message }}
      </span>
    </div>
  </div>
</template>
