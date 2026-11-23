<script setup lang="ts">
import type { Block } from '@16bit/core'
import { BlockColumns } from '../../../ui/index.ts'

// Each child is one column (D77), sharing the width and wrapping below each other.
const { block } = defineProps<{ block: Block; level: number }>()
</script>

<template>
  <BlockColumns :data-view-block="block.id">
    <slot />
  </BlockColumns>
</template>
