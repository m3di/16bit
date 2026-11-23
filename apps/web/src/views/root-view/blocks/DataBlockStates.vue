<script setup lang="ts">
import type { Block } from '@16bit/core'
import { computed } from 'vue'
import { BlockStatus } from '../../../ui/index.ts'
import { stateOf } from '../registry.ts'
import type { BlockLoad } from '../useRootView.ts'

// A data block whose type has no component in this build: its loading, error, invalid,
// not-found and unresolved states as any block shows them, and a quiet note once its data
// is there.
const { block, load = null } = defineProps<{
  block: Block
  load?: BlockLoad | null
  level: number
}>()
const state = computed(() => stateOf(load ?? undefined))
</script>

<template>
  <div :data-view-block="block.id" :data-block-state="state">
    <BlockStatus v-if="state !== 'ready'" :state="state" />
    <BlockStatus v-else state="empty" title="This block cannot be shown here yet" message="" />
  </div>
</template>
