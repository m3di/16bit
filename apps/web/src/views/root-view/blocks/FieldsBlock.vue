<script setup lang="ts">
import type { Block } from '@16bit/core'
import { computed } from 'vue'
import { FieldsInline, type InlineField } from '../../../ui/index.ts'
import { attributeOf, fieldValue } from '../format.ts'
import type { BlockLoad } from '../useRootView.ts'
import { useBlock } from './use-block.ts'

// The `fields` block (D77): one item's attributes, inline under a page title ("Sprint 24, Start
// Nov 9, End Nov 20") or stacked. A rule that finds no item is not an error: nothing to show yet.
const { block, load = null } = defineProps<{
  block: Block
  load?: BlockLoad | null
  level: number
}>()

const config = computed(() => (block.type === 'fields' ? block.config : null))
const b = useBlock(() => load, 'item')

const item = computed(() => {
  const found = b.data.value?.item
  return found ? (b.current([found])[0] ?? null) : null
})
const state = computed(() => {
  if (b.state.value !== 'ready') return b.state.value
  if (item.value) return 'ready'
  // A fixed item that is gone answers `not_found`; this is a rule that matched nothing, or an
  // item deleted since the read.
  return config.value?.binding.by === 'rule' ? 'unresolved' : 'not-found'
})

const fields = computed((): InlineField[] => {
  const i = item.value
  const c = config.value
  if (!i || !c) return []
  return c.fields.flatMap((id) => {
    const a = attributeOf(b.description(), id)
    if (!a) return []
    return [
      {
        key: a.id,
        label: a.name,
        value: fieldValue(a, i.values[a.id], b.names) ?? { text: 'Empty', empty: true },
      },
    ]
  })
})
</script>

<template>
  <div :data-view-block="block.id" data-block="fields-block" :data-block-state="state">
    <FieldsInline
      :fields="fields"
      :stacked="config?.layout === 'stacked'"
      :state="state"
      v-bind="
        state === 'unresolved'
          ? { stateTitle: 'Nothing to show yet', stateMessage: 'No item matches this block.' }
          : {}
      "
    />
  </div>
</template>
