<script setup lang="ts">
import type { Attribute, ItemValues } from '@16bit/core'
import { computed } from 'vue'
import { ChipList } from '../../ui/index.ts'
import ActorValue from '../hub/ActorValue.vue'
import { listValue } from '../hub/relations.ts'
import RelationValue from '../hub/RelationValue.vue'
import { ValueCell } from '../hub/value-cell.ts'

// One value in the history, on one line as in a table cell. Lists get their own name ("Owner in
// change 12"), so they are never confused with the field of the same name on the page.
const { attribute, value, label } = defineProps<{
  attribute: Attribute
  value: ItemValues[string] | undefined
  label: string
}>()

/** Lists show this many entries and a "+N" count. */
const LIMIT = 2
const list = computed(() => listValue(value))
</script>

<template>
  <RelationValue
    v-if="attribute.type === 'relation'"
    inline
    resolve
    :ids="list"
    :label="label"
    :limit="LIMIT"
  />
  <ActorValue
    v-else-if="attribute.type === 'actor'"
    inline
    :ids="list"
    :label="label"
    :limit="LIMIT"
  />
  <ChipList
    v-else-if="attribute.type === 'multi_select'"
    inline
    :value="list"
    :options="attribute.config.options"
    :label="label"
    :limit="LIMIT"
  />
  <ValueCell v-else :attribute="attribute" :value="value" />
</template>
