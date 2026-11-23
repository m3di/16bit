<script setup lang="ts">
import { computed } from 'vue'
import { useBlockForm } from '../form-context.ts'
import { folderAt, folderOptions } from '../options.ts'
import ConditionsField from './ConditionsField.vue'
import SelectField from './SelectField.vue'
import SortField from './SortField.vue'
import TextField from './TextField.vue'

// One item (D79): a fixed item of a folder, or the first match of a rule ("the current
// sprint"). A rule never uses `$block` (D77).
const { path = 'binding' } = defineProps<{ path?: string }>()

const form = useBlockForm()
const folderId = computed(() => folderAt(form, path))
const by = computed(() => form.get(`${path}.by`))
const folders = computed(() => folderOptions(form.schema()))
const BY = [
  { value: 'rule', label: 'The first item matching a rule' },
  { value: 'item', label: 'One item, by its ID' },
]
function onBy(next: string) {
  const folder = folderId.value
  form.set(
    path,
    next === 'item'
      ? { by: 'item', folderId: folder, itemId: '' }
      : { by: 'rule', folderId: folder, where: { and: [] }, sort: [] },
  )
}
</script>

<template>
  <div class="flex flex-col gap-3" data-composer-binding>
    <SelectField :path="`${path}.by`" label="Shows" :options="BY" @change="onBy" />
    <SelectField :path="`${path}.folderId`" label="From" :options="folders" />
    <TextField v-if="by === 'item'" :path="`${path}.itemId`" label="Item ID" />
    <template v-else>
      <ConditionsField
        :key="folderId"
        :path="`${path}.where`"
        :folder-id="folderId"
        label="Rule"
        required
      />
      <SortField :key="`sort:${folderId}`" :path="`${path}.sort`" :folder-id="folderId" />
    </template>
  </div>
</template>
