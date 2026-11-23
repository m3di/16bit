<script setup lang="ts">
import type { AttributeTypeName } from '@16bit/core'
import { computed } from 'vue'
import { useBlockForm } from '../form-context.ts'
import { attributeOptions } from '../options.ts'
import SelectField from './SelectField.vue'

// An attribute of the bound folder, limited to the types and index core allows here.
const {
  path,
  label,
  folderId,
  types = null,
  indexed,
  sortable,
  none = '',
  hint = '',
} = defineProps<{
  path: string
  label: string
  folderId: string
  types?: readonly AttributeTypeName[] | null
  indexed?: boolean
  sortable?: boolean
  none?: string
  hint?: string
}>()
const emit = defineEmits<{ change: [value: string] }>()

const form = useBlockForm()
const options = computed(() =>
  attributeOptions(form.schema(), folderId, {
    ...(types ? { types } : {}),
    ...(indexed ? { indexed } : {}),
    ...(sortable ? { sortable } : {}),
  }),
)
const shownHint = computed(
  () =>
    hint ||
    (options.value.length === 0
      ? indexed
        ? 'This folder shows no indexed attribute of a type that fits here.'
        : 'This folder shows no attribute of a type that fits here.'
      : ''),
)
</script>

<template>
  <SelectField
    :path="path"
    :label="label"
    :options="options"
    :none="none"
    :hint="shownHint"
    @change="emit('change', $event)"
  />
</template>
