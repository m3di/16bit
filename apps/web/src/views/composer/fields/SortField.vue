<script setup lang="ts">
import { MAX_SORT_KEYS } from '@16bit/core'
import { computed } from 'vue'
import { BaseButton } from '../../../ui/index.ts'
import { useField } from '../form-context.ts'
import { attributesFor } from '../options.ts'
import AttributeField from './AttributeField.vue'
import SelectField from './SelectField.vue'

// Up to 3 sort keys on indexed, sortable attributes (D79). None is the server's order.
const { path, folderId } = defineProps<{ path: string; folderId: string }>()

const { form, value } = useField<{ attribute: string; direction?: string }[] | undefined>(
  () => path,
)
const keys = computed(() => (Array.isArray(value.value) ? value.value : []))
const choices = computed(() =>
  attributesFor(form.schema(), folderId, { indexed: true, sortable: true }),
)

function add() {
  const used = new Set(keys.value.map((k) => k.attribute))
  const next = choices.value.find((a) => !used.has(a.id))
  value.value = [...keys.value, { attribute: next?.id ?? '', direction: 'asc' }]
}
// Whole-list and per-row problems; the fields in a row show their own. The list claims every
// path under it, so none of these is listed again on the block.
const listError = computed(() => form.errorsExactly(path).join(' '))
const rowError = (i: number) => form.errorsExactly(`${path}.${String(i)}`).join(' ')
function remove(i: number) {
  value.value = keys.value.filter((_, j) => j !== i)
}
const DIRECTIONS = [
  { value: 'asc', label: 'Ascending' },
  { value: 'desc', label: 'Descending' },
]
</script>

<template>
  <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-composer-sort>
    <legend class="mb-1 p-0 text-secondary text-ink3">Sort</legend>
    <p v-if="keys.length === 0" class="m-0 text-secondary text-ink3">In the server's order.</p>
    <div
      v-for="(k, i) in keys"
      :key="`${String(i)}:${k.attribute}`"
      class="flex flex-wrap items-end gap-2"
    >
      <div class="min-w-40 flex-[2_1_160px]">
        <AttributeField
          :path="`${path}.${String(i)}.attribute`"
          :label="`Sort ${String(i + 1)} by`"
          :folder-id="folderId"
          indexed
          sortable
        />
      </div>
      <div class="min-w-32 flex-[1_1_120px]">
        <SelectField
          :path="`${path}.${String(i)}.direction`"
          :label="`Sort ${String(i + 1)} direction`"
          :options="DIRECTIONS"
        />
      </div>
      <BaseButton size="sm" variant="quiet" @click="remove(i)"
        >Remove<span class="sr-only"> sort {{ i + 1 }}</span></BaseButton
      >
      <span v-if="rowError(i)" class="basis-full text-secondary text-danger">{{
        rowError(i)
      }}</span>
    </div>
    <div>
      <BaseButton
        size="sm"
        :disabled="keys.length >= MAX_SORT_KEYS || choices.length === 0"
        @click="add"
        >Add sort</BaseButton
      >
    </div>
    <span v-if="listError" class="text-secondary text-danger">{{ listError }}</span>
  </fieldset>
</template>
