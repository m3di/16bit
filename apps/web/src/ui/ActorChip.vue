<script setup lang="ts">
import PixelAvatar from './PixelAvatar.vue'
import type { Actor, ValueStateName } from './value-types.ts'
import ValueState from './ValueState.vue'

const {
  actor,
  size = 'md',
  state = 'ready',
} = defineProps<{
  /** Null when the actor is not set. */
  actor: Actor | null | undefined
  /** md is 18px for fields and rows, lg is 20px for comment headers. */
  size?: 'md' | 'lg'
  state?: Exclude<ValueStateName, 'empty'> | 'ready'
}>()
</script>

<template>
  <ValueState v-if="state !== 'ready'" :state="state" />
  <ValueState v-else-if="!actor" state="empty" />
  <span
    v-else
    class="inline-flex min-w-0 items-center gap-1.5 align-middle"
    :data-kind="actor.kind"
  >
    <PixelAvatar :id="actor.id" :size="size === 'lg' ? 20 : 18" />
    <span class="truncate text-ink">{{ actor.name }}</span>
    <span v-if="actor.kind === 'agent'" class="shrink-0 text-secondary text-pal-violet-ink"
      >Agent</span
    >
  </span>
</template>
