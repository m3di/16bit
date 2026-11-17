<script setup lang="ts">
import type { ItemValues } from '@16bit/core'
import { defineAsyncComponent, h, ref, watch } from 'vue'
import { isRichTextEmpty, normalizeRichText, ValueState } from '../../ui/index.ts'

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
} = defineProps<{
  value: unknown
  label: string
  error?: string
  disabled?: boolean
  readOnly?: boolean
}>()

const emit = defineEmits<{ commit: [value: ItemValues[string]] }>()

const key = (doc: unknown) => JSON.stringify(normalizeRichText(doc))

// The editor edits a draft. It is saved when the editor loses focus, and follows the value
// when that changes from outside, which is how a rolled-back save becomes visible.
const draft = ref<unknown>(value)
watch(
  () => key(value),
  () => {
    draft.value = value
  },
)

function commit() {
  if (disabled || key(draft.value) === key(value)) return
  const doc = normalizeRichText(draft.value)
  emit('commit', isRichTextEmpty(doc) ? null : (doc as ItemValues[string]))
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
</template>
