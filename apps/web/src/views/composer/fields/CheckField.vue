<script setup lang="ts">
import { computed } from 'vue'
import { CheckboxField } from '../../../ui/index.ts'
import { useField } from '../form-context.ts'

const { path, label, hint = '' } = defineProps<{ path: string; label: string; hint?: string }>()
const { value, error } = useField(() => path)
const checked = computed({
  get: () => value.value === true,
  set: (v: boolean) => {
    value.value = v
  },
})
</script>

<template>
  <CheckboxField v-model="checked" :label="label" :hint="hint" :error="error" />
</template>
