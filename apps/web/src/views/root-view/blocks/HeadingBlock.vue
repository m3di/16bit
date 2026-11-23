<script setup lang="ts">
import type { Block } from '@16bit/core'
import { computed } from 'vue'
import { headingLevel } from '../render-tree.ts'

// A heading in the page. The page title is the only h1 and no level is skipped: the configured
// level is kept where the outline allows it (`level` is the outline's next level). An h2 looks
// like a section's, deeper ones like a list's group headers (DESIGN.md, Components for M4).
const { block, level } = defineProps<{ block: Block; level: number }>()

const tag = computed(() => {
  const configured = block.type === 'heading' ? block.config.level : 2
  return `h${String(headingLevel(configured, level - 1))}`
})
const text = computed(() => (block.type === 'heading' ? block.config.text : ''))
</script>

<template>
  <component
    :is="tag"
    :class="[
      'm-0',
      tag === 'h2' ? 'text-body font-medium text-ink' : 'text-caption font-normal text-ink3',
    ]"
    :data-view-block="block.id"
    data-block="heading"
    >{{ text }}</component
  >
</template>
