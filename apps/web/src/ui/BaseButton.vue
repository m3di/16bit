<script setup lang="ts">
import { computed } from 'vue'

const {
  variant = 'outline',
  size = 'md',
  type = 'button',
  danger,
  disabled,
} = defineProps<{
  /** primary: accent fill. outline: hairline border. quiet: no border until hover. */
  variant?: 'primary' | 'outline' | 'quiet'
  /** md is 32px, sm is 28px. */
  size?: 'sm' | 'md'
  type?: 'button' | 'submit' | 'reset'
  /** Destructive action. Ignored on primary. */
  danger?: boolean
  disabled?: boolean
}>()

// The `icon` slot is a leading icon (PlusGlyph on "New item"). Its wrapper is aria-hidden, so
// the button keeps its text as its accessible name. Without an icon the template takes the
// v-else branch, so it renders no placeholder comment and the markup is as before.
defineSlots<{ default?: () => unknown; icon?: () => unknown }>()

const classes = computed(() => [
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control border px-3 font-normal',
  'cursor-pointer disabled:cursor-not-allowed',
  size === 'sm' ? 'min-h-7' : 'min-h-8',
  variant === 'primary' &&
    'border-accent bg-accent text-on-accent disabled:border-empty disabled:bg-empty disabled:text-ink3',
  variant === 'outline' && 'border-line2 bg-bg hover:bg-selected',
  variant === 'quiet' && 'border-transparent bg-transparent hover:bg-selected',
  variant !== 'primary' && (danger ? 'text-danger' : 'text-ink'),
  variant !== 'primary' && 'disabled:bg-transparent disabled:text-ink3',
])
</script>

<template>
  <button :type="type" :disabled="disabled" :class="classes">
    <template v-if="$slots.icon">
      <span aria-hidden="true" class="-mr-0.5 inline-flex shrink-0" data-button-icon>
        <slot name="icon" />
      </span>
      <slot />
    </template>
    <slot v-else />
  </button>
</template>
