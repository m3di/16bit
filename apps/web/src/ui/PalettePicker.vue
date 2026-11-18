<script setup lang="ts">
import { computed, useId } from 'vue'
import { PALETTE_COLORS, paletteVar, type PaletteColor } from './palette.ts'
import ValueState from './ValueState.vue'

const model = defineModel<PaletteColor | null>({ default: null })

const {
  label,
  labelHidden,
  allowNone,
  size = 'md',
  state = 'ready',
  reason = '',
  disabled,
} = defineProps<{
  label: string
  labelHidden?: boolean
  /** Adds "No colour" first, for things whose colour is optional (select options). */
  allowNone?: boolean
  /** md: 22px swatches, as in hub settings. sm: 16px, inside an options row. */
  size?: 'sm' | 'md'
  /**
   * loading and error: no swatches, so a colour that failed to load is never replaced by a guess.
   * no-permission: the chosen colour and its name, read-only, with the reason. With no colour
   * chosen (empty) every swatch is unchecked and the first one takes focus.
   */
  state?: 'ready' | 'loading' | 'error' | 'no-permission'
  reason?: string
  disabled?: boolean
}>()

const id = useId()
const labelId = `${id}-label`
const name = `${id}-color`

const names: Record<PaletteColor, string> = {
  indigo: 'Indigo',
  blue: 'Blue',
  cyan: 'Cyan',
  teal: 'Teal',
  green: 'Green',
  lime: 'Lime',
  yellow: 'Yellow',
  amber: 'Amber',
  orange: 'Orange',
  red: 'Red',
  pink: 'Pink',
  magenta: 'Magenta',
  violet: 'Violet',
  slate: 'Slate',
  ink: 'Ink',
  grey: 'Grey',
}

const choices = computed<{ value: PaletteColor | null; label: string }[]>(() => [
  ...(allowNone ? [{ value: null, label: 'No colour' }] : []),
  ...PALETTE_COLORS.map((c) => ({ value: c, label: names[c] })),
])

const swatch = computed(() => (size === 'sm' ? 'size-4' : 'size-[22px]'))
</script>

<template>
  <div class="flex flex-col gap-1" :data-state="state">
    <span :id="labelId" :class="labelHidden ? 'sr-only' : 'text-secondary text-ink3'">{{
      label
    }}</span>

    <ValueState v-if="state === 'loading'" state="loading" :label="`Loading ${label}`" />
    <ValueState v-else-if="state === 'error'" state="error" />

    <span v-else-if="state === 'no-permission'" class="flex flex-col gap-1">
      <span class="flex min-h-[22px] items-center gap-2">
        <span
          v-if="model"
          aria-hidden="true"
          :class="['block rounded-chip', swatch]"
          :style="{ background: paletteVar(model) }"
        />
        <span
          v-else
          aria-hidden="true"
          :class="['block rounded-chip border border-dashed border-line3', swatch]"
        />
        <span class="text-ink2">{{ model ? names[model] : 'No colour' }}</span>
      </span>
      <span class="text-secondary text-ink3">{{
        reason || 'You can view this but not change it.'
      }}</span>
    </span>

    <!-- Native radios: Tab reaches the group once, arrow keys move and select, and screen readers
         read "Indigo, radio button, 1 of 16". The input sits under the swatch, invisible. -->
    <div v-else role="radiogroup" :aria-labelledby="labelId" class="flex flex-wrap gap-1.5">
      <label
        v-for="c in choices"
        :key="c.value ?? 'none'"
        :class="[
          'relative inline-flex cursor-pointer has-disabled:cursor-not-allowed has-disabled:opacity-50',
          'rounded-chip has-checked:outline-2 has-checked:outline-offset-2 has-checked:outline-ink',
          'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent',
        ]"
        :title="c.label"
      >
        <input
          type="radio"
          :name="name"
          :value="c.value ?? ''"
          :checked="model === c.value"
          :disabled="disabled"
          :aria-label="c.label"
          class="absolute inset-0 m-0 cursor-[inherit] opacity-0"
          @change="model = c.value"
        />
        <span
          aria-hidden="true"
          :class="[
            'flex items-center justify-center rounded-chip',
            swatch,
            c.value === null && 'border border-dashed border-line3',
          ]"
          :style="c.value ? { background: paletteVar(c.value) } : undefined"
        >
          <!-- The checked swatch also carries a small square, so selection is not only the
               outline's colour. -->
          <span
            v-if="model === c.value"
            data-checked-mark
            :class="['block size-1.5', c.value === null ? 'bg-line3' : 'bg-bg']"
          />
        </span>
      </label>
    </div>
  </div>
</template>
