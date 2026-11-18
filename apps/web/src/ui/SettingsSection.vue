<script setup lang="ts">
import { useId } from 'vue'
import type { SettingsState } from './settings.ts'
import StateBlock from './StateBlock.vue'

const {
  title,
  description = '',
  state = 'ready',
  stateTitle = '',
  stateMessage = '',
} = defineProps<{
  /** The section heading, 13px at 500. It names the region. */
  title: string
  /** A note under the content, in --ink3 12px, as under the folders table. */
  description?: string
  /** `ready` shows the default slot; the others show a StateBlock in its place. */
  state?: SettingsState
  stateTitle?: string
  stateMessage?: string
}>()

defineSlots<{
  default?(): unknown
  /** Right of the heading: "New folder", "Add people or agents". */
  actions?(): unknown
  'state-action'?(): unknown
}>()

const headingId = useId()
</script>

<template>
  <section :aria-labelledby="headingId" class="flex min-w-0 flex-col gap-3" :data-state="state">
    <div class="flex min-h-8 flex-wrap items-center justify-between gap-3">
      <h2 :id="headingId" class="m-0 text-body font-medium">{{ title }}</h2>
      <div v-if="$slots.actions && state === 'ready'" class="flex items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
    <slot v-if="state === 'ready'" />
    <StateBlock v-else :state="state" :title="stateTitle" :message="stateMessage">
      <template v-if="$slots['state-action']" #action><slot name="state-action" /></template>
    </StateBlock>
    <p v-if="description && state === 'ready'" class="m-0 text-secondary text-ink3">
      {{ description }}
    </p>
  </section>
</template>
