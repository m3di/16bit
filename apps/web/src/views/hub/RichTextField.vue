<script setup lang="ts">
import type { ItemValues } from '@16bit/core'
import { computed, defineAsyncComponent, h } from 'vue'
import {
  FormNotice,
  isRichTextEmpty,
  normalizeRichText,
  richTextToPlain,
  ValueState,
} from '../../ui/index.ts'
import { excerpt, incomingNote, useFieldDraft } from './field-draft.ts'

// Tiptap stays out of the main bundle (docs/DESIGN.md): the editor loads when a field needs it.
const RichTextEditor = defineAsyncComponent({
  loader: () => import('../../ui/RichTextEditor.vue'),
  loadingComponent: { render: () => h(ValueState, { state: 'loading' }) },
  errorComponent: {
    render: () => h(ValueState, { state: 'error', label: 'The editor could not be loaded' }),
  },
  delay: 0,
  suspensible: false,
})

const {
  value,
  label,
  error = '',
  disabled,
  readOnly,
  version = null,
  changedBy = 'Someone else',
} = defineProps<{
  value: unknown
  label: string
  error?: string
  disabled?: boolean
  readOnly?: boolean
  /** The item's version, so a save says which version the reader's draft was based on. */
  version?: number | null
  /** Who changed the item last, by name, for "Changed by … while you were editing". */
  changedBy?: string
}>()

/** `basedOn`: the item version the draft started from, so a change since is a 409 (D60). */
const emit = defineEmits<{ commit: [value: ItemValues[string], basedOn: number | null] }>()

const key = (doc: unknown) => JSON.stringify(normalizeRichText(doc))

// The editor edits a draft, saved when it loses focus. Like the other fields (D60), it follows
// the value until the reader changes it, and then keeps what they wrote when a change arrives.
const { draft, incoming, take } = useFieldDraft<unknown>({
  shown: () => value,
  key,
  version: () => version,
  changedBy: () => changedBy,
})
const incomingText = computed(() =>
  incoming.value ? excerpt(richTextToPlain(normalizeRichText(incoming.value.value))) : '',
)

function commit() {
  if (disabled) return
  const doc = normalizeRichText(draft.value)
  const taken = take()
  if (taken)
    emit('commit', isRichTextEmpty(doc) ? null : (doc as ItemValues[string]), taken.basedOn)
}
</script>

<template>
  <RichTextEditor
    v-model="draft"
    :label="label"
    :error="error"
    :state="readOnly ? 'no-permission' : 'ready'"
    @blur="commit"
  />
  <FormNotice v-if="incoming" tone="info" data-changed-while-editing>
    {{ incomingNote(incoming, incomingText) }}
  </FormNotice>
</template>
