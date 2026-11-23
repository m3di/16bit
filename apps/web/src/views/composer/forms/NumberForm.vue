<script setup lang="ts">
import { DAY_COUNTS } from '@16bit/core'
import { computed } from 'vue'
import { CheckboxField } from '../../../ui/index.ts'
import { kindConfig } from '../defaults.ts'
import AttributeField from '../fields/AttributeField.vue'
import ItemBindingField from '../fields/ItemBindingField.vue'
import MeasureField from '../fields/MeasureField.vue'
import SelectField from '../fields/SelectField.vue'
import SetBindingField from '../fields/SetBindingField.vue'
import TextField from '../fields/TextField.vue'
import { useBlockForm } from '../form-context.ts'
import { folderAt } from '../options.ts'

// `aggregate`: one measure, optionally "of" another ("16 of 34"). `days`: the day of an item
// between two of its dates ("day 6 of 10", D81).
const form = useBlockForm()
const kind = computed(() => form.get('kind'))
const folderId = computed(() => folderAt(form, 'binding'))

const KINDS = [
  { value: 'aggregate', label: 'A count or sum of items' },
  { value: 'days', label: 'The day of an item’s dates' },
]
const DAYS = DAY_COUNTS.map((d) => ({
  value: d,
  label: d === 'weekdays' ? 'Weekdays (Monday to Friday)' : 'Calendar days',
}))

function onKind(next: string) {
  const block = form.block()
  block.config = kindConfig(
    'number',
    next,
    folderId.value,
    form.schema(),
    form.root(),
    block.config['label'],
  )
}
const withTotal = computed({
  get: () => form.get('total') !== undefined,
  set: (on: boolean) => {
    form.set('total', on ? { fn: 'count' } : undefined)
  },
})
</script>

<template>
  <SelectField path="kind" label="Shows" :options="KINDS" @change="onKind" />
  <TextField path="label" label="Label" hint="Above the number, such as “Open points”." optional />
  <template v-if="kind === 'days'">
    <ItemBindingField />
    <AttributeField
      :key="`s:${folderId}`"
      path="start"
      label="Start date"
      :folder-id="folderId"
      :types="['date']"
    />
    <AttributeField
      :key="`e:${folderId}`"
      path="end"
      label="End date"
      :folder-id="folderId"
      :types="['date']"
    />
    <SelectField path="days" label="Count" :options="DAYS" />
  </template>
  <template v-else>
    <SetBindingField no-limit />
    <MeasureField :key="`v:${folderId}`" path="value" :folder-id="folderId" label="Value" />
    <CheckboxField v-model="withTotal" label="Show it “of” a total" />
    <MeasureField
      v-if="withTotal"
      :key="`t:${folderId}`"
      path="total"
      :folder-id="folderId"
      label="Total"
    />
  </template>
</template>
