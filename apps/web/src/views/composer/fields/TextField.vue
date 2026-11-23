<script setup lang="ts">
import { computed } from 'vue'
import { BaseInput } from '../../../ui/index.ts'
import ComposerTextarea from '../ComposerTextarea.vue'
import { useField } from '../form-context.ts'
import { asText } from '../options.ts'

// A text config value. `optional`: an empty field removes the key, as core reads "no title".
const {
  path,
  label,
  hint = '',
  optional,
  multiline,
  number,
} = defineProps<{
  path: string
  label: string
  hint?: string
  optional?: boolean
  multiline?: boolean
  /** Stores a number; an empty field removes the key. */
  number?: boolean
}>()

const { value, error } = useField(() => path)
const text = computed({
  get: () => asText(value.value),
  set: (v: string) => {
    if (number) {
      const n = Number(v)
      value.value = v.trim() === '' ? undefined : Number.isFinite(n) ? n : v
      return
    }
    value.value = optional && v.trim() === '' ? undefined : v
  },
})
</script>

<template>
  <ComposerTextarea v-if="multiline" v-model="text" :label="label" :hint="hint" :error="error" />
  <BaseInput
    v-else
    v-model="text"
    :label="label"
    :hint="hint"
    :error="error"
    :type="number ? 'number' : 'text'"
  />
</template>
