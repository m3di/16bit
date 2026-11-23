<script setup lang="ts">
import { DATE_BUCKETS, GROUP_TYPES } from '@16bit/core'
import { computed } from 'vue'
import { useBlockForm } from '../form-context.ts'
import AttributeField from './AttributeField.vue'
import SelectField from './SelectField.vue'

// One group dimension (D80): an indexed select, multi-select, actor, relation, boolean or date,
// a date by day, week or month.
const { path, folderId } = defineProps<{ path: string; folderId: string }>()
const form = useBlockForm()

const isDate = computed(() => {
  const id = form.get(`${path}.attribute`)
  return (
    form
      .schema()
      .attributesOf(folderId)
      .find((a) => a.id === id)?.type === 'date'
  )
})
const BUCKETS = DATE_BUCKETS.map((b) => ({
  value: b,
  label: b === 'day' ? 'Day' : b === 'week' ? 'Week (from Monday)' : 'Month',
}))
function onAttribute() {
  const date = isDate.value
  const bucket = form.get(`${path}.bucket`)
  if (date && bucket === undefined) form.set(`${path}.bucket`, 'week')
  if (!date && bucket !== undefined) form.set(`${path}.bucket`, undefined)
}
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <div class="min-w-40 flex-[2_1_160px]">
      <AttributeField
        :path="`${path}.attribute`"
        label="Group by"
        :folder-id="folderId"
        :types="GROUP_TYPES"
        indexed
        @change="onAttribute"
      />
    </div>
    <div v-if="isDate" class="min-w-32 flex-[1_1_120px]">
      <SelectField :path="`${path}.bucket`" label="Each group is a" :options="BUCKETS" />
    </div>
  </div>
</template>
