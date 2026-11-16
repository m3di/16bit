<script setup lang="ts">
import { computed } from 'vue'
import { displayUrl } from './url.ts'
import type { ValueStateName } from './value-types.ts'
import ValueState from './ValueState.vue'

const { value, state = 'ready' } = defineProps<{
  value: string | null | undefined
  /** Overrides the value. A missing value shows the empty state on its own. */
  state?: Exclude<ValueStateName, 'empty'> | 'ready'
}>()

const view = computed(() => (value?.trim() ? displayUrl(value) : null))
</script>

<template>
  <ValueState v-if="state !== 'ready'" :state="state" />
  <ValueState v-else-if="!view" state="empty" />
  <a
    v-else-if="view.href"
    :href="view.href"
    target="_blank"
    rel="noopener noreferrer"
    class="inline-block max-w-full truncate border-b border-line2 align-bottom text-ink no-underline hover:border-line3"
    :title="view.href"
    >{{ view.text }}<span class="sr-only"> (opens in a new tab)</span></a
  >
  <!-- Not a web or mail address: shown as text so it can never run as a link. -->
  <span v-else class="inline-block max-w-full truncate align-bottom text-ink2">{{
    view.text
  }}</span>
</template>
