<script setup lang="ts">
import { computed } from 'vue'
import { BaseSelect } from '../../../ui/index.ts'
import { useField } from '../form-context.ts'
import { asText } from '../options.ts'

// One choice in config. Values are strings in the select; `numeric` stores numbers. A value
// the options don't hold (an attribute removed since) stays shown as itself, so the problem
// is visible and nothing changes until the admin picks.
const {
  path,
  label,
  options,
  hint = '',
  none = '',
  numeric,
} = defineProps<{
  path: string
  label: string
  options: readonly { value: string; label: string }[]
  hint?: string
  /** Offers "nothing" under this label, which removes the key. */
  none?: string
  numeric?: boolean
}>()

const emit = defineEmits<{ change: [value: string] }>()

const { value, error } = useField(() => path)
const current = computed(() => asText(value.value))
const shown = computed(() => {
  const list = [...(none ? [{ value: '', label: none }] : []), ...options]
  if (!list.some((o) => o.value === current.value)) {
    list.unshift({
      value: current.value,
      label: current.value ? `${current.value} (not available)` : 'Choose…',
    })
  }
  return list
})

function choose(v: string) {
  value.value = v === '' && none ? undefined : numeric ? Number(v) : v
  emit('change', v)
}
</script>

<template>
  <BaseSelect
    :model-value="current"
    :label="label"
    :options="shown"
    :hint="hint"
    :error="error"
    @update:model-value="choose"
  />
</template>
