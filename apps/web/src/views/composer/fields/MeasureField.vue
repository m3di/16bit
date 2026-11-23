<script setup lang="ts">
import { attributeTypes, type SummaryFunction } from '@16bit/core'
import { computed } from 'vue'
import { BaseSelect } from '../../../ui/index.ts'
import { useField } from '../form-context.ts'
import { attributesFor } from '../options.ts'
import { FN_LABELS } from '../words.ts'
import ConditionsField from './ConditionsField.vue'

// One measure (D80): items counted, or a summary of an indexed attribute from its type's
// summaries, optionally over only some items ("done" of "total").
const { path, folderId, label } = defineProps<{ path: string; folderId: string; label: string }>()

const { form, value, error } = useField<{ fn?: string; attribute?: string } | undefined>(
  () => path,
  { exact: true },
)
const attributes = computed(() => attributesFor(form.schema(), folderId, { indexed: true }))
const attributeId = computed(() => value.value?.attribute ?? '')
const attribute = computed(() => attributes.value.find((a) => a.id === attributeId.value))
const fns = computed((): readonly SummaryFunction[] =>
  attribute.value ? attributeTypes[attribute.value.type].summaries : ['count'],
)

const ofOptions = computed(() => [
  { value: '', label: 'Items' },
  ...(attributeId.value && !attribute.value
    ? [{ value: attributeId.value, label: `${attributeId.value} (not available)` }]
    : []),
  ...attributes.value.map((a) => ({ value: a.id, label: a.name })),
])
const fnOptions = computed(() => fns.value.map((f) => ({ value: f, label: FN_LABELS[f] })))

function setOf(id: string) {
  const a = attributes.value.find((x) => x.id === id)
  const allowed: readonly SummaryFunction[] = a ? attributeTypes[a.type].summaries : ['count']
  const fn = allowed.includes(value.value?.fn as SummaryFunction)
    ? value.value?.fn
    : (allowed.find((f) => f !== 'count') ?? 'count')
  form.set(`${path}.attribute`, id === '' ? undefined : id)
  form.set(`${path}.fn`, fn)
}
function setFn(fn: string) {
  form.set(`${path}.fn`, fn)
}
const { error: attributeError } = useField(() => `${path}.attribute`)
const { error: fnError } = useField(() => `${path}.fn`)
</script>

<template>
  <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-composer-measure>
    <legend class="mb-1 p-0 text-secondary text-ink3">{{ label }}</legend>
    <div class="flex flex-wrap gap-2">
      <div class="min-w-36 flex-[1_1_140px]">
        <BaseSelect
          :model-value="attributeId"
          :label="`${label}: of`"
          :options="ofOptions"
          :error="attributeError"
          @update:model-value="setOf"
        />
      </div>
      <div class="min-w-36 flex-[1_1_140px]">
        <BaseSelect
          :model-value="value?.fn ?? 'count'"
          :label="`${label}: summary`"
          :options="fnOptions"
          :error="fnError"
          @update:model-value="setFn"
        />
      </div>
    </div>
    <ConditionsField
      :path="`${path}.where`"
      :folder-id="folderId"
      :label="`${label}: only items where`"
      blocks
    />
    <span v-if="error" class="text-secondary text-danger">{{ error }}</span>
  </fieldset>
</template>
