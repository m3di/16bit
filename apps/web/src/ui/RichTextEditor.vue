<script setup lang="ts">
import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import CodeBlock from '@tiptap/extension-code-block'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Heading from '@tiptap/extension-heading'
import Italic from '@tiptap/extension-italic'
import Link from '@tiptap/extension-link'
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { Placeholder, UndoRedo } from '@tiptap/extensions'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import { HEADING_LEVELS, normalizeRichText, safeHref, type RichDoc } from './rich-text.ts'
import { editorLinkAttributes, RICH_CLASSES as C } from './rich-text-classes.ts'
import RichTextView from './RichTextView.vue'
import { rovingIndex } from './roving.ts'
import ValueState from './ValueState.vue'

const model = defineModel<unknown>()

const {
  label,
  hint = '',
  error = '',
  placeholder = '',
  state = 'ready',
} = defineProps<{
  label: string
  hint?: string
  /** Shown under the editor. Marks it invalid. */
  error?: string
  /** Shown while the document is empty: the editor's empty state. */
  placeholder?: string
  /**
   * loading: a placeholder until the value arrives. error: the value failed to load, so there
   * is no editor (saving into a blank one would overwrite the real document). no-permission:
   * the document, read-only.
   */
  state?: 'ready' | 'loading' | 'error' | 'no-permission'
}>()

const emit = defineEmits<{ blur: [] }>()

const id = useId()
const labelId = `${id}-label`
const hintId = `${id}-hint`
const errorId = `${id}-error`
// Links inside the editable document cannot hold extra text, so each one points here for the
// "opens in a new tab" note that RichTextView and UrlLink put inside the link.
const newTabId = `${id}-new-tab`
const noInput = computed(() => state === 'loading' || state === 'error')
const shownHint = computed(() =>
  state === 'no-permission' ? hint || 'You can view this but not change it.' : hint,
)
const describedBy = computed(
  () => [shownHint.value && hintId, error && errorId].filter(Boolean).join(' ') || undefined,
)

const serialize = (doc: RichDoc) => JSON.stringify(doc)
// ProseMirror needs at least one block to place the cursor and the placeholder in.
const forEditor = (doc: RichDoc): RichDoc =>
  doc.content.length ? doc : { type: 'doc', content: [{ type: 'paragraph' }] }

const attributes = computed((): Record<string, string> => ({
  role: 'textbox',
  'aria-multiline': 'true',
  'aria-labelledby': labelId,
  ...(describedBy.value ? { 'aria-describedby': describedBy.value } : {}),
  ...(error ? { 'aria-invalid': 'true' } : {}),
  class: `${C.root} rich-editor min-h-20 px-2 py-1.5 outline-none`,
}))

// Only the closed node set is registered, so pasted content outside it is dropped by the
// schema, and what the editor emits is normalised once more on the way out.
const editor = useEditor({
  content: forEditor(normalizeRichText(model.value)),
  extensions: [
    Document,
    Paragraph.configure({ HTMLAttributes: { class: C.paragraph } }),
    Text,
    HardBreak,
    Heading.configure({
      levels: [...HEADING_LEVELS],
      HTMLAttributes: { class: C.heading },
    }),
    CodeBlock.configure({ HTMLAttributes: { class: C.codeBlock } }),
    BulletList.configure({ HTMLAttributes: { class: C.bulletList } }),
    OrderedList.configure({ HTMLAttributes: { class: C.orderedList } }),
    ListItem.configure({ HTMLAttributes: { class: C.listItem } }),
    ListKeymap,
    Bold.configure({ HTMLAttributes: { class: C.bold } }),
    Italic.configure({ HTMLAttributes: { class: C.italic } }),
    Code.configure({ HTMLAttributes: { class: C.code } }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      protocols: ['http', 'https', 'mailto'],
      isAllowedUri: (url) => safeHref(url) !== null,
      HTMLAttributes: editorLinkAttributes(newTabId),
    }),
    UndoRedo,
    Placeholder.configure({ placeholder: () => placeholder }),
  ],
  editorProps: { attributes: attributes.value },
  onUpdate: ({ editor: e }) => {
    model.value = normalizeRichText(e.getJSON())
  },
  onBlur: () => {
    emit('blur')
  },
})

// aria-describedby and aria-invalid follow the hint and error after the editor exists.
watch(attributes, (a) => editor.value?.setOptions({ editorProps: { attributes: a } }))

// A value set from outside (a rolled-back save, a reload) replaces the content without
// emitting an update back.
watch(
  () => serialize(normalizeRichText(model.value)),
  (next) => {
    const e = editor.value
    if (!e || serialize(normalizeRichText(e.getJSON())) === next) return
    e.commands.setContent(forEditor(JSON.parse(next) as RichDoc), { emitUpdate: false })
  },
)

onBeforeUnmount(() => editor.value?.destroy())

type Tool = {
  label: string
  /** Shown in the button. Short, because the toolbar is a quiet row of text. */
  text: string
  active: () => boolean
  run: () => void
}
const chain = () => editor.value?.chain().focus()
const tools: Tool[] = [
  {
    label: 'Bold',
    text: 'B',
    active: () => editor.value?.isActive('bold') ?? false,
    run: () => chain()?.toggleBold().run(),
  },
  {
    label: 'Italic',
    text: 'I',
    active: () => editor.value?.isActive('italic') ?? false,
    run: () => chain()?.toggleItalic().run(),
  },
  {
    label: 'Inline code',
    text: 'Code',
    active: () => editor.value?.isActive('code') ?? false,
    run: () => chain()?.toggleCode().run(),
  },
  {
    label: 'Heading',
    text: 'Heading',
    active: () => editor.value?.isActive('heading') ?? false,
    run: () => chain()?.toggleHeading({ level: HEADING_LEVELS[0] }).run(),
  },
  {
    label: 'Bulleted list',
    text: 'List',
    active: () => editor.value?.isActive('bulletList') ?? false,
    run: () => chain()?.toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    text: '1. List',
    active: () => editor.value?.isActive('orderedList') ?? false,
    run: () => chain()?.toggleOrderedList().run(),
  },
  {
    label: 'Code block',
    text: 'Block',
    active: () => editor.value?.isActive('codeBlock') ?? false,
    run: () => chain()?.toggleCodeBlock().run(),
  },
]

// One tab stop for the toolbar; arrow keys move inside it. `focused` owns the tab stop.
const toolbar = useTemplateRef<HTMLElement>('toolbar')
const focused = ref(0)
function onToolbarKey(event: KeyboardEvent) {
  const next = rovingIndex(focused.value, event.key, tools.length)
  if (next === null) return
  event.preventDefault()
  focused.value = next
  void nextTick(() => toolbar.value?.querySelectorAll('button')[next]?.focus())
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <span :id="labelId" class="text-secondary text-ink3">{{ label }}</span>
    <span :id="newTabId" hidden>(opens in a new tab)</span>
    <template v-if="state === 'loading'">
      <ValueState state="loading" :label="`Loading ${label}`" />
    </template>
    <template v-else-if="state === 'error'">
      <ValueState state="error" />
    </template>
    <template v-else-if="state === 'no-permission'">
      <div class="py-1.5">
        <RichTextView :doc="model" :label="label" />
      </div>
    </template>
    <template v-else>
      <div
        ref="toolbar"
        role="toolbar"
        :aria-label="`${label} formatting`"
        :aria-controls="id"
        class="flex flex-wrap items-center gap-0.5"
        @keydown="onToolbarKey"
      >
        <button
          v-for="(tool, i) in tools"
          :key="tool.label"
          type="button"
          :tabindex="i === focused ? 0 : -1"
          :aria-label="tool.label"
          :aria-pressed="tool.active() ? 'true' : 'false'"
          :disabled="!editor"
          :class="[
            'min-h-7 cursor-pointer rounded-control border-0 px-2 text-secondary disabled:cursor-not-allowed disabled:text-ink3',
            tool.active() ? 'bg-selected text-ink' : 'bg-transparent text-ink2 hover:bg-selected',
            tool.text === 'B' && 'font-medium',
            tool.text === 'I' && 'italic',
          ]"
          @focus="focused = i"
          @mousedown.prevent
          @click="tool.run"
        >
          {{ tool.text }}
        </button>
      </div>
      <div
        :id="id"
        :class="[
          'rounded-control border bg-bg focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent',
          error ? 'border-danger' : 'border-line3',
        ]"
      >
        <EditorContent :editor="editor" />
      </div>
    </template>
    <span v-if="shownHint && !noInput" :id="hintId" class="text-secondary text-ink3">{{
      shownHint
    }}</span>
    <span v-if="error && !noInput" :id="errorId" class="text-secondary text-danger">{{
      error
    }}</span>
  </div>
</template>
