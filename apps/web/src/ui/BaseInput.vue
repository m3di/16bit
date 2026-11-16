<script setup lang="ts">
import { computed, useId } from 'vue'

defineOptions({ inheritAttrs: false })

const model = defineModel<string>({ default: '' })

const {
  label,
  type = 'text',
  hint = '',
  error = '',
  labelHidden,
  mono,
  disabled,
} = defineProps<{
  /** Always required. Use labelHidden when the context makes it obvious, as in a search box. */
  label: string
  type?: 'text' | 'search' | 'email' | 'url' | 'number' | 'password' | 'date' | 'datetime-local'
  hint?: string
  /** Shown under the field. Marks the input invalid. */
  error?: string
  labelHidden?: boolean
  /** For IDs, prefixes, and raw values. */
  mono?: boolean
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
    <input
      v-bind="$attrs"
      :id="id"
      v-model="model"
      :type="type"
      :disabled="disabled"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="describedBy"
      :class="[
        'box-border min-h-8 w-full rounded-control border bg-bg px-2 text-ink placeholder:text-ink3',
        'disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink3',
        error ? 'border-danger' : 'border-line3',
        mono ? 'font-mono text-secondary' : 'text-body',
      ]"
    />
    <span v-if="hint" :id="hintId" class="text-secondary text-ink3">{{ hint }}</span>
    <span v-if="error" :id="errorId" class="text-secondary text-danger">{{ error }}</span>
  </div>
</template>
