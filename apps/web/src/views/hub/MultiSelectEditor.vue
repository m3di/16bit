<script setup lang="ts">
import type { MultiSelectConfig } from '@16bit/core'
import { computed, useId } from 'vue'
import { CheckboxField, ChipList } from '../../ui/index.ts'
import { multiSelectToggled } from './relations.ts'

const {
  config,
  value,
  label,
  error = '',
  disabled,
  readOnly,
} = defineProps<{
  config: MultiSelectConfig
  value: readonly string[]
  label: string
  error?: string
  disabled?: boolean
  /** The reader cannot change it: the chips, with the reason. */
  readOnly?: boolean
}>()

const emit = defineEmits<{ commit: [value: string[] | null] }>()

const errorId = `${useId()}-error`

// A value whose option was deleted stays listed and ticked, so the reader sees it. Any change
// drops it, since the server refuses IDs of deleted options.
const entries = computed(() => {
  const ids = new Set(config.options.map((o) => o.id))
  return [
    ...config.options.map((o) => ({ id: o.id, label: o.label })),
    ...value.filter((v) => !ids.has(v)).map((id) => ({ id, label: 'Deleted option' })),
  ]
})

const hasDeleted = computed(() => entries.value.length > config.options.length)

function set(id: string, on: boolean) {
  emit('commit', multiSelectToggled(value, config.options, id, on))
}
</script>

<template>
  <div v-if="readOnly" class="flex flex-col gap-1">
    <span class="text-secondary text-ink3">{{ label }}</span>
    <ChipList :value="value" :options="config.options" :label="label" />
    <span class="text-secondary text-ink3">You can view this but not change it.</span>
  </div>
  <fieldset
    v-else
    class="m-0 flex min-w-0 flex-col gap-0 border-0 p-0"
    :aria-describedby="error ? errorId : undefined"
    :aria-invalid="error ? 'true' : undefined"
  >
    <legend class="mb-1 p-0 text-secondary text-ink3">{{ label }}</legend>
    <p v-if="entries.length === 0" class="m-0 text-ink3">This field has no options yet.</p>
    <div class="flex flex-wrap gap-x-4">
      <CheckboxField
        v-for="entry in entries"
        :key="entry.id"
        :label="entry.label"
        :model-value="value.includes(entry.id)"
        :disabled="disabled"
        :data-option="entry.id"
        @update:model-value="set(entry.id, $event)"
      />
    </div>
    <span v-if="hasDeleted" class="text-secondary text-ink3" data-deleted-hint
      >Deleted options are removed with your next change.</span
    >
    <span v-if="error" :id="errorId" class="text-secondary text-danger">{{ error }}</span>
  </fieldset>
</template>
