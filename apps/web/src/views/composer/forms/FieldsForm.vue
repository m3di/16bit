<script setup lang="ts">
import { MAX_FIELDS_BLOCK_FIELDS } from '@16bit/core'
import { computed } from 'vue'
import { BaseButton } from '../../../ui/index.ts'
import AttributeField from '../fields/AttributeField.vue'
import ItemBindingField from '../fields/ItemBindingField.vue'
import SelectField from '../fields/SelectField.vue'
import { useBlockForm, useField } from '../form-context.ts'
import { folderAt } from '../options.ts'

// One item's attributes, inline ("Sprint 24 runs Nov 9 to Nov 20", D82) or stacked.
const form = useBlockForm()
const folderId = computed(() => folderAt(form, 'binding'))
const { value, error } = useField<string[] | undefined>(() => 'fields', { exact: true })
const list = computed(() => (Array.isArray(value.value) ? value.value : []))
function add() {
  const next = form
    .schema()
    .attributesOf(folderId.value)
    .find((a) => !list.value.includes(a.id))
  value.value = [...list.value, next?.id ?? '']
}
function remove(i: number) {
  value.value = list.value.filter((_, j) => j !== i)
}
const LAYOUTS = [
  { value: 'stacked', label: 'Stacked, a label column and values' },
  { value: 'inline', label: 'Inline, on one wrapping line' },
]
</script>

<template>
  <ItemBindingField />
  <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
    <legend class="mb-1 p-0 text-secondary text-ink3">Fields shown</legend>
    <div
      v-for="(id, i) in list"
      :key="`${String(i)}:${id}/${String(list.length)}`"
      class="flex flex-wrap items-start gap-2"
    >
      <div class="min-w-40 flex-[1_1_180px]">
        <AttributeField
          :path="`fields.${String(i)}`"
          :label="`Field ${String(i + 1)}`"
          :folder-id="folderId"
        />
      </div>
      <BaseButton
        size="sm"
        variant="quiet"
        class="mt-5"
        :disabled="list.length <= 1"
        @click="remove(i)"
        >Remove<span class="sr-only"> field {{ i + 1 }}</span></BaseButton
      >
    </div>
    <div>
      <BaseButton size="sm" :disabled="list.length >= MAX_FIELDS_BLOCK_FIELDS" @click="add"
        >Add field</BaseButton
      >
    </div>
    <span v-if="error" class="text-secondary text-danger">{{ error }}</span>
  </fieldset>
  <SelectField path="layout" label="Layout" :options="LAYOUTS" />
</template>
