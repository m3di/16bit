<script setup lang="ts">
import type { Block } from '@16bit/core'
import { computed } from 'vue'

// Plain text (D77): line breaks kept, no markup.
const { block } = defineProps<{ block: Block; level: number }>()
const text = computed(() => (block.type === 'text' ? block.config.text : ''))
</script>

<template>
  <p
    class="m-0 whitespace-pre-line text-ink2"
    :data-view-block="block.id"
    data-block="text"
    v-text="text"
  />
</template>
