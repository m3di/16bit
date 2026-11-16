<script setup lang="ts">
import type { Attribute, ItemValues } from '@16bit/core'
import { computed } from 'vue'
import { PaletteChip } from '../../ui/index.ts'
import { formatValue, selectedOption } from './values.ts'

const { attribute, value } = defineProps<{
  /** Missing when the column has no attribute; the cell is then empty. */
  attribute: Attribute | undefined
  value: ItemValues[string] | undefined
}>()

const text = computed(() => (attribute ? formatValue(attribute, value) : ''))
const color = computed(() => (attribute ? selectedOption(attribute, value)?.color : null) ?? null)
</script>

<template>
  <PaletteChip v-if="color" :color="color">{{ text }}</PaletteChip>
  <template v-else>{{ text }}</template>
</template>
