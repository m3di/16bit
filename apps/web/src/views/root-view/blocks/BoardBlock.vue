<script setup lang="ts">
import type { Block } from '@16bit/core'
import { computed } from 'vue'
import { BoardView, type BoardColumnData } from '../../../ui/index.ts'
import type { FieldValue } from '../../../ui/blocks.ts'
import { attributeOf, rowValues, titleOf } from '../format.ts'
import type { BlockLoad } from '../useRootView.ts'
import { newItemPresets } from './presets.ts'
import { useBlock } from './use-block.ts'

// The `board` block (D77): the configured subset of a select's options, in order, as columns,
// empty ones included; up to 25 cards each with "+N more" past them.
const { block, load = null } = defineProps<{
  block: Block
  load?: BlockLoad | null
  level: number
}>()

const config = computed(() => (block.type === 'board' ? block.config : null))
const b = useBlock(() => load, 'board')

const columns = computed((): BoardColumnData[] => {
  const c = config.value
  const d = b.data.value
  if (!c || !d) return []
  const attribute = attributeOf(b.description(), c.column.attribute)
  const options = attribute?.type === 'select' ? attribute.config.options : []
  return c.column.options.map((col) => {
    const option = options.find((o) => o.id === col.option)
    const answer = d.columns.find((x) => x.option === col.option)
    const cards = b.current(answer?.items ?? []).map((item) => {
      const values = rowValues(b.description(), c.fields, item, b.names)
      return {
        id: item.id,
        title: titleOf(b.description(), item),
        fields: c.fields
          .map((f) => values[f.attribute])
          .filter((v): v is FieldValue => v !== undefined),
        to: b.host.itemLink(item),
      }
    })
    return {
      id: col.option,
      // An option removed since the board was saved makes the block invalid on the server;
      // its ID stands in until then.
      label: option?.label ?? col.option,
      ...(option?.color ? { color: option.color } : {}),
      count: answer?.total ?? cards.length,
      cards,
      ...(col.emptyText ? { emptyText: col.emptyText } : {}),
    }
  })
})

const folderId = computed(() => config.value?.binding.folderId ?? '')
const creatable = computed(
  () => !!config.value?.create && b.state.value === 'ready' && b.host.canCreate(folderId.value),
)

function create(columnId: string) {
  const c = config.value
  if (!c) return
  b.host.create(
    c.binding.folderId,
    newItemPresets(b.description(), c.binding.folderId, c.binding.where, b.host.me(), {
      attribute: c.column.attribute,
      value: columnId,
    }),
  )
}
</script>

<template>
  <div :data-view-block="block.id" data-block="board" :data-block-state="b.state.value">
    <BoardView
      :columns="columns"
      :state="b.state.value"
      :creatable="creatable"
      v-bind="config?.emptyText ? { emptyText: config.emptyText } : {}"
      @create="create"
    />
  </div>
</template>
