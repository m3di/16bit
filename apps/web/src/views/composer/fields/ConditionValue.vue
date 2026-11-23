<script setup lang="ts">
import { computed } from 'vue'
import { BaseInput, BaseSelect, CheckboxField } from '../../../ui/index.ts'
import { representable, type ValueEditor } from '../conditions.ts'
import { asText } from '../options.ts'
import { stableJson } from '../tree.ts'

// One condition's value, edited as its attribute type and operator say (see `valueEditor`).
const { editor, label } = defineProps<{ editor: ValueEditor; label: string }>()
const model = defineModel<unknown>()

const shown = computed(() => representable(editor, model.value))
const listValue = (): unknown[] => (Array.isArray(model.value) ? (model.value as unknown[]) : [])

// many: the chosen choices, plus free entries typed as a comma-separated list.
const chosen = (value: unknown) =>
  Array.isArray(model.value) && model.value.some((v) => stableJson(v) === stableJson(value))
function toggle(value: unknown, on: boolean) {
  const list = listValue()
  const rest = list.filter((v) => stableJson(v) !== stableJson(value))
  model.value = on ? [...rest, value] : rest
}
const free = computed({
  get: () => {
    if (editor.kind !== 'many' || !Array.isArray(model.value)) return ''
    const choices = editor.choices.map((c) => stableJson(c.value))
    return model.value
      .filter((v) => !choices.includes(stableJson(v)))
      .map(String)
      .join(', ')
  },
  set: (text: string) => {
    if (editor.kind !== 'many') return
    const list = listValue()
    const choices = editor.choices.map((c) => stableJson(c.value))
    const kept = list.filter((v) => choices.includes(stableJson(v)))
    const typed = text
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (editor.free === 'number' && Number.isFinite(Number(t)) ? Number(t) : t))
    model.value = [...kept, ...typed]
  },
})

const one = computed({
  get: () => {
    if (editor.kind !== 'one-of') return ''
    return editor.choices.find((c) => stableJson(c.value) === stableJson(model.value))?.key ?? ''
  },
  set: (key: string) => {
    if (editor.kind !== 'one-of') return
    model.value = editor.choices.find((c) => c.key === key)?.value
  },
})
const oneOptions = computed(() =>
  editor.kind === 'one-of'
    ? [
        { value: '', label: 'Choose…' },
        ...editor.choices.map((c) => ({ value: c.key, label: c.label })),
      ]
    : [],
)

const input = computed({
  get: () => asText(model.value),
  set: (text: string) => {
    if (editor.kind !== 'input') return
    if (text.trim() === '') model.value = undefined
    else if (editor.input === 'number' && Number.isFinite(Number(text))) model.value = Number(text)
    else model.value = text
  },
})
</script>

<template>
  <p v-if="!shown" class="m-0 self-center text-secondary text-ink3" data-condition-json>
    Set in JSON: {{ JSON.stringify(model) }}
  </p>
  <fieldset v-else-if="editor.kind === 'many'" class="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
    <legend class="sr-only">{{ label }}</legend>
    <CheckboxField
      v-for="c in editor.choices"
      :key="c.key"
      :model-value="chosen(c.value)"
      :label="c.label"
      @update:model-value="toggle(c.value, $event)"
    />
    <BaseInput
      v-if="editor.free"
      v-model="free"
      :label="editor.choices.length ? 'Or these IDs, comma separated' : `${label}, comma separated`"
      :mono="editor.free === 'text'"
    />
  </fieldset>
  <BaseSelect
    v-else-if="editor.kind === 'one-of'"
    v-model="one"
    :label="label"
    :options="oneOptions"
  />
  <BaseInput
    v-else-if="editor.kind === 'input'"
    v-model="input"
    :label="label"
    :type="editor.input"
  />
</template>
