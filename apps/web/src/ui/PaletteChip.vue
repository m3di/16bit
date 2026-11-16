<script setup lang="ts">
import { paletteVar, type PaletteColor } from './palette.ts'

const { color } = defineProps<{ color: PaletteColor }>()
</script>

<template>
  <span
    class="inline-flex items-center rounded-chip px-1.5 text-caption"
    :style="{ background: paletteVar(color, 'tint'), color: paletteVar(color, 'ink') }"
    ><slot
  /></span>
</template>
