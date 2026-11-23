<script setup lang="ts">
import type { BoardColumnData, DataBlockState } from './blocks.ts'
import BlockStatus from './BlockStatus.vue'
import BoardColumn from './BoardColumn.vue'

// The `board` block: its columns side by side at 200px or more, wrapping below each other on a
// narrow page. The board's state replaces all columns; an empty column is not a state.
const {
  columns,
  state = 'ready',
  stateTitle = '',
  stateMessage = null,
  emptyText = 'Nothing here.',
  creatable,
} = defineProps<{
  columns: BoardColumnData[]
  state?: DataBlockState
  stateTitle?: string
  stateMessage?: string | null
  /** The board's default for a column without its own empty text. */
  emptyText?: string
  creatable?: boolean
}>()

const emit = defineEmits<{ open: [cardId: string]; create: [columnId: string] }>()
</script>

<template>
  <BlockStatus
    v-if="state !== 'ready'"
    :state="state"
    :title="stateTitle"
    :message="stateMessage"
  />
  <div v-else class="flex flex-wrap items-start gap-5" data-block="board">
    <BoardColumn
      v-for="column in columns"
      :key="column.id"
      class="flex-[1_1_200px]"
      :label="column.label"
      :color="column.color"
      :count="column.count"
      :cards="column.cards"
      :empty-text="column.emptyText ?? emptyText"
      :creatable="creatable"
      @open="emit('open', $event)"
      @create="emit('create', column.id)"
    />
  </div>
</template>
