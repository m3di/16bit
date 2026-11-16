<script setup lang="ts">
export type StatusTone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral'

const { label, tone = 'neutral' } = defineProps<{
  /** Required: status is never colour alone. */
  label: string
  tone?: StatusTone
}>()

const dot: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  accent: 'bg-accent',
  neutral: 'bg-ink3',
}
</script>

<template>
  <span class="inline-flex items-center gap-1.5 text-secondary text-ink3">
    <span aria-hidden="true" :class="['size-1.5 shrink-0 rounded-full', dot[tone]]" />
    {{ label }}
  </span>
</template>
