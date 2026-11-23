<script setup lang="ts">
import { MAX_BOARD_CARDS, MAX_BOARD_COLUMNS } from '@16bit/core'
import { computed } from 'vue'
import { BaseButton, CheckboxField } from '../../../ui/index.ts'
import AttributeField from '../fields/AttributeField.vue'
import CheckField from '../fields/CheckField.vue'
import RowFieldsField from '../fields/RowFieldsField.vue'
import SetBindingField from '../fields/SetBindingField.vue'
import TextField from '../fields/TextField.vue'
import { useBlockForm, useField } from '../form-context.ts'
import { folderAt } from '../options.ts'

// Columns are an ordered subset of a select's options (D77), in the option's order here.
const form = useBlockForm()
const folderId = computed(() => folderAt(form, 'binding'))
const { value: columns, error: columnsError } = useField<{ option: string; emptyText?: string }[]>(
  () => 'column.options',
  { exact: true },
)
const select = computed(() => {
  const id = form.get('column.attribute')
  const a = form
    .schema()
    .attributesOf(folderId.value)
    .find((x) => x.id === id)
  return a?.type === 'select' ? a : null
})
const chosen = computed(() => (Array.isArray(columns.value) ? columns.value : []))
const shownIndex = (optionId: string) => chosen.value.findIndex((c) => c.option === optionId)

function toggle(optionId: string, on: boolean) {
  const options = select.value?.config.options ?? []
  const kept = chosen.value.filter((c) => c.option !== optionId)
  const next = on ? [...kept, { option: optionId }] : kept
  // In the select's own order, so a board reads left to right as the stages do.
  const order = new Map(options.map((o, i) => [o.id, i]))
  columns.value = next.sort((a, b) => (order.get(a.option) ?? 99) - (order.get(b.option) ?? 99))
}
function onColumnAttribute() {
  const attrs = form.schema().attributesOf(folderId.value)
  const id = form.get('column.attribute')
  const a = attrs.find((x) => x.id === id)
  columns.value =
    a?.type === 'select'
      ? a.config.options.slice(0, MAX_BOARD_COLUMNS).map((o) => ({ option: o.id }))
      : []
}
const unknown = computed(() =>
  chosen.value.filter((c) => !select.value?.config.options.some((o) => o.id === c.option)),
)
</script>

<template>
  <SetBindingField :limit="MAX_BOARD_CARDS" limit-label="Cards per column" />
  <AttributeField
    :key="folderId"
    path="column.attribute"
    label="Columns from"
    :folder-id="folderId"
    :types="['select']"
    indexed
    @change="onColumnAttribute"
  />
  <fieldset v-if="select" class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
    <legend class="mb-1 p-0 text-secondary text-ink3">Columns shown</legend>
    <div
      v-for="o in select.config.options"
      :key="o.id"
      class="flex flex-wrap items-start gap-x-4 gap-y-1"
    >
      <div class="min-w-36 flex-[1_1_140px]">
        <CheckboxField
          :model-value="shownIndex(o.id) >= 0"
          :label="o.label"
          @update:model-value="toggle(o.id, $event)"
        />
      </div>
      <div v-if="shownIndex(o.id) >= 0" class="min-w-40 flex-[2_1_180px]">
        <TextField
          :key="`${o.id}@${String(shownIndex(o.id))}`"
          :path="`column.options.${String(shownIndex(o.id))}.emptyText`"
          :label="`${o.label} when empty`"
          optional
        />
      </div>
    </div>
    <div v-for="c in unknown" :key="c.option" class="flex flex-wrap items-center gap-2">
      <span class="text-secondary text-ink2"
        >Column “{{ c.option }}” is no longer an option of this attribute.</span
      >
      <BaseButton size="sm" variant="quiet" @click="toggle(c.option, false)"
        >Remove<span class="sr-only"> column {{ c.option }}</span></BaseButton
      >
    </div>
    <span v-if="columnsError" class="text-secondary text-danger">{{ columnsError }}</span>
  </fieldset>
  <TextField
    path="emptyText"
    label="Empty column text"
    hint="For columns without their own, such as “Nothing of yours is in review.”"
    optional
  />
  <RowFieldsField :key="`f:${folderId}`" path="fields" :folder-id="folderId" />
  <CheckField
    path="create"
    label="Offer “New item”"
    hint="Shown to people who can add items to the folder. It fills in the column's value and the filter's “is” conditions."
  />
</template>
