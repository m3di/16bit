<script setup lang="ts">
import { MAX_SET_ROWS } from '@16bit/core'
import { computed } from 'vue'
import { useBlockForm } from '../form-context.ts'
import { folderAt, folderOptions } from '../options.ts'
import ConditionsField from './ConditionsField.vue'
import SelectField from './SelectField.vue'
import SortField from './SortField.vue'
import TextField from './TextField.vue'

// A set of items (D79): a folder of this hub that holds items, a filter, a sort and a limit.
const {
  path = 'binding',
  limit = MAX_SET_ROWS,
  limitLabel = 'Rows shown',
  noLimit,
} = defineProps<{
  path?: string
  /** The most `limit` may be: 100 rows, or 25 cards per board column. */
  limit?: number
  limitLabel?: string
  /** Blocks that only aggregate ignore the limit (D79). */
  noLimit?: boolean
}>()

const form = useBlockForm()
const folderId = computed(() => folderAt(form, path))
const folders = computed(() => folderOptions(form.schema()))
</script>

<template>
  <div class="flex flex-col gap-3" data-composer-binding>
    <SelectField :path="`${path}.folderId`" label="Items from" :options="folders" />
    <ConditionsField :key="folderId" :path="`${path}.where`" :folder-id="folderId" blocks />
    <SortField :key="`sort:${folderId}`" :path="`${path}.sort`" :folder-id="folderId" />
    <div v-if="!noLimit" class="max-w-40">
      <TextField
        :path="`${path}.limit`"
        :label="limitLabel"
        :hint="`1 to ${String(limit)}`"
        number
      />
    </div>
  </div>
</template>
