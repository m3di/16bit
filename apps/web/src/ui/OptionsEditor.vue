<script setup lang="ts">
import type { PaletteColor, SelectOption } from '@16bit/core'
import { computed, nextTick, ref, useId, useTemplateRef } from 'vue'
import BaseButton from './BaseButton.vue'
import BaseInput from './BaseInput.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import PaletteChip from './PaletteChip.vue'
import PalettePicker from './PalettePicker.vue'
import { paletteVar } from './palette.ts'
import RowActionsMenu, { type RowAction } from './RowActionsMenu.vue'
import {
  MAX_OPTIONS,
  moveOption,
  newOptionId,
  nextOptionColor,
  optionErrors,
  itemCount,
  removeOptionMessage,
} from './settings.ts'
import StateBlock from './StateBlock.vue'

const model = defineModel<SelectOption[]>({ default: () => [] })

const {
  label = 'Options',
  usage = {},
  state = 'ready',
  reason = '',
} = defineProps<{
  label?: string
  /** How many items use each option, by option ID. Removing a used option asks first (D51). */
  usage?: Readonly<Record<string, number>>
  /**
   * loading and error: a StateBlock instead of the list, so options that failed to load are
   * never saved as an empty list. no-permission: the options as chips, read-only, with the
   * reason. An empty list is the empty state, with a way to add the first option.
   */
  state?: 'ready' | 'loading' | 'error' | 'no-permission'
  reason?: string
}>()

defineSlots<{ 'error-action'?(): unknown }>()

const id = useId()
const root = useTemplateRef<HTMLElement>('root')
const errors = computed(() => optionErrors(model.value))
const openColor = ref<string | null>(null)
const pendingRemove = ref<SelectOption | null>(null)
const confirmOpen = ref(false)

const colourNames = (c: PaletteColor | undefined) =>
  c ? c.charAt(0).toUpperCase() + c.slice(1) : 'No colour'

function update(index: number, patch: Partial<SelectOption>) {
  model.value = model.value.map((o, i) => {
    if (i !== index) return o
    const next = { ...o, ...patch }
    // Core leaves `color` out rather than null.
    if (next.color === undefined) delete next.color
    return next
  })
}

function setColor(index: number, color: PaletteColor | null) {
  update(index, { color: color ?? undefined })
}

async function focusInput(optionId: string | undefined) {
  await nextTick()
  const target = optionId
    ? root.value?.querySelector<HTMLInputElement>(`[data-option-input="${optionId}"]`)
    : root.value?.querySelector<HTMLElement>('[data-option-add]')
  target?.focus()
}

async function add() {
  if (model.value.length >= MAX_OPTIONS) return
  const option: SelectOption = {
    id: newOptionId(model.value),
    label: '',
    color: nextOptionColor(model.value),
  }
  model.value = [...model.value, option]
  await focusInput(option.id)
}

function actionsFor(index: number): RowAction[] {
  return [
    { key: 'up', label: 'Move up', disabled: index === 0, reason: 'Already first' },
    {
      key: 'down',
      label: 'Move down',
      disabled: index === model.value.length - 1,
      reason: 'Already last',
    },
    { key: 'remove', label: 'Remove option', danger: true },
  ]
}

function onAction(index: number, key: string) {
  const option = model.value[index]
  if (!option) return
  if (key === 'up' || key === 'down') {
    model.value = moveOption(model.value, index, key === 'up' ? -1 : 1)
    return
  }
  if ((usage[option.id] ?? 0) > 0) {
    pendingRemove.value = option
    confirmOpen.value = true
    return
  }
  void remove(option)
}

async function remove(option: SelectOption) {
  const index = model.value.findIndex((o) => o.id === option.id)
  // Read the new list from here: the model only shows it once the parent has taken it.
  const rest = model.value.filter((o) => o.id !== option.id)
  model.value = rest
  confirmOpen.value = false
  pendingRemove.value = null
  // Focus moves to the row that took its place, else the one before, else Add option.
  const next = rest[index] ?? rest[index - 1]
  await focusInput(next?.id)
}

const pendingMessage = computed(() => {
  const option = pendingRemove.value
  if (!option) return ''
  return removeOptionMessage(usage[option.id] ?? 0)
})
</script>

<template>
  <div ref="root" class="flex flex-col gap-2" :data-state="state">
    <span :id="`${id}-label`" class="text-secondary text-ink3">{{ label }}</span>

    <StateBlock v-if="state === 'loading'" state="loading" :rows="3" />
    <StateBlock
      v-else-if="state === 'error'"
      state="error"
      title="Options could not load"
      message="Nothing was changed. Try again in a moment."
    >
      <template v-if="$slots['error-action']" #action><slot name="error-action" /></template>
    </StateBlock>

    <template v-else-if="state === 'no-permission'">
      <ul
        v-if="model.length"
        :aria-labelledby="`${id}-label`"
        class="m-0 flex list-none flex-wrap gap-1.5 p-0"
      >
        <li v-for="o in model" :key="o.id">
          <PaletteChip :color="o.color ?? 'grey'">{{ o.label }}</PaletteChip>
        </li>
      </ul>
      <span v-else class="text-ink3">No options</span>
      <span class="text-secondary text-ink3">{{
        reason || 'You can view these but not change them.'
      }}</span>
    </template>

    <template v-else>
      <p v-if="model.length === 0" class="m-0 text-secondary text-ink2">
        No options yet. Items can only pick from this list, so add at least one.
      </p>
      <ol v-else :aria-labelledby="`${id}-label`" class="m-0 flex list-none flex-col p-0">
        <li
          v-for="(o, i) in model"
          :key="o.id"
          class="flex flex-col gap-2 border-b border-line py-1.5"
          :data-option="o.id"
        >
          <div class="flex items-start gap-2">
            <!-- A disclosure: the palette opens under the row, in the page flow. -->
            <button
              type="button"
              :aria-expanded="openColor === o.id ? 'true' : 'false'"
              :aria-controls="`${id}-${o.id}-colour`"
              :aria-label="`Colour for option ${i + 1}: ${colourNames(o.color)}`"
              class="mt-2 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-chip p-0"
              :class="o.color ? 'border-0' : 'border border-dashed border-line3 bg-transparent'"
              :style="o.color ? { background: paletteVar(o.color) } : undefined"
              @click="openColor = openColor === o.id ? null : o.id"
            />
            <div class="min-w-0 flex-1">
              <BaseInput
                :model-value="o.label"
                :label="`Name of option ${i + 1}`"
                label-hidden
                :error="errors[o.id] ?? ''"
                :data-option-input="o.id"
                maxlength="200"
                @update:model-value="update(i, { label: $event })"
              />
            </div>
            <span
              v-if="usage[o.id] !== undefined"
              class="mt-2 shrink-0 text-secondary whitespace-nowrap text-ink3"
              >{{ itemCount(usage[o.id] ?? 0) }}</span
            >
            <span class="mt-0.5 shrink-0">
              <RowActionsMenu
                :label="`Actions for option ${i + 1}${o.label ? `, ${o.label}` : ''}`"
                :items="actionsFor(i)"
                @select="onAction(i, $event)"
              />
            </span>
          </div>
          <div v-if="openColor === o.id" :id="`${id}-${o.id}-colour`" class="pb-1 pl-6">
            <PalettePicker
              :model-value="o.color ?? null"
              :label="`Colour for option ${i + 1}`"
              label-hidden
              allow-none
              size="sm"
              @update:model-value="setColor(i, $event)"
            />
          </div>
        </li>
      </ol>
      <div class="flex flex-wrap items-center gap-3">
        <BaseButton size="sm" data-option-add :disabled="model.length >= MAX_OPTIONS" @click="add"
          >Add option</BaseButton
        >
        <span v-if="model.length >= MAX_OPTIONS" class="text-secondary text-ink3"
          >{{ MAX_OPTIONS }} options is the most a list can hold.</span
        >
      </div>
    </template>

    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="`Remove ${pendingRemove?.label || 'this option'}?`"
      :message="pendingMessage"
      confirm-label="Remove option"
      @confirm="pendingRemove && remove(pendingRemove)"
    />
  </div>
</template>
