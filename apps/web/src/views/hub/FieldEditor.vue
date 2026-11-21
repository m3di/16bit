<script setup lang="ts">
import type { Attribute, ItemValues } from '@16bit/core'
import { computed, ref, watch } from 'vue'
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

// The input holds a draft. While the reader has not changed it, it follows the value, which is
// how a rolled-back edit becomes visible. Once they have typed, a change from someone else does
// not replace what they typed: it is shown beside the field, and their save goes out against
// the version they started from, so it meets the usual conflict (D60, decided by the maintainer
// during M3).
const shownText = () => toInput(attribute, value)
const display = (text: string) => (text === '' ? 'no value' : `“${text}”`)
const draft = ref(shownText())
/** The text the draft last followed, and the item version then: what an edit is based on. */
let synced = { text: draft.value, version }
const localError = ref('')
/** Someone else's value that arrived while the reader was typing. */
const incoming = ref<{ text: string; by: string } | null>(null)
const typing = () => draft.value !== synced.text

function follow(text: string) {
  draft.value = text
  synced = { text, version }
  incoming.value = null
  localError.value = ''
}

watch(shownText, (text) => {
  if (version !== null && typing() && text !== draft.value) {
    incoming.value = { text, by: changedBy }
    return
  }
  follow(text)
})

// A newer version that leaves this field as it was (another field changed, or the reader's
// own save came back) moves the base along: only a change to this field makes a conflict.
watch(
  () => version,
  (now) => {
    if (shownText() === synced.text) synced = { ...synced, version: now }
  },
)

function commit() {
  const parsed = fromInput(attribute, draft.value)
  if (!parsed.ok) {
    localError.value = parsed.message
    return
  }
  localError.value = ''
  if (draft.value === synced.text) {
    // Unchanged after all: someone else's value, if one came, is simply shown.
    if (incoming.value) follow(shownText())
    return
  }
  const basedOn = synced.version
  incoming.value = null
  // From here the draft follows the value again, so a rolled-back edit shows.
  synced = { text: draft.value, version: basedOn }
  emit('commit', parsed.value, basedOn)
}

/** Saves the refused value again, over the value now shown. */
function keepMine() {
  if (!refused) return
  synced = { text: shownText(), version }
  draft.value = toInput(attribute, refused.value)
  commit()
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
  <!-- Notes about other people's changes, for the fields that keep a typed draft. -->
  <FormNotice v-if="incoming" tone="info" data-changed-while-editing>
    Changed by {{ incoming.by }} while you were editing: {{ display(incoming.text) }}. Saving yours
    will ask which to keep.
  </FormNotice>
  <FormNotice v-if="refused" tone="info" data-refused-draft>
    {{ refused.by }} changed {{ attribute.name }} while you were editing, so your value
    {{ display(toInput(attribute, refused.value)) }} was not saved. Theirs is shown.
    <template #action>
      <span class="flex flex-wrap gap-2">
        <BaseButton size="sm" variant="outline" @click="keepMine">Keep mine</BaseButton>
        <BaseButton size="sm" variant="quiet" @click="emit('dismissRefused')"
          >Use theirs</BaseButton
        >
      </span>
    </template>
  </FormNotice>
</template>
