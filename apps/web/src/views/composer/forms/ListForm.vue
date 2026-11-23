<script setup lang="ts">
import { MAX_GROUP_MEASURES } from '@16bit/core'
import { computed } from 'vue'
import { CheckboxField } from '../../../ui/index.ts'
import { firstGroup } from '../defaults.ts'
import CheckField from '../fields/CheckField.vue'
import GroupByField from '../fields/GroupByField.vue'
import MeasuresField from '../fields/MeasuresField.vue'
import RowFieldsField from '../fields/RowFieldsField.vue'
import SetBindingField from '../fields/SetBindingField.vue'
import { useBlockForm } from '../form-context.ts'
import { folderAt } from '../options.ts'

const form = useBlockForm()
const folderId = computed(() => folderAt(form, 'binding'))
const grouped = computed({
  get: () => form.get('groupBy') !== undefined,
  set: (on: boolean) => {
    form.set(
      'groupBy',
      on ? { ...firstGroup(form.schema().attributesOf(folderId.value)), measures: [] } : undefined,
    )
  },
})
</script>

<template>
  <SetBindingField />
  <RowFieldsField :key="folderId" path="fields" :folder-id="folderId" />
  <CheckboxField v-model="grouped" label="Group rows" />
  <template v-if="grouped">
    <GroupByField :key="folderId" path="groupBy" :folder-id="folderId" />
    <MeasuresField
      :key="`m:${folderId}`"
      path="groupBy.measures"
      :folder-id="folderId"
      :max="MAX_GROUP_MEASURES"
      :names="['Group measure 1', 'Group measure 2']"
    />
  </template>
  <CheckField
    path="create"
    label="Offer “New item”"
    hint="Shown to people who can add items to the folder. It fills in the group's value and the filter's “is” conditions."
  />
</template>
