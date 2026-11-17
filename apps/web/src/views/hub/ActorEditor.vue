<script setup lang="ts">
import type { ActorConfig } from '@16bit/core'
import { computed, ref, useId } from 'vue'
import { BaseButton, BaseSelect } from '../../ui/index.ts'
import ActorValue from './ActorValue.vue'
import { useValueContext } from './context.ts'
import { toggled } from './relations.ts'

const {
  config,
  value,
  label,
  error = '',
  disabled,
  readOnly,
} = defineProps<{
  config: ActorConfig
  value: readonly string[]
  label: string
  error?: string
  disabled?: boolean
  readOnly?: boolean
}>()

const emit = defineEmits<{ commit: [value: string[] | null] }>()

const ctx = useValueContext()
const id = useId()
const errorId = `${id}-error`
const pick = ref('')

const members = computed(() => ctx.members())
const options = computed(() => {
  const free = ctx.actorChoices().filter((a) => !value.includes(a.id))
  const first =
    members.value.state === 'loading'
      ? 'Loading people…'
      : free.length === 0
        ? 'No one else to add'
        : config.multiple || value.length === 0
          ? 'Add a person…'
          : 'Replace with…'
  return [
    { value: '', label: first, disabled: true },
    ...free.map((a) => ({ value: a.id, label: a.kind === 'agent' ? `${a.name} (agent)` : a.name })),
  ]
})

function add() {
  if (!pick.value) return
  const next = toggled(value, pick.value, true, config.multiple)
  pick.value = ''
  emit('commit', next)
}
function remove(principal: string) {
  emit('commit', toggled(value, principal, false))
}
</script>

<template>
  <div
    role="group"
    :aria-labelledby="`${id}-label`"
    :aria-describedby="error ? errorId : undefined"
    class="flex min-w-0 flex-col gap-1"
  >
    <span :id="`${id}-label`" class="text-secondary text-ink3">{{ label }}</span>
    <ActorValue :ids="value" :label="label" :removable="!readOnly && !disabled" @remove="remove" />
    <span v-if="readOnly" class="text-secondary text-ink3"
      >You can view this but not change it.</span
    >
    <template v-else>
      <BaseSelect
        v-model="pick"
        :label="`Add to ${label}`"
        label-hidden
        :options="options"
        :disabled="disabled || options.length === 1"
        data-actor-pick
        @change="add"
      />
      <span v-if="members.state === 'unavailable'" class="text-secondary text-ink3"
        >The member list is not available yet, so only you can be added.</span
      >
      <span
        v-else-if="members.state === 'error'"
        class="flex flex-wrap items-center gap-2 text-secondary text-danger"
      >
        People could not be loaded. {{ members.error.message }}
        <BaseButton size="sm" variant="quiet" @click="ctx.retryMembers()">Try again</BaseButton>
      </span>
    </template>
    <span v-if="error" :id="errorId" class="text-secondary text-danger">{{ error }}</span>
  </div>
</template>
