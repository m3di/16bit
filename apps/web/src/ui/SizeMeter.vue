<script setup lang="ts">
import { computed } from 'vue'
import { paletteVar, type PaletteColor } from './palette.ts'
import { SIZE_LEVELS, sizeLevel } from './size-meter.ts'

const { count, color = 'indigo' } = defineProps<{
  /** Number of items. */
  count: number
  /** The hub's palette colour. */
  color?: PaletteColor
}>()

const level = computed(() => sizeLevel(count))
</script>

<template>
  <span
    role="img"
    :aria-label="`Size: ${String(level)} of ${String(SIZE_LEVELS)}`"
    class="inline-flex gap-0.5"
  >
    <span
      v-for="n in SIZE_LEVELS"
      :key="n"
      class="block size-1.5 bg-empty"
      :style="n <= level ? { background: paletteVar(color) } : undefined"
    />
  </span>
</template>
