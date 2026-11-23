<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { BaseButton } from '../../ui/index.ts'

// An item's external key (D64), as a row of a Details list. Read-only: keys belong to the client
// that set them, so the UI only shows and copies them.
const { value } = defineProps<{ value: string }>()

const copied = ref<'idle' | 'done' | 'failed'>('idle')
watch(
  () => value,
  () => {
    copied.value = 'idle'
  },
)

async function copy() {
  try {
    await navigator.clipboard.writeText(value)
    copied.value = 'done'
  } catch {
    copied.value = 'failed'
  }
}

const status = computed(() =>
  copied.value === 'done'
    ? 'Copied'
    : copied.value === 'failed'
      ? 'Could not copy. Select the key and copy it yourself.'
      : '',
)
</script>

<template>
  <dt class="text-ink3">External key</dt>
  <dd class="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
    <span class="min-w-0 font-mono text-secondary break-all" data-external-key>{{ value }}</span>
    <BaseButton size="sm" variant="quiet" aria-label="Copy external key" @click="copy"
      >Copy</BaseButton
    >
    <span role="status" class="text-secondary text-ink3" data-copy-status>{{ status }}</span>
  </dd>
</template>
