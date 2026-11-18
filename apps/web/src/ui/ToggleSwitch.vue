<script setup lang="ts">
import { computed, useId } from 'vue'
import ValueState from './ValueState.vue'

defineOptions({ inheritAttrs: false })

const model = defineModel<boolean>({ default: false })

const {
  label,
  description = '',
  labelHidden,
  state = 'ready',
  reason = '',
  disabled,
} = defineProps<{
  /** Always required. With labelHidden it is read by screen readers only, as in a table cell. */
  label: string
  /** What on and off mean, under the label: "Off: items here cannot link to items in another hub." */
  description?: string
  labelHidden?: boolean
  /**
   * loading: a placeholder until the value arrives. error: the value failed to load, so there is
   * no switch to flip (saving a guess would overwrite the real value). no-permission: shown but
   * read-only, with the reason in text. A boolean is never empty, so there is no empty state.
   */
  state?: 'ready' | 'loading' | 'error' | 'no-permission'
  /** Why the reader cannot change it. Defaults to a plain sentence. */
  reason?: string
  disabled?: boolean
}>()

const id = useId()
const labelId = `${id}-label`
const descId = `${id}-desc`
const reasonId = `${id}-reason`
const readOnly = computed(() => state === 'no-permission')
const shownReason = computed(() =>
  readOnly.value ? reason || 'You can view this but not change it.' : '',
)
const describedBy = computed(
  () =>
    [description && !labelHidden && descId, shownReason.value && reasonId]
      .filter(Boolean)
      .join(' ') || undefined,
)

function flip() {
  if (disabled || readOnly.value) return
  model.value = !model.value
}
</script>

<template>
  <div
    :class="['flex min-h-8 items-center gap-4', !labelHidden && 'justify-between']"
    :data-state="state"
  >
    <span v-if="!labelHidden" class="flex min-w-0 flex-col">
      <span :id="labelId" :class="disabled || readOnly ? 'text-ink3' : 'text-ink'">{{
        label
      }}</span>
      <span v-if="description" :id="descId" class="text-secondary text-ink3">{{
        description
      }}</span>
      <span v-if="shownReason" :id="reasonId" class="text-secondary text-ink3">{{
        shownReason
      }}</span>
    </span>
    <span v-else-if="shownReason" :id="reasonId" class="sr-only">{{ shownReason }}</span>

    <ValueState v-if="state === 'loading'" state="loading" :label="`Loading ${label}`" />
    <ValueState v-else-if="state === 'error'" state="error" :label="`${label} could not load`" />
    <!-- A switch is a button with role=switch: Space and Enter flip it, and it reads as on or
         off. Off uses the --line3 track, which keeps 3:1 against the page; on uses --accent.
         The knob's side says the state too, so it is never colour alone. -->
    <button
      v-else
      v-bind="$attrs"
      type="button"
      role="switch"
      :aria-checked="model ? 'true' : 'false'"
      :aria-labelledby="labelHidden ? undefined : labelId"
      :aria-label="labelHidden ? label : undefined"
      :aria-describedby="describedBy"
      :aria-disabled="readOnly ? 'true' : undefined"
      :disabled="disabled"
      :class="[
        'inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border-0 p-0.5',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed',
        model ? 'justify-end bg-accent' : 'justify-start bg-line3',
        readOnly && 'opacity-60',
      ]"
      @click="flip"
    >
      <span
        aria-hidden="true"
        :class="['block size-3.5 rounded-full', model ? 'bg-on-accent' : 'bg-bg']"
      />
    </button>
  </div>
</template>
