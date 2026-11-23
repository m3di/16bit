<script setup lang="ts">
import type { Block } from '@16bit/core'
import { computed } from 'vue'
import { BlockSection } from '../../../ui/index.ts'

const { block } = defineProps<{ block: Block; level: number }>()
const title = computed(() => (block.type === 'section' ? (block.config.title ?? '') : ''))
</script>

<template>
  <BlockSection :title="title" :data-view-block="block.id">
    <slot />
  </BlockSection>
</template>
