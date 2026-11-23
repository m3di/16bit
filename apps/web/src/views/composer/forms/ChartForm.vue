<script setup lang="ts">
import { DAY_COUNTS, MAX_GROUP_MEASURES } from '@16bit/core'
import { computed } from 'vue'
import { itemBound, kindConfig } from '../defaults.ts'
import AttributeField from '../fields/AttributeField.vue'
import GroupByField from '../fields/GroupByField.vue'
import MeasuresField from '../fields/MeasuresField.vue'
import SelectField from '../fields/SelectField.vue'
import SetBindingField from '../fields/SetBindingField.vue'
import TextField from '../fields/TextField.vue'
import { useBlockForm } from '../form-context.ts'
import { folderAt } from '../options.ts'
import { locate } from '../tree.ts'

// `bars`: a bar row per group with 1 or 2 measures. `burndown`: points left per day across the
// dates of the item another block shows (the current sprint, D82).
const form = useBlockForm()
const kind = computed(() => form.get('kind'))
const folderId = computed(() => folderAt(form, 'binding'))

const KINDS = [
  { value: 'bars', label: 'Bars, one per group' },
  { value: 'burndown', label: 'Burndown over an item’s dates' },
]
const DAYS = DAY_COUNTS.map((d) => ({
  value: d,
  label: d === 'weekdays' ? 'Weekdays (Monday to Friday)' : 'Calendar days',
}))
const ranges = computed(() => itemBound(form.root()).map((b) => ({ value: b.id, label: b.label })))
// The range's dates are attributes of the folder its block shows.
const rangeFolder = computed(() => {
  const id = form.get('range.block')
  const b = typeof id === 'string' ? locate(form.root(), id)?.block : undefined
  const binding = b?.config['binding']
  return binding && typeof binding === 'object' && 'folderId' in binding
    ? String(binding.folderId)
    : ''
})

function onKind(next: string) {
  const block = form.block()
  block.config = kindConfig(
    'chart',
    next,
    folderId.value,
    form.schema(),
    form.root(),
    block.config['label'],
  )
}
</script>

<template>
  <SelectField path="kind" label="Draws" :options="KINDS" @change="onKind" />
  <TextField path="label" label="Label" optional />
  <SetBindingField no-limit />
  <template v-if="kind === 'burndown'">
    <SelectField
      path="range.block"
      label="Dates from the item of"
      :options="ranges"
      :hint="
        ranges.length
          ? ''
          : 'Add a Fields block or a day count bound to one item first, such as the current sprint.'
      "
    />
    <AttributeField
      :key="`rs:${rangeFolder}`"
      path="range.start"
      label="Start date"
      :folder-id="rangeFolder"
      :types="['date']"
    />
    <AttributeField
      :key="`re:${rangeFolder}`"
      path="range.end"
      label="End date"
      :folder-id="rangeFolder"
      :types="['date']"
    />
    <AttributeField
      :key="`d:${folderId}`"
      path="doneOn"
      label="Done on"
      :folder-id="folderId"
      :types="['date']"
      indexed
    />
    <AttributeField
      :key="`p:${folderId}`"
      path="points"
      label="Points"
      :folder-id="folderId"
      :types="['number']"
      indexed
      none="None: count items"
    />
    <SelectField path="days" label="Count" :options="DAYS" />
  </template>
  <template v-else>
    <GroupByField :key="folderId" path="groupBy" :folder-id="folderId" />
    <MeasuresField
      :key="`m:${folderId}`"
      path="measures"
      :folder-id="folderId"
      :min="1"
      :max="MAX_GROUP_MEASURES"
      :names="['Value', 'Of']"
    />
  </template>
</template>
