<script setup lang="ts">
import type { Attribute, ItemValues } from '@16bit/core'
import { computed, ref, useId, watch } from 'vue'
import { BaseInput, BaseSelect } from '../../ui/index.ts'
import { fromInput, toInput } from './values.ts'

type Value = ItemValues[string] | undefined

const {
  attribute,
  value,
  required,
  error = '',
  disabled,
} = defineProps<{
  attribute: Attribute
  value: Value
  required?: boolean
  /** From the server or from local validation. */
  error?: string
  disabled?: boolean
}>()

const emit = defineEmits<{ commit: [value: ItemValues[string]] }>()

// The input holds a draft. It follows the value whenever the value changes, which is how a
// rolled-back edit becomes visible.
const draft = ref(toInput(attribute, value))
const localError = ref('')
watch(
  () => toInput(attribute, value),
  (text) => {
    draft.value = text
    localError.value = ''
  },
)

function commit() {
  const parsed = fromInput(attribute, draft.value)
  if (!parsed.ok) {
    localError.value = parsed.message
    return
  }
  localError.value = ''
  if (draft.value === toInput(attribute, value)) return
  emit('commit', parsed.value)
}

const label = computed(() => (required ? `${attribute.name} (required)` : attribute.name))
const shownError = computed(() => localError.value || error)

const selectOptions = computed(() =>
  attribute.type === 'select'
    ? [
        { value: '', label: 'None' },
        ...attribute.config.options.map((o) => ({ value: o.id, label: o.label })),
      ]
    : [],
)

const inputType = computed(() => {
  if (attribute.type === 'number') return 'number'
  if (attribute.type === 'date') return attribute.config.includeTime ? 'datetime-local' : 'date'
  return 'text'
})

const checkboxId = useId()
const checkboxErrorId = `${checkboxId}-error`
function onToggle(event: Event) {
  draft.value = String((event.target as HTMLInputElement).checked)
  commit()
}
</script>

<template>
  <div v-if="attribute.type === 'boolean'" class="flex flex-col gap-1">
    <span class="flex min-h-8 items-center gap-2">
      <input
        :id="checkboxId"
        type="checkbox"
        :checked="draft === 'true'"
        :disabled="disabled"
        :aria-invalid="shownError ? 'true' : undefined"
        :aria-describedby="shownError ? checkboxErrorId : undefined"
        class="m-0 size-4 cursor-pointer accent-accent disabled:cursor-not-allowed"
        @change="onToggle"
      />
      <label :for="checkboxId" class="cursor-pointer text-ink">{{ label }}</label>
    </span>
    <span v-if="shownError" :id="checkboxErrorId" class="text-secondary text-danger">{{
      shownError
    }}</span>
  </div>
  <BaseSelect
    v-else-if="attribute.type === 'select'"
    v-model="draft"
    :label="label"
    :options="selectOptions"
    :error="shownError"
    :disabled="disabled"
    @change="commit"
  />
  <BaseInput
    v-else
    v-model="draft"
    :label="label"
    :type="inputType"
    :error="shownError"
    :disabled="disabled"
    @change="commit"
    @keydown.enter="commit"
  />
</template>
