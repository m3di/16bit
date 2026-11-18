<script setup lang="ts">
import type { AttributeTypeName } from '@16bit/core'
import { computed, useId } from 'vue'
import { ATTRIBUTE_TYPE_INFO, ATTRIBUTE_TYPE_ORDER } from './settings.ts'
import ValueState from './ValueState.vue'

const model = defineModel<AttributeTypeName | null>({ default: null })

const {
  label = 'Type',
  types = ATTRIBUTE_TYPE_ORDER,
  locked,
  state = 'ready',
  reason = '',
  error = '',
} = defineProps<{
  label?: string
  /** Which types to offer, in this order. Defaults to every type core has. */
  types?: readonly AttributeTypeName[]
  /**
   * The attribute exists, so its type is fixed (D51). Shows the type as text with the reason,
   * never as a choice.
   */
  locked?: boolean
  /**
   * loading and error: no choices yet. no-permission: the current type as text with the reason.
   * Nothing chosen is the empty state: no radio is checked and the first takes focus.
   */
  state?: 'ready' | 'loading' | 'error' | 'no-permission'
  reason?: string
  /** Shown under the choices, such as "Choose a type." */
  error?: string
}>()

const id = useId()
const name = `${id}-type`
const errorId = `${id}-error`
const readOnly = computed(() => locked || state === 'no-permission')
const readOnlyReason = computed(
  () =>
    reason ||
    (locked
      ? 'The type cannot change once the attribute exists. To use another type, add a new attribute.'
      : 'You can view this but not change it.'),
)
</script>

<template>
  <div class="flex flex-col gap-1" :data-state="locked ? 'locked' : state">
    <template v-if="state === 'loading' || state === 'error' || readOnly">
      <span class="text-secondary text-ink3">{{ label }}</span>
      <ValueState v-if="state === 'loading'" state="loading" :label="`Loading ${label}`" />
      <ValueState v-else-if="state === 'error'" state="error" />
      <template v-else>
        <span class="text-ink">{{ model ? ATTRIBUTE_TYPE_INFO[model].label : 'No type' }}</span>
        <span class="text-secondary text-ink3">{{ readOnlyReason }}</span>
      </template>
    </template>

    <!-- A fieldset of native radios: one tab stop, arrow keys choose, and the legend names the
         group. Each choice is a hairline row with the type's name and a one-line hint. -->
    <fieldset
      v-else
      class="m-0 flex min-w-0 flex-col gap-1 border-0 p-0"
      :aria-describedby="error ? errorId : undefined"
      :aria-invalid="error ? 'true' : undefined"
    >
      <legend class="mb-1 p-0 text-secondary text-ink3">{{ label }}</legend>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-1.5">
        <label
          v-for="t in types"
          :key="t"
          class="flex min-h-9 cursor-pointer items-start gap-2 rounded-control border border-line2 px-2.5 py-2 hover:bg-surface has-checked:border-line3 has-checked:bg-selected"
        >
          <input
            type="radio"
            :name="name"
            :value="t"
            :checked="model === t"
            class="m-0 mt-0.5 size-3.5 shrink-0 cursor-pointer accent-accent"
            :aria-labelledby="`${id}-${t}-name`"
            :aria-describedby="`${id}-${t}-hint`"
            @change="model = t"
          />
          <span class="flex min-w-0 flex-col">
            <span
              :id="`${id}-${t}-name`"
              :class="model === t ? 'font-medium text-ink' : 'text-ink'"
              >{{ ATTRIBUTE_TYPE_INFO[t].label }}</span
            >
            <span :id="`${id}-${t}-hint`" class="text-secondary text-ink3">{{
              ATTRIBUTE_TYPE_INFO[t].hint
            }}</span>
          </span>
        </label>
      </div>
      <span v-if="error" :id="errorId" class="text-secondary text-danger">{{ error }}</span>
    </fieldset>
  </div>
</template>
