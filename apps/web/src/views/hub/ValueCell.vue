<script setup lang="ts">
import type { Attribute, ItemValues } from '@16bit/core'
import { computed } from 'vue'
import { ChipList, PaletteChip, UrlLink } from '../../ui/index.ts'
import ActorValue from './ActorValue.vue'
import { listValue } from './relations.ts'
import RelationValue from './RelationValue.vue'
import { formatValue, selectedOption } from './values.ts'

const { attribute, value } = defineProps<{
  /** Missing when the column has no attribute; the cell is then empty. */
  attribute: Attribute | undefined
  value: ItemValues[string] | undefined
}>()

/** Lists in a 36px row show this many entries and a "+N" count. */
const CELL_LIMIT = 2

const text = computed(() => (attribute ? formatValue(attribute, value) : ''))
const color = computed(() => (attribute ? selectedOption(attribute, value)?.color : null) ?? null)
const list = computed(() => listValue(value))
// Empty cells stay blank, as for every other type, rather than repeating "Empty" down a column.
const empty = computed(
  () => value === null || value === undefined || (Array.isArray(value) && value.length === 0),
)
</script>

<template>
  <template v-if="!attribute || empty" />
  <ChipList
    v-else-if="attribute.type === 'multi_select'"
    :value="list"
    :options="attribute.config.options"
    :label="attribute.name"
    :limit="CELL_LIMIT"
    class="flex-nowrap! whitespace-nowrap"
  />
  <UrlLink v-else-if="attribute.type === 'url'" :value="typeof value === 'string' ? value : null" />
  <ActorValue
    v-else-if="attribute.type === 'actor'"
    inline
    :ids="list"
    :label="attribute.name"
    :limit="CELL_LIMIT"
  />
  <RelationValue
    v-else-if="attribute.type === 'relation'"
    inline
    :ids="list"
    :label="attribute.name"
    :limit="CELL_LIMIT"
  />
  <span v-else-if="attribute.type === 'auto_id'" class="font-mono text-secondary">{{ text }}</span>
  <!-- Rich text in a row is its plain text on one line. -->
  <span
    v-else-if="attribute.type === 'rich_text'"
    class="block max-w-80 truncate text-ink2"
    :title="text"
    >{{ text }}</span
  >
  <PaletteChip v-else-if="color" :color="color">{{ text }}</PaletteChip>
  <template v-else>{{ text }}</template>
</template>
