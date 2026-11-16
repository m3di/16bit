<script setup lang="ts">
import { useTheme, type ThemePreference } from '../theme/theme.ts'
import BaseSelect, { type SelectOption } from './BaseSelect.vue'

const { preference } = useTheme()

const options: SelectOption[] = [
  { value: 'system', label: 'System theme' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function onUpdate(value: string) {
  preference.value = value as ThemePreference
}
</script>

<template>
  <BaseSelect
    label="Theme"
    label-hidden
    size="sm"
    :options="options"
    :model-value="preference"
    @update:model-value="onUpdate"
  />
</template>
