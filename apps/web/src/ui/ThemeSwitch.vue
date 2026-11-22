<script setup lang="ts">
import { computed } from 'vue'
import { oppositeTheme, useTheme } from '../theme/theme.ts'
import ThemeGlyph from './ThemeGlyph.vue'

const { theme, toggle } = useTheme()

// The icon and the name say where a click goes: a moon in light mode, a sun in dark mode.
const target = computed(() => oppositeTheme(theme.value))
const label = computed(() => `Switch to ${target.value} theme`)
</script>

<template>
  <button
    type="button"
    :aria-label="label"
    :title="label"
    class="inline-flex size-7 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-ink3 hover:bg-selected hover:text-ink"
    @click="toggle"
  >
    <ThemeGlyph :name="target === 'dark' ? 'moon' : 'sun'" />
  </button>
</template>
