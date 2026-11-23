<script setup lang="ts">
import type { Attribute, ItemValues } from '@16bit/core'
import { computed, ref, useTemplateRef } from 'vue'
import {
  BaseButton,
  BaseInput,
  BaseSelect,
  CheckboxField,
  FormNotice,
  ValueState,
} from '../../ui/index.ts'
import ActorEditor from './ActorEditor.vue'
import MultiSelectEditor from './MultiSelectEditor.vue'
import RelationEditor from './RelationEditor.vue'
import { listValue } from './relations.ts'
import RichTextField from './RichTextField.vue'
import { incomingNote, quoted, richTextExcerpt, useFieldDraft } from './field-draft.ts'
import { formatValue, fromInput, hasOwnEditor, toInput } from './values.ts'

type Value = ItemValues[string] | undefined

const {
  attribute,
  value,
  required,
  error = '',
  disabled,
  readOnly,
  itemId = null,
  version = null,
  changedBy = 'Someone else',
  refused = null,
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
  /** The item's version, so a save says which version the reader's edit was based on. */
  version?: number | null
  /** Who changed the item last, by name, for "Changed by … while you were editing". */
  changedBy?: string
  /** The reader's value a conflict refused (a 409), offered back to them, and who changed it. */
  refused?: { value: ItemValues[string]; by: string } | null
}>()

/** `basedOn`: the item version the edit started from, so a change since is a 409 (D60). */
const emit = defineEmits<{
  commit: [value: ItemValues[string], basedOn: number | null]
  /** The reader keeps the other value after a conflict. */
  dismissRefused: []
}>()

const localError = ref('')
// The input holds a draft that keeps what the reader typed when a change arrives (D60).
const shownText = () => toInput(attribute, value)
const { draft, incoming, take, rebase } = useFieldDraft({
  shown: shownText,
  key: (text) => text,
  version: () => version,
  changedBy: () => changedBy,
  onFollow: () => {
    localError.value = ''
  },
})

function commit() {
  const parsed = fromInput(attribute, draft.value)
  if (!parsed.ok) {
    localError.value = parsed.message
    return
  }
  localError.value = ''
  const taken = take()
  if (taken) emit('commit', parsed.value, taken.basedOn)
}

const richEditor = useTemplateRef<InstanceType<typeof RichTextField>>('richEditor')

/** Saves the refused value again, over the value now shown, which the reader has seen. */
function keepMine() {
  if (!refused) return
  // Fields with their own editor (rich text, lists) save a whole value, not input text.
  if (hasOwnEditor(attribute)) {
    // Whatever was written since is replaced, so the save is not taken for a failed one.
    richEditor.value?.reset(refused.value)
    emit('commit', refused.value, version)
    return
  }
  rebase()
  draft.value = toInput(attribute, refused.value)
  commit()
}

/** A value as the conflict note quotes it, or `null` where a quote would only be IDs. */
function quote(v: ItemValues[string]): string | null {
  switch (attribute.type) {
    case 'actor':
    case 'relation':
      return null
    case 'multi_select':
      return quoted(formatValue(attribute, v))
    case 'rich_text':
      return quoted(richTextExcerpt(v))
    default:
      return quoted(toInput(attribute, v))
  }
}
const refusedQuote = computed(() => (refused ? quote(refused.value) : null))

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
    ref="richEditor"
    :value="value"
    :label="label"
    :error="shownError"
    :disabled="disabled"
    :read-only="readOnly"
    :version="version"
    :changed-by="changedBy"
    @commit="(v, basedOn) => emit('commit', v, basedOn)"
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
  <!-- Rich text keeps its own draft and shows its own note, in RichTextField. -->
  <FormNotice v-if="incoming" tone="info" data-changed-while-editing>
    {{ incomingNote(incoming, incoming.value) }}
  </FormNotice>
  <FormNotice v-if="refused" tone="info" data-refused-draft>
    {{ refused.by }} changed this item while you were editing, so your {{ attribute.name }}
    {{ refusedQuote ?? 'value' }} was not saved. The latest value is shown.
    <template #action>
      <span class="flex flex-wrap gap-2">
        <BaseButton size="sm" variant="outline" @click="keepMine">Keep mine</BaseButton>
        <BaseButton size="sm" variant="quiet" @click="emit('dismissRefused')"
          >Use latest</BaseButton
        >
      </span>
    </template>
  </FormNotice>
</template>
