<script setup lang="ts">
import { computed } from 'vue'
import { avatarSprite, spritePath } from './avatar.ts'
import { paletteVar } from './palette.ts'

const {
  id,
  size = 18,
  label = '',
} = defineProps<{
  /** Principal ID. The same ID always draws the same sprite. */
  id: string
  /** Pixels. 5 by 5 cells, so multiples of 5 or the mockup's 16 and 18 render crisply. */
  size?: number
  /** Accessible name. Leave empty when a visible name sits next to the avatar. */
  label?: string
}>()

const sprite = computed(() => avatarSprite(id))
const d = computed(() => spritePath(sprite.value.cells))
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 5 5"
    shape-rendering="crispEdges"
    focusable="false"
    class="shrink-0"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    :data-color="sprite.color"
  >
    <rect width="5" height="5" :style="{ fill: paletteVar(sprite.color, 'tint') }" />
    <path :d="d" :style="{ fill: paletteVar(sprite.color, 'ink') }" />
  </svg>
</template>
