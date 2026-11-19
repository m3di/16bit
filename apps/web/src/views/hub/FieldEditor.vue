<script setup lang="ts">
import type { Attribute, ItemValues } from '@16bit/core'
import { computed, ref, watch } from 'vue'
import { BaseInput, BaseSelect, CheckboxField, ValueState } from '../../ui/index.ts'
import ActorEditor from './ActorEditor.vue'
import MultiSelectEditor from './MultiSelectEditor.vue'
import RelationEditor from './RelationEditor.vue'
import { listValue } from './relations.ts'
import RichTextField from './RichTextField.vue'
import { formatValue, fromInput, toInput } from './values.ts'

type Value = ItemValues[string] | undefined

const {
  attribute,
  value,
  required,
  error = '',
  disabled,
  readOnly,
  itemId = null,
} = defineProps<{
  attribute: Attribute
  value: Value
  required?: boolean
  /** From the server or from local validation. */
  error?: string
  disabled?: boolean
  /** The reader can see the value but not change it (a 403 from the server). */
  readOnly?: boolean
  /** The item being edited; `null` in the new item form. */
  itemId?: string | null
}>()

const emit = defineEmits<{ commit: [value: ItemValues[string]] }>()

// The input holds a draft. It follows the value whenever the value changes, which is how a
// rolled-back edit becomes visible.
const draft = ref(toInput(attribute, value))
const localError = ref('')
watch(
  () => toInput(attribute, value),
  (text) => {
    draft.value = text
    localError.value = ''
  },
)

function commit() {
  const parsed = fromInput(attribute, draft.value)
  if (!parsed.ok) {
    localError.value = parsed.message
    return
  }
  localError.value = ''
  if (draft.value === toInput(attribute, value)) return
  emit('commit', parsed.value)
}

const list = computed(() => listValue(value))
const readOnlyHint = 'You can view this but not change it.'

const label = computed(() => (required ? `${attribute.name} (required)` : attribute.name))
const shownError = computed(() => localError.value || error)

const selectOptions = computed(() =>
  attribute.type === 'select'
    ? [
        { value: '', label: 'None' },
        ...attribute.config.options.map((o) => ({ value: o.id, label: o.label })),
      ]
    : [],
)

const inputType = computed(() => {
  if (attribute.type === 'number') return 'number'
  if (attribute.type === 'url') return 'url'
  if (attribute.type === 'date') return attribute.config.includeTime ? 'datetime-local' : 'date'
  return 'text'
})

// The Enter that picks an IME candidate is not a save: the composed text is not in the draft
// yet. Safari reports it as keyCode 229 without isComposing.
function onEnter(event: KeyboardEvent) {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- 229 is how Safari marks it
  if (event.isComposing || event.keyCode === 229) return
  commit()
}

function onToggle(checked: boolean) {
  draft.value = String(checked)
  commit()
}
</script>

<template>
  <!-- The server assigns auto IDs; clients never send one (core: read_only). -->
  <div v-if="attribute.type === 'auto_id'" class="flex flex-col gap-1" data-auto-id>
    <span class="text-secondary text-ink3">{{ attribute.name }}</span>
    <span
      v-if="formatValue(attribute, value)"
      class="flex min-h-8 items-center font-mono text-secondary text-ink"
      >{{ formatValue(attribute, value) }}</span
    >
    <span v-else-if="itemId === null" class="flex min-h-8 items-center text-ink3"
      >Assigned when the item is created</span
    >
    <!-- Items created before the field was added have no number. -->
    <span v-else class="flex min-h-8 items-center"><ValueState state="empty" /></span>
  </div>
  <MultiSelectEditor
    v-else-if="attribute.type === 'multi_select'"
    :config="attribute.config"
    :value="list"
    :label="label"
    :error="shownError"
    :disabled="disabled"
    :read-only="readOnly"
    @commit="emit('commit', $event)"
  />
  <ActorEditor
    v-else-if="attribute.type === 'actor'"
    :config="attribute.config"
    :value="list"
    :label="label"
    :error="shownError"
    :disabled="disabled"
    :read-only="readOnly"
    @commit="emit('commit', $event)"
  />
  <RelationEditor
    v-else-if="attribute.type === 'relation'"
    :item-id="itemId"
    :config="attribute.config"
    :value="list"
    :label="label"
    :error="shownError"
    :disabled="disabled"
    :read-only="readOnly"
    @commit="emit('commit', $event)"
  />
  <RichTextField
    v-else-if="attribute.type === 'rich_text'"
    :value="value"
    :label="label"
    :error="shownError"
    :disabled="disabled"
    :read-only="readOnly"
    @commit="emit('commit', $event)"
  />
  <CheckboxField
    v-else-if="attribute.type === 'boolean'"
    :model-value="draft === 'true'"
    :label="label"
    :error="shownError"
    :disabled="disabled"
    :state="readOnly ? 'no-permission' : 'ready'"
    @update:model-value="onToggle"
  />
  <BaseSelect
    v-else-if="attribute.type === 'select'"
    v-model="draft"
    :label="label"
    :options="selectOptions"
    :error="shownError"
    :hint="readOnly ? readOnlyHint : ''"
    :disabled="disabled || readOnly"
    @change="commit"
  />
  <BaseInput
    v-else
    v-model="draft"
    :label="label"
    :type="inputType"
    :error="shownError"
    :hint="readOnly ? readOnlyHint : ''"
    :disabled="disabled || readOnly"
    @change="commit"
    @keydown.enter="onEnter"
  />
</template>
