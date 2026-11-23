<script setup lang="ts">
import { computed } from 'vue'
import { BLOCK_STATE_TEXT, type BlockStateName as BlockState } from './blocks.ts'
import StateBlock from './StateBlock.vue'

// A data block's state in place of its content: StateBlock's compact size with block wording.
// The renderer passes specific text where it knows more ("No current sprint").
const {
  state,
  title = '',
  message = null,
  rows = 3,
} = defineProps<{
  state: BlockState
  title?: string
  /** Pass an empty string to show the title alone. */
  message?: string | null
  rows?: number
}>()

const text = computed(() => BLOCK_STATE_TEXT[state])
</script>

<template>
  <StateBlock
    compact
    :state="state"
    :rows="rows"
    :title="title || text.title"
    :message="message ?? text.message"
  >
    <template v-if="$slots.action" #action><slot name="action" /></template>
  </StateBlock>
</template>
