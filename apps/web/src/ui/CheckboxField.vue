<script setup lang="ts">
import { computed, useId } from 'vue'
import ValueState from './ValueState.vue'

defineOptions({ inheritAttrs: false })

const model = defineModel<boolean>({ default: false })

const {
  label,
  hint = '',
  error = '',
  state = 'ready',
  disabled,
} = defineProps<{
  label: string
  hint?: string
  /** Shown under the box. Marks it invalid. */
  error?: string
  /**
   * loading: a placeholder until the value arrives. no-permission: shown but read-only, with
   * the reason in text. A boolean is never empty (core), so unset reads as unchecked.
   */
  state?: 'ready' | 'loading' | 'no-permission'
  disabled?: boolean
}>()

const id = useId()
const hintId = `${id}-hint`
const errorId = `${id}-error`
const readOnly = computed(() => state === 'no-permission')
const shownHint = computed(() =>
  readOnly.value ? hint || 'You can view this but not change it.' : hint,
)
const describedBy = computed(
  () => [shownHint.value && hintId, error && errorId].filter(Boolean).join(' ') || undefined,
)
</script>

<template>
  <div class="flex flex-col gap-1">
    <span v-if="state === 'loading'" class="flex min-h-8 items-center gap-2">
      <ValueState state="loading" :label="`Loading ${label}`" />
    </span>
    <span v-else class="flex min-h-8 items-center gap-2">
      <input
        v-bind="$attrs"
        :id="id"
        v-model="model"
        type="checkbox"
        :disabled="disabled || readOnly"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        class="m-0 size-4 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed"
      />
      <label
        :for="id"
        :class="[disabled || readOnly ? 'cursor-not-allowed text-ink3' : 'cursor-pointer text-ink']"
        >{{ label }}</label
      >
    </span>
    <span v-if="shownHint && state !== 'loading'" :id="hintId" class="text-secondary text-ink3">{{
      shownHint
    }}</span>
    <span v-if="error && state !== 'loading'" :id="errorId" class="text-secondary text-danger">{{
      error
    }}</span>
  </div>
</template>
