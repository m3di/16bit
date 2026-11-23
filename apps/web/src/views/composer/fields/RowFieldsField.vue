<script setup lang="ts">
import { MAX_ROW_FIELDS } from '@16bit/core'
import { computed } from 'vue'
import { BaseButton } from '../../../ui/index.ts'
import { useField } from '../form-context.ts'
import AttributeField from './AttributeField.vue'
import TextField from './TextField.vue'

// Up to 4 fields after a row's or card's title (D77), each with the text shown when empty.
const { path, folderId } = defineProps<{ path: string; folderId: string }>()

const { form, value } = useField<{ attribute: string }[] | undefined>(() => path)
const list = computed(() => (Array.isArray(value.value) ? value.value : []))
function add() {
  const used = new Set(list.value.map((f) => f.attribute))
  const next = form
    .schema()
    .attributesOf(folderId)
    .find((a) => !used.has(a.id))
  value.value = [...list.value, { attribute: next?.id ?? '' }]
}
// Whole-list and per-row problems; the fields in a row show their own. The list claims every
// path under it, so none of these is listed again on the block.
const listError = computed(() => form.errorsExactly(path).join(' '))
const rowError = (i: number) => form.errorsExactly(`${path}.${String(i)}`).join(' ')
function remove(i: number) {
  value.value = list.value.filter((_, j) => j !== i)
}
</script>

<template>
  <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-composer-row-fields>
    <legend class="mb-1 p-0 text-secondary text-ink3">Fields after the title</legend>
    <p v-if="list.length === 0" class="m-0 text-secondary text-ink3">Only the title.</p>
    <div
      v-for="(f, i) in list"
      :key="`${String(i)}:${f.attribute}/${String(list.length)}`"
      class="flex flex-wrap items-start gap-2"
    >
      <div class="min-w-36 flex-[1_1_140px]">
        <AttributeField
          :path="`${path}.${String(i)}.attribute`"
          :label="`Field ${String(i + 1)}`"
          :folder-id="folderId"
        />
      </div>
      <div class="min-w-36 flex-[1_1_140px]">
        <TextField
          :path="`${path}.${String(i)}.emptyText`"
          :label="`Field ${String(i + 1)} when empty`"
          optional
        />
      </div>
      <BaseButton size="sm" variant="quiet" class="mt-5" @click="remove(i)"
        >Remove<span class="sr-only"> field {{ i + 1 }}</span></BaseButton
      >
      <span v-if="rowError(i)" class="basis-full text-secondary text-danger">{{
        rowError(i)
      }}</span>
    </div>
    <div>
      <BaseButton size="sm" :disabled="list.length >= MAX_ROW_FIELDS" @click="add"
        >Add field</BaseButton
      >
    </div>
    <span v-if="listError" class="text-secondary text-danger">{{ listError }}</span>
  </fieldset>
</template>
