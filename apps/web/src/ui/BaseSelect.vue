<script setup lang="ts">
import { computed, useId } from 'vue'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

defineOptions({ inheritAttrs: false })

const model = defineModel<string>({ default: '' })

const {
  label,
  options,
  size = 'md',
  hint = '',
  error = '',
  labelHidden,
  disabled,
} = defineProps<{
  label: string
  options: readonly SelectOption[]
  /** md is 32px, sm is 28px for use inside table rows. */
  size?: 'sm' | 'md'
  hint?: string
  error?: string
  labelHidden?: boolean
  disabled?: boolean
}>()

const id = useId()
const hintId = `${id}-hint`
const errorId = `${id}-error`
const describedBy = computed(
  () => [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined,
)
</script>

<template>
  <div class="flex flex-col gap-1">
    <label :for="id" :class="labelHidden ? 'sr-only' : 'text-secondary text-ink3'">{{
      label
    }}</label>
    <span class="relative inline-flex">
      <select
        v-bind="$attrs"
        :id="id"
        v-model="model"
        :disabled="disabled"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        :class="[
          'box-border w-full cursor-pointer appearance-none rounded-control border bg-bg pr-7 pl-2 text-body text-ink',
          'disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink3',
          size === 'sm' ? 'min-h-7' : 'min-h-8',
          error ? 'border-danger' : 'border-line3',
        ]"
      >
        <option v-for="o in options" :key="o.value" :value="o.value" :disabled="o.disabled">
          {{ o.label }}
        </option>
      </select>
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 10 6"
        class="pointer-events-none absolute top-1/2 right-2.5 h-1.5 w-2.5 -translate-y-1/2 text-ink3"
      >
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </span>
    <span v-if="hint" :id="hintId" class="text-secondary text-ink3">{{ hint }}</span>
    <span v-if="error" :id="errorId" class="text-secondary text-danger">{{ error }}</span>
  </div>
</template>
