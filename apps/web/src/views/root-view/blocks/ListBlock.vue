<script setup lang="ts">
import type { Block, Item } from '@16bit/core'
import { computed } from 'vue'
import { GroupedList, type ListRow } from '../../../ui/index.ts'
import { attributeOf, groupPreset, listFields, listGroups, rowValues, titleOf } from '../format.ts'
import type { BlockLoad } from '../useRootView.ts'
import { newItemPresets } from './presets.ts'
import { useBlock } from './use-block.ts'

// The `list` block (D77): rows with up to 4 fields, optionally grouped with up to 2 measures per
// group. A list with the item ID before the title, or with groups, is the backlog's table look;
// otherwise the current-work summary look. Neither is a config key: the renderer chooses.
const { block, load = null } = defineProps<{
  block: Block
  load?: BlockLoad | null
  level: number
}>()

const config = computed(() => (block.type === 'list' ? block.config : null))
const b = useBlock(() => load, 'items')

const fields = computed(() => listFields(b.description(), config.value?.fields ?? []))
const groupAttribute = computed(() => {
  const g = config.value?.groupBy
  return g ? attributeOf(b.description(), g.attribute) : undefined
})
const variant = computed(() =>
  config.value?.groupBy || fields.value.some((f) => f.lead) ? 'table' : 'summary',
)

const row = (item: Item): ListRow => ({
  id: item.id,
  title: titleOf(b.description(), item),
  values: rowValues(b.description(), config.value?.fields ?? [], item, b.names),
  to: b.host.itemLink(item),
})

const groups = computed(() => {
  const d = b.data.value
  const c = config.value
  if (!d || !c) return []
  const items = b.current(d.items)
  return listGroups({
    items,
    groups: c.groupBy ? d.groups : undefined,
    attribute: groupAttribute.value,
    bucket: c.groupBy?.bucket,
    measures: c.groupBy?.measures ?? [],
    description: b.description(),
    names: b.names,
    row,
    more: Math.max(0, d.total - d.items.length),
  })
})

const folderId = computed(() => config.value?.binding.folderId ?? '')
const creatable = computed(
  () => !!config.value?.create && b.state.value === 'ready' && b.host.canCreate(folderId.value),
)

function create(groupId: string) {
  const c = config.value
  if (!c) return
  const group = groupPreset(
    groupId,
    c.groupBy ? b.data.value?.groups : undefined,
    groupAttribute.value,
  )
  b.host.create(
    c.binding.folderId,
    newItemPresets(b.description(), c.binding.folderId, c.binding.where, b.host.me(), group),
  )
}
</script>

<template>
  <div :data-view-block="block.id" data-block="list" :data-block-state="b.state.value">
    <GroupedList
      :groups="groups"
      :fields="fields"
      :variant="variant"
      :state="b.state.value"
      :creatable="creatable"
      @create="create"
    />
  </div>
</template>
